import {DurableObject} from 'cloudflare:workers';
import {OAuthProvider, type OAuthHelpers} from '@cloudflare/workers-oauth-provider';
import {createHash, randomInt, timingSafeEqual} from 'node:crypto';
import {buildBriefing, type Briefing, dayPart, type DayPart, type EventReview, eventFactor, guestOutlookDay, type GuestOutlookDay, forecast, forecastAccuracy, planFrom, reviewDrop, SEASON_MAX, SEASON_MIN, type Forecast, renderBriefing, type DiscountHistory, type Month, type MonthPart, type ReviewStats, type Week, type WeekPart} from './briefing.ts';
import {dashboardHtml} from './dashboard.ts';
import {todoList} from './todo.ts';
import {menuChanges, menuOverview} from './menu.ts';
import {deliver, type DeliveryEnv} from './delivery.ts';
import {briefingDecision, localHour, reportDate, sendersFrom} from './schedule.ts';
import {addDays, businessDate, isDate, localTime, weekday} from './time.ts';
import {JOURNAL_LABEL, validateDailyReport, type DailyReport} from './daily-report.ts';
import {analyseNotes, type NotesAnalysis} from './notes.ts';
import {fetchDayFiles, reportFromFiles} from './onedrive.ts';
import {fetchCosts, iuctoKey, type CostRow, type IuctoEnv} from './iucto.ts';
import {CODE_MS, DAY_MS, HOUR_MS, nextCode, RESEND_MS, seconds, WRONG_PER_HOUR, type Wait} from './login.ts';
import {DEFAULT_BOTTLE_LOSS_CENTS, InputError, validateBatch, withoutGuest, validateConfig, validateHistory, type Bill, type BottleCheck, type CashClosing, type Menu, type Reservation, type ReviewSummary, type TenantConfig, type WebTraffic} from './validate.ts';
import {webSite, webTables, webToken, webTokenName, type WebEnv} from './web-client.ts';
import {dashboardWeb} from './web-views.ts';
import {WEATHER_AGENT, WEATHER_URL, weatherDays, type WeatherDay} from './weather.ts';
import {MCP_PATH, oauthOptions, type Venues} from './oauth.ts';

export type Env = DeliveryEnv & WebEnv & IuctoEnv & {
  TENANTS: DurableObjectNamespace<TenantObject>; REGISTRY: DurableObjectNamespace<Registry>; ADMIN_SECRET: string; DATA_JURISDICTION?: string;
  /** Grants and tokens of the MCP server's OAuth (docs/web-v1.md). Optional: without it /mcp is not available. */
  OAUTH_KV?: KVNamespace;
  /** Set by the OAuth provider for the authorization page. */
  OAUTH_PROVIDER?: OAuthHelpers;
  /** R2 bucket in the EU (production): untouched copies of everything received and a daily export. Optional: without it nothing is archived. */
  ARCHIVE?: R2Bucket;
  /** OKO1's own Claude API key for "Report dne". Optional: without it the raw text goes into the briefing. */
  ANTHROPIC_API_KEY?: string;
};
type Result = {status: number; body: unknown};
export type VenueSetup = {name: string; timeZone: string; businessDayCutoffHour: number; web: {url: string} | null; today: string; reportDay: string};

// With DATA_JURISDICTION=eu (production) the venue data is created and stored only in the EU.
// The local test runtime has no jurisdictions, so tests leave it unset.
const scoped = <T extends Rpc.DurableObjectBranded | undefined>(env: Env, namespace: DurableObjectNamespace<T>) =>
  env.DATA_JURISDICTION === 'eu' ? namespace.jurisdiction('eu') : namespace;
const tenantStub = (env: Env, tenant: string) => { const ns = scoped(env, env.TENANTS); return ns.get(ns.idFromName(tenant)); };
/**
 * Where a login code is asked for: the venue itself, or for an unknown venue one shared stand-in (its name cannot be
 * a venue) that answers with the same countdown and limits, so no storage is created per unknown name.
 */
export const loginStub = (env: Env, tenant: string, known: boolean) => tenantStub(env, known ? tenant : '~nezname-provozovny');
const registry = (env: Env) => { const ns = scoped(env, env.REGISTRY); return ns.get(ns.idFromName('registry')); };
const ok = (body: unknown): Result => ({status: 200, body});
const failure = (code: string, status: number): Result => ({status, body: {error: code}});
const json = (result: Result) => {
  const retryAfter = (result.body as {retryAfter?: unknown} | null)?.retryAfter;
  return Response.json(result.body, {status: result.status, headers: {'cache-control': 'no-store', ...(result.status === 429 && typeof retryAfter === 'number' ? {'retry-after': String(retryAfter)} : {})}});
};
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
/** A to-do item is known by its text: the same deviation on the same day keeps its "Vyřízeno". */
const todoKey = (text: string) => sha256(text).slice(0, 24);
const same = (a: string, b: string) => {
  const left = new TextEncoder().encode(a), right = new TextEncoder().encode(b);
  return left.length === right.length && timingSafeEqual(left, right);
};

const randomHex = (bytes: number) => [...crypto.getRandomValues(new Uint8Array(bytes))].map(byte => byte.toString(16).padStart(2, '0')).join('');
const PREPARE_BUDGET_MS = 60000;
const SESSION_MS = 30 * 86400000;
/** Waits for `work` at most `ms`; errors and overruns are logged, never thrown. The work may still finish later. */
async function withinBudget(work: Promise<unknown>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    work.catch(error => console.error('prepare failed', String(error))),
    new Promise(resolve => { timer = setTimeout(() => { console.error('prepare over budget'); resolve(null); }, ms); }),
  ]);
  clearTimeout(timer);
}

/** A moment as the venue reads it, e.g. "12. 10. 18:01". */
function stamp(at: Date, timeZone: string): string {
  const local = localTime(at, timeZone);
  return `${Number(local.date.slice(8))}. ${Number(local.date.slice(5, 7))}. ${local.hour}:${String(local.minute).padStart(2, '0')}`;
}

/** One SQLite Durable Object per venue (tenant). Nothing here is shared between venues. */
export class TenantObject extends DurableObject<Env> {
  private sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    ctx.storage.transactionSync(() => this.sql.exec(`
      CREATE TABLE IF NOT EXISTS config(id INTEGER PRIMARY KEY CHECK(id=1), json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS installations(installation_id TEXT PRIMARY KEY, token_hash TEXT NOT NULL, paired_at TEXT NOT NULL, last_seen_at TEXT);
      CREATE TABLE IF NOT EXISTS batches(batch_id TEXT PRIMARY KEY, installation_id TEXT NOT NULL, payload_hash TEXT NOT NULL, result TEXT NOT NULL, received_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS records(type TEXT NOT NULL, id TEXT NOT NULL, version INTEGER NOT NULL, business_date TEXT NOT NULL,
        register_id TEXT NOT NULL, json TEXT NOT NULL, installation_id TEXT NOT NULL, received_at TEXT NOT NULL, PRIMARY KEY(type, id));
      CREATE INDEX IF NOT EXISTS records_day ON records(business_date, type);
      CREATE TABLE IF NOT EXISTS history(business_date TEXT PRIMARY KEY, revenue_cents INTEGER NOT NULL, bills INTEGER, guests INTEGER, imported_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS briefings(business_date TEXT PRIMARY KEY, status TEXT NOT NULL CHECK(status IN ('stored','delivered','failed')),
        incomplete INTEGER NOT NULL, text TEXT NOT NULL, json TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS daily_reports(business_date TEXT PRIMARY KEY, source TEXT NOT NULL, json TEXT NOT NULL, received_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS report_lines(business_date TEXT NOT NULL, kind TEXT NOT NULL, key TEXT NOT NULL, label TEXT NOT NULL,
        count INTEGER, amount_cents INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS report_lines_day ON report_lines(business_date, kind);
      CREATE INDEX IF NOT EXISTS report_lines_kind ON report_lines(kind, key, business_date);
      CREATE TABLE IF NOT EXISTS report_notes(business_date TEXT PRIMARY KEY, status TEXT NOT NULL CHECK(status IN ('done','failed')),
        json TEXT, error TEXT, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS report_fetches(business_date TEXT NOT NULL, at TEXT NOT NULL, found INTEGER NOT NULL, warnings TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS login_codes(code_hash TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS login_failures(at INTEGER NOT NULL);
      -- Every request for a login code, for an allowed number or not (SHA-256 of venue and number): the same clock for all.
      CREATE TABLE IF NOT EXISTS login_requests(phone_hash TEXT NOT NULL, at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions(token_hash TEXT PRIMARY KEY, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS todo_done(business_date TEXT NOT NULL, item_key TEXT NOT NULL, done_at TEXT NOT NULL, PRIMARY KEY(business_date, item_key));
      -- Posted costs per month and synthetic account from iÚčto (sums only), and the last read of each month.
      CREATE TABLE IF NOT EXISTS costs(month TEXT NOT NULL, account TEXT NOT NULL, name TEXT NOT NULL, amount_cents INTEGER NOT NULL, PRIMARY KEY(month, account));
      CREATE TABLE IF NOT EXISTS cost_fetches(month TEXT PRIMARY KEY, through TEXT NOT NULL, at TEXT NOT NULL, error TEXT);
      -- The forecast each morning's message gave for the day starting and the 6 after it (horizon = days ahead); the first one counts.
      CREATE TABLE IF NOT EXISTS forecast_log(for_date TEXT NOT NULL, horizon INTEGER NOT NULL, cents INTEGER NOT NULL, made_on TEXT NOT NULL, PRIMARY KEY(for_date, horizon));
      -- Weather forecast for the venue's location per local day (MET Norway), refreshed at most every 3 hours.
      CREATE TABLE IF NOT EXISTS weather(date TEXT PRIMARY KEY, json TEXT NOT NULL, fetched_at TEXT NOT NULL);
      -- Every change of the menu (src/menu.ts): the price of an item on any day, for prices, food cost and experiments. Base price in haléře.
      CREATE TABLE IF NOT EXISTS menu_changes(at TEXT NOT NULL, business_date TEXT NOT NULL, menu_id TEXT NOT NULL, item_id TEXT NOT NULL, name TEXT NOT NULL,
        kind TEXT NOT NULL CHECK(kind IN ('added','removed','price')), old_cents INTEGER, new_cents INTEGER, old_text TEXT, new_text TEXT);
      CREATE INDEX IF NOT EXISTS menu_changes_item ON menu_changes(item_id, at);
    `));
    // Wrong codes for unknown venues are counted per venue name in the shared stand-in (see `loginStub`).
    if (!this.sql.exec<{name: string}>('PRAGMA table_info(login_failures)').toArray().some(column => column.name === 'scope')) {
      this.sql.exec("ALTER TABLE login_failures ADD COLUMN scope TEXT NOT NULL DEFAULT ''");
    }
  }

  private config(): TenantConfig | null {
    const row = this.sql.exec<{json: string}>('SELECT json FROM config WHERE id=1').toArray()[0];
    // Configs saved before the bottle check have no `bottleCheck` key.
    return row ? {bottleCheck: null, reportsLink: null, dashboardPhones: null, web: null, ...JSON.parse(row.json)} as TenantConfig : null;
  }

  async handle(tenant: string, route: string, method: string, body: unknown, token: string | null, query: Record<string, string>): Promise<Result> {
    try {
      if (route === 'v1/ingest' && method === 'POST') return this.ingest(tenant, body, token);
      if (route === 'admin/report' && method === 'PUT') return ok(this.saveReport(validateDailyReport(body)));
      if (route === 'admin/report' && method === 'GET') return isDate(query.date) ? ok({report: this.report(query.date), notes: this.notes(query.date)}) : failure('INVALID_REQUEST', 400);
      if (route === 'admin/fetch' && method === 'POST') {
        const {date, keep} = (body ?? {}) as {date?: unknown; keep?: unknown};
        if (!isDate(date)) return failure('INVALID_REQUEST', 400);
        // Loading history must not replace a day that already has the managers' daily report.
        if (keep === true && this.hasReport(date)) return ok({found: true, kept: true, warnings: []});
        return ok(await this.fetchReport(tenant, date));
      }
      if (route === 'admin/config' && method === 'PUT') return this.saveConfig(tenant, body);
      if (route === 'admin/config' && method === 'GET') return ok(this.config());
      if (route === 'admin/pair' && method === 'POST') return this.pair(body);
      if (route === 'admin/logout' && method === 'POST') { const ended = this.sql.exec('DELETE FROM sessions').rowsWritten; return ok({ended}); }
      if (route === 'admin/history' && method === 'POST') return this.importHistory(body);
      if (route === 'admin/briefing' && method === 'GET') return this.preview(query.date);
      if (route === 'admin/ingest' && method === 'GET') return ok(this.ingestStatus());
      if (route === 'admin/briefings' && method === 'GET') return ok(this.sql.exec('SELECT business_date AS businessDate, status, incomplete, text, created_at AS createdAt FROM briefings ORDER BY business_date DESC LIMIT 60').toArray());
      if (route === 'admin/tick' && method === 'POST') {
        const at = (body as {at?: unknown})?.at;
        if (typeof at !== 'string' || Number.isNaN(Date.parse(at))) return failure('INVALID_REQUEST', 400);
        return ok(await this.tick(new Date(at), tenant));
      }
      return failure('NOT_FOUND', 404);
    } catch (error) {
      if (error instanceof InputError) return failure(error.message, 400);
      if (error instanceof Error && error.message === 'CONFLICT') return failure('CONFLICT', 409);
      throw error;
    }
  }

  /** Phones allowed into the dashboard: `dashboardPhones`, or only the first briefing recipient (the owner). */
  private dashboardPhones(config: TenantConfig): string[] {
    return config.dashboardPhones ?? config.recipients.slice(0, 1);
  }

  /** The number as the dashboard keeps it (+420 for nine digits) and its key for the request clock of this venue. */
  private loginKey(phone: unknown, scope: string) {
    const number = typeof phone === 'string' ? phone.replace(/[\s().-]/g, '').replace(/^00/, '+') : '';
    const normalised = /^\d{9}$/.test(number) ? '+420' + number : number;
    return {normalised, key: sha256(`${scope}|${normalised}`)};
  }

  private requestTimes(key: string): number[] {
    return this.sql.exec<{at: number}>('SELECT at FROM login_requests WHERE phone_hash=? ORDER BY at', key).toArray().map(row => row.at);
  }

  /** Countdown of the last code for this number: how long it still lives and when the next one may go. Same for every number. */
  loginTimes(phone: unknown, scope = '', now = Date.now()) {
    const times = this.requestTimes(this.loginKey(phone, scope).key).filter(at => at >= now - DAY_MS);
    const last = times.at(-1);
    return {expiresIn: last === undefined ? 0 : seconds(last + CODE_MS - now), retryAfter: seconds((nextCode(times, now)?.until ?? now) - now)};
  }

  /**
   * Dashboard login, step 1: the visitor types the phone number. Only a number allowed into the dashboard gets a
   * six-digit code by SMS. Every number, allowed or not, runs on the same clock: the next code at the earliest 60 s
   * after the last one, at most 5 an hour and 10 a day; the answer (countdown, 429 with seconds) is the same, so it
   * never shows whether a number may log in. Codes actually sent are limited for the whole venue as well (5 an hour,
   * 10 a day, 60 s apart), each counted before it is sent, so parallel requests cannot pass the limit. A new code
   * replaces the venue's earlier codes that are still valid. `scope` is the venue name in the shared stand-in for
   * unknown venues. `now` only for tests (the routes never pass it).
   */
  async sendLoginCode(phone: unknown, scope = '', now = Date.now()): Promise<Result> {
    const config = this.config();
    const {normalised, key} = this.loginKey(phone, scope);
    const target = config ? this.dashboardPhones(config).find(entry => same(entry, normalised)) : undefined;
    const code = String(randomInt(0, 1000000)).padStart(6, '0');
    const wait = this.ctx.storage.transactionSync(() => {
      this.sql.exec('DELETE FROM login_requests WHERE at < ?', now - DAY_MS);
      this.sql.exec('DELETE FROM login_codes WHERE created_at < ?', now - DAY_MS);
      const times = this.requestTimes(key);
      const venue = target ? this.sql.exec<{created_at: number}>('SELECT created_at FROM login_codes ORDER BY created_at').toArray().map(row => row.created_at) : [];
      const waits = [nextCode(times, now), nextCode(venue, now)].filter((entry): entry is Wait => entry !== null);
      if (waits.length) return {error: waits.some(entry => entry.error === 'TOO_MANY') ? 'TOO_MANY' : 'TOO_SOON', until: Math.max(...waits.map(entry => entry.until)), last: times.at(-1)};
      this.sql.exec('INSERT INTO login_requests VALUES(?,?)', key, now);
      if (target) {
        this.sql.exec('UPDATE login_codes SET expires_at=0 WHERE expires_at > ?', now);
        this.sql.exec('INSERT INTO login_codes(code_hash, created_at, expires_at) VALUES(?,?,?)', sha256(code), now, now + CODE_MS);
      }
      return null;
    });
    if (wait) {
      return {status: 429, body: {error: wait.error, retryAfter: seconds(wait.until - now), expiresIn: wait.last === undefined ? 0 : seconds(wait.last + CODE_MS - now)}};
    }
    if (target) {
      const status = await deliver(this.env, [target], `OKO1: kód pro přihlášení ${code}. Platí 10 minut. Nikomu ho nesdělujte.`, {smsOnly: true});
      // A code that did not go out stays counted but can never be used.
      if (status !== 'delivered') { this.sql.exec('UPDATE login_codes SET expires_at=0 WHERE code_hash=?', sha256(code)); return failure('NOT_SENT', 503); }
    }
    return ok({sent: true, expiresAt: new Date(now + CODE_MS).toISOString(), expiresIn: CODE_MS / 1000, retryAfter: RESEND_MS / 1000});
  }

  /**
   * Step 2: a valid code opens a 30-day session; only the token's hash is stored. Each code takes at most 5 tries,
   * and after 10 wrong codes in an hour the venue's login is closed until the hour passes (429 says how long).
   */
  verifyLoginCode(code: unknown, scope = '', now = Date.now()): Result {
    return this.ctx.storage.transactionSync(() => {
      this.sql.exec('DELETE FROM login_failures WHERE at < ?', now - HOUR_MS);
      const wrong = this.sql.exec<{at: number}>('SELECT at FROM login_failures WHERE scope=? ORDER BY at', scope).toArray().map(row => row.at);
      if (wrong.length >= WRONG_PER_HOUR) return {status: 429, body: {error: 'TOO_MANY', retryAfter: seconds(wrong[wrong.length - WRONG_PER_HOUR] + HOUR_MS - now)}};
      const live = this.sql.exec<{code_hash: string}>('SELECT code_hash FROM login_codes WHERE expires_at > ? AND attempts < 5', now).toArray();
      const match = typeof code === 'string' && /^\d{6}$/.test(code) ? live.find(row => same(row.code_hash, sha256(code))) : undefined;
      if (!match) {
        this.sql.exec('UPDATE login_codes SET attempts = attempts + 1 WHERE expires_at > ? AND attempts < 5', now);
        this.sql.exec('INSERT INTO login_failures(at, scope) VALUES(?,?)', now, scope);
        return failure('INVALID_CODE', 401);
      }
      // A used code stays (expired) until the day is over, so it still counts toward the limits.
      this.sql.exec('UPDATE login_codes SET expires_at=0 WHERE code_hash=?', match.code_hash);
      const token = randomHex(32);
      this.sql.exec('DELETE FROM sessions WHERE expires_at < ?', now);
      this.sql.exec('INSERT INTO sessions VALUES(?,?,?)', sha256(token), now, now + SESSION_MS);
      return ok({token});
    });
  }

  validSession(token: string | null): boolean {
    if (!token) return false;
    return this.sql.exec('SELECT 1 FROM sessions WHERE token_hash=? AND expires_at > ?', sha256(token), Date.now()).toArray().length > 0;
  }

  logout(token: string | null) {
    if (token) this.sql.exec('DELETE FROM sessions WHERE token_hash=?', sha256(token));
  }

  /** Everything the dashboard shows for one business day (default: the day of this morning's briefing). */
  dashboardData(date: string | undefined): Result {
    const config = this.config();
    if (!config) return failure('NOT_CONFIGURED', 409);
    const day = isDate(date) ? date : reportDate(new Date(), config.timeZone, config.businessDayCutoffHour);
    const {briefing, text} = this.briefingFor(config, day, !this.ready(config, day));
    const report = this.report(day);
    // Each day's revenue is read once for the 35 shown days and the 4 weeks of plan before them.
    const cache = new Map<string, number | null>();
    const revenue = (entry: string) => { if (!cache.has(entry)) cache.set(entry, this.dayRevenue(entry)); return cache.get(entry)!; };
    const series = Array.from({length: 35}, (_, i) => addDays(day, i - 34)).map(entry => ({
      date: entry, revenueCents: revenue(entry),
      // The plan the morning message gave when there is one, else the weekday average.
      planCents: this.loggedPlan(entry) ?? planFrom([7, 14, 21, 28].map(back => revenue(addDays(entry, -back))).filter((value): value is number => value !== null).map(revenueCents => ({revenueCents})))?.revenueCents ?? null,
    }));
    const balances = Object.fromEntries((report?.lines ?? []).filter(line => line.kind === 'balance').map(line => [line.key, line.amountCents]));
    const stored = this.sql.exec<{text: string}>('SELECT text FROM briefings WHERE business_date=?', day).toArray()[0];
    const done = new Set(this.sql.exec<{item_key: string}>('SELECT item_key FROM todo_done WHERE business_date=?', day).toArray().map(row => row.item_key));
    const todo = todoList(briefing, report?.warnings ?? [])
      // "… a další 3" is not an item of its own: no switch.
      .map(item => item.text.startsWith('… a další') ? {...item, key: null, done: false} : {...item, key: todoKey(item.text), done: done.has(todoKey(item.text))});
    return ok({name: config.name, businessDate: day, briefing, report, balances, days: series, todo, briefingText: stored?.text ?? text,
      week: briefing.week ?? this.week(day), month: briefing.month ?? this.month(config, day), sources: this.sources(config), menu: this.menuCard(config, day)});
  }

  /** "Vyřízeno" on the dashboard's to-do list: kept per business day and item, undone by the same switch. */
  markTodo(date: unknown, key: unknown, done: unknown): Result {
    if (!isDate(date) || typeof key !== 'string' || !/^[a-f0-9]{24}$/.test(key) || typeof done !== 'boolean') return failure('INVALID_INPUT', 400);
    if (done) this.sql.exec('INSERT OR IGNORE INTO todo_done VALUES(?,?,?)', date, key, new Date().toISOString());
    else this.sql.exec('DELETE FROM todo_done WHERE business_date=? AND item_key=?', date, key);
    return ok({done});
  }

  /** What the MCP tools and the dashboard need to know about the venue (no recipients or phones). Null = not set up. */
  setup(): VenueSetup | null {
    const config = this.config();
    if (!config) return null;
    const now = new Date();
    return {name: config.name, timeZone: config.timeZone, businessDayCutoffHour: config.businessDayCutoffHour, web: config.web,
      today: businessDate(now, config.timeZone, config.businessDayCutoffHour), reportDay: reportDate(now, config.timeZone, config.businessDayCutoffHour)};
  }

  /** MCP: revenue and everything the briefing knows about one business day (POS bills, else the managers' report). */
  posDay(date: string) {
    const config = this.config();
    if (!config) return null;
    const ready = this.ready(config, date);
    return {businessDate: date, ready, revenueCents: this.dayRevenue(date), briefing: this.briefingFor(config, date, !ready).briefing};
  }

  /** MCP: revenue per day for a range (POS, else the managers' report, else the imported history). */
  posRange(from: string, to: string) {
    const days: {date: string; revenueCents: number | null}[] = [];
    for (let date = from; date <= to && days.length < 400; date = addDays(date, 1)) days.push({date, revenueCents: this.dayRevenue(date)});
    const known = days.filter(day => day.revenueCents !== null);
    return {from, to, days, totalCents: known.reduce((sum, day) => sum + day.revenueCents!, 0), daysWithData: known.length};
  }

  /** MCP: the morning briefing as stored (sent or kept), or a preview when none is stored for the day. */
  posBriefing(date: string) {
    const config = this.config();
    if (!config) return null;
    const stored = this.sql.exec<{status: string; incomplete: number; text: string; created_at: string}>('SELECT status, incomplete, text, created_at FROM briefings WHERE business_date=?', date).toArray()[0];
    if (stored) return {businessDate: date, stored: true, status: stored.status, incomplete: stored.incomplete === 1, text: stored.text, createdAt: stored.created_at};
    const ready = this.ready(config, date);
    return {businessDate: date, stored: false, status: null, incomplete: !ready, text: this.briefingFor(config, date, !ready).text, createdAt: null};
  }

  /** MCP: the managers' daily report of a day and the analysis of "Report dne". */
  posReport(date: string) {
    return {businessDate: date, report: this.report(date), notes: this.notes(date)};
  }

  /** MCP: the morning bottle checks of a day and the losses as the briefing shows them. */
  posBottles(date: string) {
    const config = this.config();
    if (!config) return null;
    const {briefing} = this.briefingFor(config, date, false);
    return {businessDate: date, checks: this.day<BottleCheck>('bottle_check', date), summary: briefing.bottles, missing: briefing.bottleCheckMissing,
      minLossCents: config.bottleCheck?.minLossCents ?? DEFAULT_BOTTLE_LOSS_CENTS};
  }

  /** MCP: the POS bills of a day (closed and cancelled), oldest first. */
  posBills(date: string) {
    const bills = this.day<Bill>('bill', date).sort((a, b) => a.closedAt.localeCompare(b.closedAt));
    return {businessDate: date, count: bills.length, bills: bills.slice(0, 2000), truncated: bills.length > 2000};
  }

  private saveConfig(tenant: string, body: unknown): Result {
    const config = validateConfig(body);
    const old = this.config();
    // Whoever is no longer allowed in loses the dashboard at once.
    if (old && JSON.stringify(this.dashboardPhones(old)) !== JSON.stringify(this.dashboardPhones(config))) this.sql.exec('DELETE FROM sessions');
    this.sql.exec('INSERT INTO config(id, json) VALUES(1, ?) ON CONFLICT(id) DO UPDATE SET json=excluded.json', JSON.stringify(config));
    this.ctx.waitUntil(registry(this.env).add(tenant));
    return ok(config);
  }

  /** The POS creates the token and keeps it; only its SHA-256 is stored here. */
  private pair(body: unknown): Result {
    const value = body as {installationId?: unknown; token?: unknown};
    if (!value || typeof value.installationId !== 'string' || !/^[\w-]{8,100}$/.test(value.installationId)
      || typeof value.token !== 'string' || !/^[a-f0-9]{64}$/.test(value.token) || Object.keys(value).length !== 2) return failure('INVALID_REQUEST', 400);
    const installationId = value.installationId, hash = sha256(value.token);
    return this.ctx.storage.transactionSync(() => {
      const old = this.sql.exec<{token_hash: string}>('SELECT token_hash FROM installations WHERE installation_id=?', installationId).toArray()[0];
      if (old && old.token_hash !== hash) return failure('PAIRING_CONFLICT', 409);
      if (!old) this.sql.exec('INSERT INTO installations(installation_id, token_hash, paired_at) VALUES(?,?,?)', installationId, hash, new Date().toISOString());
      return ok({installationId});
    });
  }

  /** Admin: who sends data and when it last arrived (installations, last batches, records per type). No record content. */
  private ingestStatus() {
    return {
      installations: this.sql.exec('SELECT installation_id AS installationId, paired_at AS pairedAt, last_seen_at AS lastSeenAt FROM installations ORDER BY installation_id').toArray(),
      batches: this.sql.exec('SELECT installation_id AS installationId, received_at AS receivedAt, result FROM batches ORDER BY received_at DESC LIMIT 10').toArray()
        .map(row => ({...row, result: JSON.parse(row.result as string)})),
      records: this.sql.exec('SELECT type, count(*) AS count, max(received_at) AS lastReceivedAt FROM records GROUP BY type ORDER BY type').toArray(),
    };
  }

  private ingest(tenant: string, body: unknown, token: string | null): Result {
    const installationId = (body as {installationId?: unknown})?.installationId;
    const row = typeof installationId === 'string'
      ? this.sql.exec<{token_hash: string}>('SELECT token_hash FROM installations WHERE installation_id=?', installationId).toArray()[0] : undefined;
    if (!row || !token || !same(sha256(token), row.token_hash)) return failure('UNAUTHORIZED', 401);
    const batch = validateBatch(body);
    const payloadHash = sha256(JSON.stringify(batch));
    return this.ctx.storage.transactionSync(() => {
      const replay = this.sql.exec<{payload_hash: string; result: string}>('SELECT payload_hash, result FROM batches WHERE batch_id=?', batch.batchId).toArray()[0];
      if (replay) return replay.payload_hash === payloadHash ? ok(JSON.parse(replay.result)) : failure('BATCH_CONFLICT', 409);
      const now = new Date().toISOString();
      let accepted = 0, stale = 0;
      // A booking first sent with counts only takes its guest details (12 Oct 2026) and the time it was made at the same version (resent once).
      for (const record of batch.records) {
        const before = record.type === 'menu' ? this.menu(record.id) : null;
        const changed = this.sql.exec(`INSERT INTO records(type, id, version, business_date, register_id, json, installation_id, received_at) VALUES(?,?,?,?,?,?,?,?)
          ON CONFLICT(type, id) DO UPDATE SET version=excluded.version, business_date=excluded.business_date, register_id=excluded.register_id,
          json=excluded.json, installation_id=excluded.installation_id, received_at=excluded.received_at WHERE excluded.version > records.version
          OR (excluded.type = 'reservation' AND excluded.version = records.version AND instr(records.json, '"guest":') = 0 AND instr(excluded.json, '"guest":') > 0)
          OR (excluded.type = 'reservation' AND excluded.version = records.version AND instr(records.json, '"createdAt":') = 0 AND instr(excluded.json, '"createdAt":') > 0
            AND (instr(excluded.json, '"guest":') > 0 OR instr(records.json, '"guest":') = 0))`,
        record.type, record.id, record.version, record.businessDate, 'registerId' in record ? record.registerId : '', JSON.stringify(record), batch.installationId, now).rowsWritten;
        if (changed) accepted++; else stale++;
        // The first menu is the starting point; from then on every new item, removed item and new price is kept.
        if (changed && before && record.type === 'menu') {
          for (const change of menuChanges(before, record)) {
            this.sql.exec('INSERT INTO menu_changes VALUES(?,?,?,?,?,?,?,?,?,?)', now, record.businessDate, record.id, change.itemId, change.name, change.kind,
              change.oldCents, change.newCents, change.oldText, change.newText);
          }
        }
      }
      const result = {batchId: batch.batchId, accepted, stale};
      this.sql.exec('INSERT INTO batches VALUES(?,?,?,?,?)', batch.batchId, batch.installationId, payloadHash, JSON.stringify(result), now);
      this.sql.exec('UPDATE installations SET last_seen_at=? WHERE installation_id=?', now, batch.installationId);
      // Guest details stay only in this database: the archive keeps the batch without them.
      this.archive(`t/${tenant}/ingest/${now.slice(0, 10)}/${batch.batchId}.json`, JSON.stringify({...batch, records: batch.records.map(withoutGuest)}));
      return ok(result);
    });
  }

  private importHistory(body: unknown): Result {
    const rows = validateHistory(body), now = new Date().toISOString();
    this.ctx.storage.transactionSync(() => {
      for (const row of rows) this.sql.exec(`INSERT INTO history VALUES(?,?,?,?,?) ON CONFLICT(business_date) DO UPDATE SET
        revenue_cents=excluded.revenue_cents, bills=excluded.bills, guests=excluded.guests, imported_at=excluded.imported_at`,
      row.businessDate, row.revenueCents, row.bills, row.guests, now);
    });
    return ok({imported: rows.length});
  }

  /** Untouched copy into R2 (EU). Never blocks or fails the request; a missing bucket means no archive. */
  private archive(key: string, body: string | Uint8Array) {
    const bucket = this.env.ARCHIVE;
    if (bucket) this.ctx.waitUntil(bucket.put(key, body).then(() => undefined, error => console.error('archive failed', key, String(error))));
  }

  private report(date: string): DailyReport | null {
    const row = this.sql.exec<{json: string}>('SELECT json FROM daily_reports WHERE business_date=?', date).toArray()[0];
    return row ? JSON.parse(row.json) as DailyReport : null;
  }

  private notes(date: string): NotesAnalysis | null {
    const row = this.sql.exec<{json: string | null}>("SELECT json FROM report_notes WHERE business_date=? AND status='done'", date).toArray()[0];
    return row?.json ? JSON.parse(row.json) as NotesAnalysis : null;
  }

  /** Stores the day's report and its lines; a changed "Report dne" text is analysed again. */
  private saveReport(report: DailyReport) {
    const now = new Date().toISOString();
    this.ctx.storage.transactionSync(() => {
      const old = this.report(report.businessDate);
      this.sql.exec(`INSERT INTO daily_reports VALUES(?,?,?,?) ON CONFLICT(business_date) DO UPDATE SET source=excluded.source, json=excluded.json, received_at=excluded.received_at`,
        report.businessDate, report.source, JSON.stringify(report), now);
      this.sql.exec('DELETE FROM report_lines WHERE business_date=?', report.businessDate);
      for (const entry of report.lines) this.sql.exec('INSERT INTO report_lines VALUES(?,?,?,?,?,?)', report.businessDate, entry.kind, entry.key, entry.label, entry.count, entry.amountCents);
      if (old?.notes !== report.notes) this.sql.exec('DELETE FROM report_notes WHERE business_date=?', report.businessDate);
    });
    return {businessDate: report.businessDate, lines: report.lines.length, notes: !!report.notes, warnings: report.warnings};
  }

  /** Reads the day's Excel files from the shared OneDrive folder, archives them and stores the report. */
  private async fetchReport(tenant: string, date: string) {
    const link = this.config()?.reportsLink;
    if (!link) return {found: false, warnings: ['OneDrive: odkaz na složku není nastavený.']};
    let found = false, warnings: string[];
    try {
      const fetched = await fetchDayFiles(link, date);
      for (const file of fetched.files) this.archive(`t/${tenant}/onedrive/${date}/${file.name}`, file.bytes);
      const report = await reportFromFiles(fetched.files, date, fetched.warnings);
      if (report) { this.saveReport(report); found = true; }
      warnings = report?.warnings ?? fetched.warnings;
    } catch (error) {
      warnings = [`OneDrive: chyba při čtení (${String(error).slice(0, 100)}).`];
    }
    this.sql.exec('INSERT INTO report_fetches VALUES(?,?,?,?)', date, new Date().toISOString(), found ? 1 : 0, JSON.stringify(warnings));
    return {found, warnings};
  }

  /** "Report dne" through Claude, once per text. A failure is tried again at the next send hour; meanwhile the briefing shows the raw text. */
  private async analyse(config: TenantConfig, date: string) {
    const notes = this.report(date)?.notes, key = this.env.ANTHROPIC_API_KEY;
    if (!notes || !key || this.sql.exec("SELECT 1 FROM report_notes WHERE business_date=? AND status='done'", date).toArray().length) return;
    const now = new Date().toISOString();
    try {
      const analysis = await analyseNotes(key, notes, [config.name, ...Object.values(config.sections)]);
      this.sql.exec("INSERT OR REPLACE INTO report_notes VALUES(?, 'done', ?, NULL, ?)", date, JSON.stringify(analysis), now);
    } catch (error) {
      this.sql.exec("INSERT OR REPLACE INTO report_notes VALUES(?, 'failed', NULL, ?, ?)", date, String(error).slice(0, 200), now);
    }
  }

  /** The latest menu from one sender (`id`), or the latest of any sender. */
  private menu(id?: string): Menu | null {
    const row = this.sql.exec<{json: string}>(`SELECT json FROM records WHERE type='menu'${id ? ' AND id=?' : ''} ORDER BY received_at DESC LIMIT 1`, ...(id ? [id] : [])).toArray()[0];
    return row ? JSON.parse(row.json) as Menu : null;
  }

  /** Changes of the menu between two days (inclusive), newest first, and how many there are in all. */
  private menuChangesBetween(from: string, to: string, limit: number) {
    const total = this.sql.exec<{count: number}>('SELECT count(*) AS count FROM menu_changes WHERE business_date BETWEEN ? AND ?', from, to).toArray()[0].count;
    const rows = this.sql.exec<{business_date: string; item_id: string; name: string; kind: string; old_cents: number | null; new_cents: number | null; old_text: string | null; new_text: string | null}>(
      'SELECT * FROM menu_changes WHERE business_date BETWEEN ? AND ? ORDER BY at DESC, rowid DESC LIMIT ?', from, to, limit).toArray()
      .map(row => ({date: row.business_date, itemId: row.item_id, name: row.name, kind: row.kind, oldCents: row.old_cents, newCents: row.new_cents, oldText: row.old_text, newText: row.new_text}));
    return {total, rows};
  }

  /** Dashboard: the menu by part and category, when it last arrived, and its changes over the 30 days up to the shown day and the day starting after it. */
  private menuCard(config: TenantConfig, day: string) {
    const menu = this.menu();
    if (!menu) return null;
    const received = this.sql.exec<{at: string}>("SELECT max(received_at) AS at FROM records WHERE type='menu'").toArray()[0].at;
    const changes = this.menuChangesBetween(addDays(day, -29), addDays(day, 1), 30);
    return {...menuOverview(menu), received: stamp(new Date(received), config.timeZone), changes: changes.rows, changesTotal: changes.total};
  }

  /** MCP: the whole current menu with every item and price, and its changes over the last year. */
  posMenu() {
    const config = this.config(), menu = this.menu();
    if (!config || !menu) return null;
    // Changes are dated by the Prague calendar day the menu was sent (docs/ingest-v1.md), not by the business day.
    const today = localTime(new Date(), config.timeZone).date;
    const changes = this.menuChangesBetween(addDays(today, -365), today, 2000);
    return {menu, changes: changes.rows, changesTotal: changes.total};
  }

  private day<T>(type: string, date: string): T[] {
    return this.sql.exec<{json: string}>('SELECT json FROM records WHERE type=? AND business_date=? ORDER BY id', type, date).toArray().map(row => JSON.parse(row.json) as T);
  }

  /**
   * Reads the posted costs of the reported day's month (up to that day) and of the month before (late invoices still
   * land there) from iÚčto, once a day. Only sums per account are stored; a failure keeps the last good sums.
   */
  private async fetchCosts(tenant: string, date: string, today: string) {
    const key = iuctoKey(this.env, tenant);
    if (!key) return;
    const month = date.slice(0, 7), previous = addDays(month + '-01', -1);
    for (const [from, to] of [[month + '-01', date], [previous.slice(0, 7) + '-01', previous]]) {
      const last = this.sql.exec<{at: string; through: string}>('SELECT at, through FROM cost_fetches WHERE month=?', from.slice(0, 7)).toArray()[0];
      if (last && last.at.slice(0, 10) === today && last.through === to) continue;
      const result = await fetchCosts(key, from, to, 15000);
      this.ctx.storage.transactionSync(() => {
        if (result.ok) {
          this.sql.exec('DELETE FROM costs WHERE month=?', from.slice(0, 7));
          for (const row of result.value) this.sql.exec('INSERT INTO costs VALUES(?,?,?,?)', from.slice(0, 7), row.account, row.name, row.amountCents);
        }
        this.sql.exec(`INSERT INTO cost_fetches VALUES(?,?,?,?) ON CONFLICT(month) DO UPDATE SET through=excluded.through, at=excluded.at, error=excluded.error`,
          from.slice(0, 7), result.ok ? to : (last?.through ?? to), result.ok ? today : (last?.at ?? '0000-00-00'), result.ok ? null : result.error);
      });
    }
  }

  /** Costs and revenue of a month up to `through`; null when iÚčto was never read for that month. */
  private monthResult(month: string, through: string) {
    const fetch = this.sql.exec<{through: string; error: string | null}>('SELECT through, error FROM cost_fetches WHERE month=?', month).toArray()[0];
    if (!fetch) return null;
    const rows = this.sql.exec<{account: string; name: string; amount_cents: number}>('SELECT account, name, amount_cents FROM costs WHERE month=? ORDER BY amount_cents DESC, account', month).toArray()
      .map(row => ({account: row.account, name: row.name, amountCents: row.amount_cents})) as CostRow[];
    let revenueCents = 0, revenueDays = 0;
    for (let day = month + '-01'; day <= through; day = addDays(day, 1)) {
      const revenue = this.dayRevenue(day);
      if (revenue !== null) { revenueCents += revenue; revenueDays++; }
    }
    return {month, through: fetch.through, rows, revenueCents, revenueDays, error: fetch.error};
  }

  /** Revenue of a past day: POS data when there is any, then the managers' report, otherwise the imported history. */
  private dayRevenue(date: string): number | null {
    const bills = this.day<Bill>('bill', date).filter(bill => bill.status === 'closed');
    if (bills.length) return bills.reduce((sum, bill) => sum + bill.totalCents, 0);
    const reported = this.sql.exec<{total: number | null}>("SELECT SUM(amount_cents) AS total FROM report_lines WHERE business_date=? AND kind='revenue_section'", date).toArray()[0]?.total;
    if (reported !== null && reported !== undefined) return reported;
    return this.sql.exec<{revenue_cents: number}>('SELECT revenue_cents FROM history WHERE business_date=?', date).toArray()[0]?.revenue_cents ?? null;
  }

  /** A stored report counts only when the managers' daily report has revenue: the cash book alone is not the day's report. */
  private hasReport(date: string): boolean {
    return this.sql.exec("SELECT 1 FROM report_lines WHERE business_date=? AND kind='revenue_section' AND substr(label, 1, ?) <> ? LIMIT 1",
      date, JOURNAL_LABEL.length, JOURNAL_LABEL).toArray().length > 0;
  }

  /** The day is ready when the managers' report is in, or when every register has closed. */
  private ready(config: TenantConfig, date: string): boolean {
    if (this.hasReport(date)) return true;
    const closings = this.day<CashClosing>('cash_closing', date);
    if (!config.registers.length) return closings.length > 0;
    const closed = new Set(closings.map(closing => closing.registerId));
    return config.registers.every(register => closed.has(register));
  }

  /** One stretch of days for the weekly summary: revenue, confirmed bookings, website visits, new reviews. */
  private weekPart(from: string, to: string): WeekPart {
    const part: WeekPart = {revenueCents: 0, revenueDays: 0, reservations: 0, guests: 0, noShows: 0, noShowGuests: 0, cancelled: 0, visits: null, visitDays: 0, webSent: 0, webConfirmed: 0, reviews: 0, rated: 0, starsTenths: null, origins: []};
    const origins = new Map<string, WeekPart['origins'][number]>();
    // Bookings summed in SQL: nothing of the guests is read for a count.
    const booked = this.sql.exec<Record<'reservations' | 'guests' | 'noShows' | 'noShowGuests' | 'webConfirmed' | 'cancelled', number | null>>(`SELECT
        SUM(status = 'confirmed') AS reservations, SUM(CASE WHEN status = 'confirmed' THEN size ELSE 0 END) AS guests,
        SUM(status = 'confirmed' AND arrival = 'no_show') AS noShows, SUM(CASE WHEN status = 'confirmed' AND arrival = 'no_show' THEN size ELSE 0 END) AS noShowGuests,
        SUM(status = 'confirmed' AND source = 'web') AS webConfirmed, SUM(status = 'cancelled') AS cancelled
      FROM (SELECT json_extract(json, '$.status') AS status, json_extract(json, '$.partySize') AS size, json_extract(json, '$.arrival') AS arrival,
        json_extract(json, '$.source') AS source FROM records WHERE type='reservation' AND business_date BETWEEN ? AND ?)`, from, to).toArray()[0];
    for (const key of ['reservations', 'guests', 'noShows', 'noShowGuests', 'webConfirmed', 'cancelled'] as const) part[key] = booked?.[key] ?? 0;
    // Where the confirmed bookings came from, and how long before their day they were made: only these fields are read.
    part.sources = this.sql.exec<{source: string | null; reservations: number; guests: number | null; noShowGuests: number | null}>(`SELECT
        json_extract(json, '$.source') AS source, count(*) AS reservations, SUM(json_extract(json, '$.partySize')) AS guests,
        SUM(CASE WHEN json_extract(json, '$.arrival') = 'no_show' THEN json_extract(json, '$.partySize') ELSE 0 END) AS noShowGuests
      FROM records WHERE type='reservation' AND business_date BETWEEN ? AND ? AND json_extract(json, '$.status') = 'confirmed'
      GROUP BY source ORDER BY reservations DESC, source`, from, to).toArray()
      .map(row => ({source: row.source ?? 'neuvedeno', reservations: row.reservations, guests: row.guests ?? 0, noShowGuests: row.noShowGuests ?? 0}));
    const lead = {sameDay: 0, upTo2: 0, upTo7: 0, more: 0}, timeZone = this.config()?.timeZone ?? 'Europe/Prague';
    for (const row of this.sql.exec<{day: string; created: string | null}>(`SELECT business_date AS day, json_extract(json, '$.createdAt') AS created
      FROM records WHERE type='reservation' AND business_date BETWEEN ? AND ? AND json_extract(json, '$.status') = 'confirmed'`, from, to)) {
      if (!row.created) continue;
      const days = Math.round((Date.parse(row.day) - Date.parse(localTime(new Date(row.created), timeZone).date)) / 86400000);
      if (days <= 0) lead.sameDay++; else if (days <= 2) lead.upTo2++; else if (days <= 7) lead.upTo7++; else lead.more++;
    }
    part.lead = lead;
    for (let date = from; date <= to; date = addDays(date, 1)) {
      const revenue = this.dayRevenue(date);
      if (revenue !== null) { part.revenueCents += revenue; part.revenueDays++; }

      const web = this.day<WebTraffic>('web_traffic', date)[0];
      if (web) { part.visits = (part.visits ?? 0) + web.visits; part.visitDays++; part.webSent += web.actions['rezervace-odeslana'] ?? 0; }
      for (const origin of web?.origins ?? []) {
        const row = origins.get(origin.key) ?? {key: origin.key, name: origin.name, visits: 0, withAction: 0};
        row.visits += origin.visits; row.withAction += origin.withAction; origins.set(origin.key, row);
      }
    }
    part.origins = [...origins.values()].filter(row => row.visits > 0).sort((a, b) => b.visits - a.visits || a.key.localeCompare(b.key));
    return {...part, ...this.reviewStats(from, to)};
  }

  /** New reviews over a stretch of days (counts by stars only). */
  private reviewStats(from: string, to: string): ReviewStats {
    let reviews = 0, rated = 0, starSum = 0;
    for (let date = from; date <= to; date = addDays(date, 1)) {
      for (const source of this.day<ReviewSummary>('review_summary', date)[0]?.sources ?? []) {
        source.stars.forEach((count, i) => { rated += count; starSum += count * (i + 1); });
        reviews += source.stars.reduce((sum, count) => sum + count, 0) + source.unrated;
      }
    }
    return {reviews, rated, starsTenths: rated ? Math.round(starSum / rated * 10) : null};
  }

  /** Revenue of a stretch of days, and by section when every day with revenue has its sections (POS bills or the managers' report). */
  private monthPart(config: TenantConfig, from: string, to: string): MonthPart {
    const part: MonthPart = {revenueCents: 0, revenueDays: 0, bySection: null};
    const sections = new Map<string, number>();
    let split = true;
    for (let date = from; date <= to; date = addDays(date, 1)) {
      const revenue = this.dayRevenue(date);
      if (revenue === null) continue;
      part.revenueCents += revenue; part.revenueDays++;
      const bills = this.day<Bill>('bill', date).filter(bill => bill.status === 'closed');
      const rows = bills.length ? bills.map(bill => ({key: bill.section, amountCents: bill.totalCents}))
        : this.sql.exec<{key: string; amount_cents: number}>("SELECT key, amount_cents FROM report_lines WHERE business_date=? AND kind='revenue_section'", date).toArray()
          .map(row => ({key: row.key, amountCents: row.amount_cents}));
      // A day known only from the imported history has its total but no sections.
      if (!rows.length) split = false;
      for (const row of rows) sections.set(row.key, (sections.get(row.key) ?? 0) + row.amountCents);
    }
    const order = Object.keys(config.sections);
    if (split && sections.size) part.bySection = [...sections].map(([section, revenueCents]) => ({section, label: config.sections[section] ?? section, revenueCents}))
      .sort((a, b) => (order.indexOf(a.section) + 1 || 99) - (order.indexOf(b.section) + 1 || 99) || a.section.localeCompare(b.section));
    return part;
  }

  /**
   * Cash payouts or cash expenses summed by their label over a stretch of days, largest first. The cash book numbers
   * a label repeated on one day (`security`, `security-2`), so the label, not the key, is what adds up.
   */
  private reportSums(kind: 'payout' | 'expense', from: string, to: string): {label: string; amountCents: number}[] {
    return this.sql.exec<{label: string; total: number}>(`SELECT max(label) AS label, SUM(amount_cents) AS total FROM report_lines
      WHERE kind=? AND business_date BETWEEN ? AND ? AND amount_cents > 0 GROUP BY lower(label) ORDER BY total DESC, lower(label)`, kind, from, to).toArray()
      .map(row => ({label: row.label, amountCents: row.total}));
  }

  /** Discounts over a stretch of days: by type, and the total as each day's report states it ("Slevy a odpisy celkem", else its lines). */
  private discountSums(from: string, to: string): {rows: {label: string; amountCents: number}[]; totalCents: number} {
    const rows = this.sql.exec<{label: string; total: number}>(`SELECT max(label) AS label, SUM(amount_cents) AS total FROM report_lines
      WHERE kind='discount' AND business_date BETWEEN ? AND ? AND amount_cents > 0 GROUP BY key ORDER BY total DESC, key`, from, to).toArray()
      .map(row => ({label: row.label, amountCents: row.total}));
    const totalCents = this.sql.exec<{total: number | null}>(`SELECT SUM(day_total) AS total FROM (SELECT coalesce(
        max(CASE WHEN kind='total' AND key='discounts' THEN amount_cents END), SUM(CASE WHEN kind='discount' AND amount_cents > 0 THEN amount_cents ELSE 0 END)) AS day_total
      FROM report_lines WHERE business_date BETWEEN ? AND ? AND (kind='discount' OR (kind='total' AND key='discounts')) GROUP BY business_date)`, from, to).toArray()[0]?.total ?? 0;
    return {rows, totalCents};
  }

  /** The month up to the reported day against the same days of the month before; complete on the month's last day. */
  private month(config: TenantConfig, date: string): Month {
    const from = date.slice(0, 7) + '-01', previousLast = addDays(from, -1), previousMonth = previousLast.slice(0, 7);
    const complete = addDays(date, 1).endsWith('-01');
    // The whole month on its last day is compared with the whole month before, otherwise the same days of it.
    const previousThrough = complete || `${previousMonth}-${date.slice(8)}` > previousLast ? previousLast : `${previousMonth}-${date.slice(8)}`;
    const sum = (rows: {amountCents: number}[]) => rows.reduce((total, row) => total + row.amountCents, 0);
    const payouts = this.reportSums('payout', from, date), expenses = this.reportSums('expense', from, date), discounts = this.discountSums(from, date);
    return {month: date.slice(0, 7), through: date, complete,
      current: this.monthPart(config, from, date), previous: {...this.monthPart(config, previousMonth + '-01', previousThrough), month: previousMonth, through: previousThrough},
      payouts, payoutsCents: sum(payouts), expenses, expensesCents: sum(expenses), discounts: discounts.rows, discountsCents: discounts.totalCents,
      reviews: this.reviewStats(from, date)};
  }

  /** Discounts by type on the same weekday of the 4 weeks before, counting only days whose managers' report has the discount block. */
  private discountHistory(date: string): DiscountHistory {
    const history: DiscountHistory = {days: 0, totals: {}};
    for (const back of [7, 14, 21, 28]) {
      const day = addDays(date, -back);
      // A report whose discount block is missing says nothing about the usual discounts.
      if (!this.hasReport(day) || !this.sql.exec("SELECT 1 FROM report_lines WHERE business_date=? AND (kind='discount' OR (kind='total' AND key='discounts')) LIMIT 1", day).toArray().length) continue;
      history.days++;
      for (const row of this.sql.exec<{key: string; total: number}>("SELECT key, SUM(amount_cents) AS total FROM report_lines WHERE business_date=? AND kind='discount' AND amount_cents > 0 GROUP BY key", day).toArray())
        history.totals[row.key] = (history.totals[row.key] ?? 0) + row.total;
    }
    return history;
  }

  /** The starting day's weekday over the 4 weeks before: revenue for the plan, confirmed guests on days that had bookings. */
  private outlookHistory(today: string) {
    const back = [7, 14, 21, 28].map(days => addDays(today, -days));
    return {
      todayPlanHistory: back.map(day => this.dayRevenue(day)).filter((value): value is number => value !== null).map(revenueCents => ({revenueCents})),
      // Sums in SQL: nothing of the guests is read for a count.
      todayGuestHistory: back.map(day => this.sql.exec<{rows: number; guests: number | null}>(`SELECT count(*) AS rows,
          SUM(CASE WHEN json_extract(json, '$.status') = 'confirmed' THEN json_extract(json, '$.partySize') ELSE 0 END) AS guests
        FROM records WHERE type='reservation' AND business_date=?`, day).toArray()[0]).filter(row => row && row.rows > 0).map(row => row.guests ?? 0),
    };
  }

  /** Confirmed and no-show guests over the 28 days before the reported day (one query, no guest details read). */
  private noShowHistory(date: string) {
    const row = this.sql.exec<{confirmed: number | null; noShow: number | null}>(`SELECT
        SUM(json_extract(json, '$.partySize')) AS confirmed,
        SUM(CASE WHEN json_extract(json, '$.arrival') = 'no_show' THEN json_extract(json, '$.partySize') ELSE 0 END) AS noShow
      FROM records WHERE type='reservation' AND business_date BETWEEN ? AND ? AND json_extract(json, '$.status') = 'confirmed'`, addDays(date, -28), addDays(date, -1)).toArray()[0];
    return {confirmedGuests: row?.confirmed ?? 0, noShowGuests: row?.noShow ?? 0};
  }

  /**
   * Revenue forecast from the day after the reported one: weekday averages of the 4 weeks up to the reported day,
   * times last year's seasonality (a month's daily average last year against the same 4 weeks last year, 52 weeks back; 20 days of data each).
   */
  private forecast(date: string): Forecast {
    const today = addDays(date, 1), month = today.slice(0, 7);
    // Each day's revenue is read once (the month so far overlaps the 4 weeks).
    const cache = new Map<string, number | null>();
    const revenue = (entry: string) => { if (!cache.has(entry)) cache.set(entry, this.dayRevenue(entry)); return cache.get(entry)!; };
    const window = Array.from({length: 28}, (_, i) => addDays(date, -i));
    const history = Array.from({length: 7}, (_, day) => window.filter(entry => weekday(entry) === day).map(revenue).filter((value): value is number => value !== null));
    // A weekday with no revenue in 4 weeks while at least 4 others have it counts as closed (0), so it does not blank the sums.
    const open = history.filter(values => values.length >= 2).length;
    const bases = history.map(values => !values.length && open >= 4 ? 0 : planFrom(values.map(revenueCents => ({revenueCents})))?.revenueCents ?? null);
    const average = (dates: string[]) => {
      const values = dates.map(revenue).filter((value): value is number => value !== null);
      return values.length >= 20 ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
    };
    const baseLastYear = average(window.map(entry => addDays(entry, -364)));
    // The month of every forecast day: the 7 days, the rest of this month and the whole next one (the 1st + 31 days is always in it).
    const months = new Set([month, addDays(month + '-01', 31).slice(0, 7), ...Array.from({length: 7}, (_, i) => addDays(today, i).slice(0, 7))]);
    const seasonal: Record<string, number> = {};
    for (const entry of baseLastYear ? months : []) {
      const lastYear = `${Number(entry.slice(0, 4)) - 1}${entry.slice(4)}`, days: string[] = [];
      for (let day = lastYear + '-01'; day.startsWith(lastYear); day = addDays(day, 1)) days.push(day);
      const value = average(days);
      if (value !== null) seasonal[entry] = Math.round(Math.min(SEASON_MAX, Math.max(SEASON_MIN, value / baseLastYear!)) * 100) / 100;
    }
    let cents = 0, days = 0;
    const missing: string[] = [];
    for (let day = month + '-01'; day <= date; day = addDays(day, 1)) { const value = revenue(day); if (value !== null) { cents += value; days++; } else missing.push(day); }
    // Confirmed guests summed in SQL (nothing of the guests is read): the next 7 days, and each weekday's usual over the 4 weeks (days with bookings, at least two).
    const guests = (from: string, to: string) => new Map(this.sql.exec<{day: string; guests: number | null}>(`SELECT business_date AS day,
        SUM(CASE WHEN json_extract(json, '$.status') = 'confirmed' THEN json_extract(json, '$.partySize') ELSE 0 END) AS guests
      FROM records WHERE type='reservation' AND business_date BETWEEN ? AND ? GROUP BY business_date`, from, to).toArray().map(row => [row.day, row.guests ?? 0]));
    const past = guests(window.at(-1)!, date), coming = guests(today, addDays(today, 6));
    const usual = Array.from({length: 7}, (_, day) => {
      const values = window.filter(entry => weekday(entry) === day && past.has(entry)).map(entry => past.get(entry)!);
      return values.length >= 2 ? Math.round(values.reduce((sum, value) => sum + value, 0) / values.length) : null;
    });
    const bookings = Object.fromEntries(Array.from({length: 7}, (_, i) => addDays(today, i)).map(day => [day, {guests: coming.get(day) ?? 0, usualGuests: usual[weekday(day)]}]));
    const weather = this.sql.exec<{json: string}>('SELECT json FROM weather WHERE date >= ? ORDER BY date LIMIT 10', today).toArray().map(row => JSON.parse(row.json) as WeatherDay);
    // The plan each morning gave for its day against what the day made, over the 28 days up to the reported one.
    // Up to the day before the reported one: the reported day's revenue may still be incomplete.
    const logged = this.sql.exec<{day: string; cents: number}>('SELECT for_date AS day, cents FROM forecast_log WHERE horizon=0 AND for_date BETWEEN ? AND ?', window.at(-1)!, addDays(date, -1)).toArray();
    const accuracy = forecastAccuracy(logged.map(row => ({forecastCents: row.cents, actualCents: revenue(row.day)}))
      .filter((row): row is {forecastCents: number; actualCents: number} => row.actualCents !== null));
    // Public events: their names on the 7 days, and how much past event days made against their weekday's average (half a year back).
    const coming7 = this.events(today, addDays(today, 6));
    const events: Record<string, string[]> = {};
    for (const event of coming7) (events[event.date] ??= []).push(event.title);
    // Each event day against up to 4 earlier same weekdays without an event (8 weeks back): a weekly event has none, so its
    // weekday average already holds it and the factor stays unknown instead of near 1.
    const eventDates = new Set(this.events(addDays(date, -182 - 56), date).map(event => event.date));
    const ratios = [...eventDates].filter(day => day >= addDays(date, -182)).flatMap(day => {
      const plain = [7, 14, 21, 28, 35, 42, 49, 56].map(back => addDays(day, -back)).filter(entry => !eventDates.has(entry))
        .map(revenue).filter((value): value is number => value !== null).slice(0, 4);
      const made = revenue(day), base = planFrom(plain.map(revenueCents => ({revenueCents})));
      return made !== null && base && base.revenueCents > 0 ? [made / base.revenueCents] : [];
    });
    return forecast({today, bases, seasonal, monthActual: {cents, days, missing}, bookings, weather, accuracy, events, eventFactor: eventFactor(ratios)});
  }

  /** Published events of the venue over a stretch of days, earliest first (public names and times only). */
  private events(from: string, to: string): {date: string; startsAt: string; section: string; title: string}[] {
    return this.sql.exec<{date: string; startsAt: string; section: string; title: string}>(`SELECT business_date AS date, json_extract(json, '$.startsAt') AS startsAt,
        json_extract(json, '$.section') AS section, json_extract(json, '$.title') AS title
      FROM records WHERE type='event' AND business_date BETWEEN ? AND ? AND json_extract(json, '$.status') = 'published' ORDER BY startsAt, id`, from, to).toArray();
  }

  /** Today's events with the confirmed guests booked that day in their place (the whole venue for an event of the whole venue). */
  private todayEvents(config: TenantConfig, date: string): Briefing['events'] {
    return this.events(date, date).map(event => {
      const guests = this.placeGuests(date, event.section);
      const local = localTime(new Date(event.startsAt), config.timeZone);
      return {time: `${local.hour}:${String(local.minute).padStart(2, '0')}`, label: event.section === 'all' ? 'celý podnik' : Object.hasOwn(config.sections, event.section) ? config.sections[event.section] : event.section, title: event.title, guests};
    });
  }

  /** The 7 days up to the reported day against the 7 days before them. */
  private week(date: string): Week {
    const week: Week = {from: addDays(date, -6), to: date, current: this.weekPart(addDays(date, -6), date), previous: this.weekPart(addDays(date, -13), addDays(date, -7)),
      reviewsUsual: this.reviewStats(addDays(date, -34), addDays(date, -7)), events: this.eventReviews(addDays(date, -6), date)};
    return {...week, reviewDrop: reviewDrop(week)};
  }

  /** Confirmed guests booked on a day in a place (`all` = the whole venue), summed in SQL. */
  private placeGuests(date: string, section: string): number {
    return this.sql.exec<{guests: number | null}>(`SELECT SUM(json_extract(json, '$.partySize')) AS guests FROM records WHERE type='reservation'
      AND business_date=? AND json_extract(json, '$.status') = 'confirmed' AND (? = 'all' OR json_extract(json, '$.section') = ?)`, date, section, section).toArray()[0]?.guests ?? 0;
  }

  /**
   * The week's events looked back on: guests booked in the event's place and the day's revenue, against the average of
   * up to 4 earlier same weekdays without an event (8 weeks back, at least 2 of them, else unknown).
   */
  private eventReviews(from: string, to: string): EventReview[] {
    const events = this.events(from, to);
    if (!events.length) return [];
    const eventDays = new Set(this.events(addDays(from, -56), to).map(event => event.date));
    return events.map(event => {
      const plain = [1, 2, 3, 4, 5, 6, 7, 8].map(back => addDays(event.date, -7 * back)).filter(day => !eventDays.has(day)).slice(0, 4);
      const booked = plain.map(day => this.placeGuests(day, event.section)).filter(guests => guests > 0);
      const revenues = plain.map(day => this.dayRevenue(day)).filter((value): value is number => value !== null);
      return {date: event.date, title: event.title, guests: this.placeGuests(event.date, event.section),
        usualGuests: booked.length >= 2 ? Math.round(booked.reduce((sum, guests) => sum + guests, 0) / booked.length) : null,
        revenueCents: this.dayRevenue(event.date), usualRevenueCents: planFrom(revenues.map(revenueCents => ({revenueCents})))?.revenueCents ?? null};
    });
  }

  /**
   * Guests to expect over the 7 days from the starting one, by part of the day (local hour of the booking's start). For each day, the same
   * weekday of the 8 weeks before shows how many guests were still booked after the same moment (bookings without `createdAt` count as early).
   * Only for the latest day; only start, size and creation time of confirmed bookings are read.
   */
  private guestOutlook(config: TenantConfig, date: string, now: Date): {days: GuestOutlookDay[]} | null {
    if (date !== reportDate(now, config.timeZone, config.businessDayCutoffHour)) return null;
    const today = addDays(date, 1), empty = (): Record<DayPart, number> => ({day: 0, evening: 0, night: 0});
    const rows = new Map<string, {part: DayPart; size: number; created: number | null}[]>();
    for (const row of this.sql.exec<{day: string; starts: string; size: number | null; created: string | null}>(`SELECT business_date AS day,
        json_extract(json, '$.startsAt') AS starts, json_extract(json, '$.partySize') AS size, json_extract(json, '$.createdAt') AS created
      FROM records WHERE type='reservation' AND business_date BETWEEN ? AND ? AND json_extract(json, '$.status') = 'confirmed'`, addDays(today, -56), addDays(today, 6))) {
      const list = rows.get(row.day) ?? [];
      list.push({part: dayPart(localTime(new Date(row.starts), config.timeZone).hour), size: row.size ?? 0, created: row.created ? Date.parse(row.created) : null});
      rows.set(row.day, list);
    }
    const sum = (list: {part: DayPart; size: number}[]) => list.reduce((parts, row) => { parts[row.part] += row.size; return parts; }, empty());
    const days = [0, 1, 2, 3, 4, 5, 6].map(ahead => {
      const day = addDays(today, ahead);
      const past = [1, 2, 3, 4, 5, 6, 7, 8].map(back => ({back, list: rows.get(addDays(day, -7 * back)) ?? []})).filter(({list}) => list.length > 0)
        .map(({back, list}) => {
          // The same moment before that day as now is before this one.
          const moment = now.getTime() - 7 * back * 86400000;
          return {final: sum(list), early: sum(list.filter(row => row.created === null || row.created <= moment))};
        });
      return guestOutlookDay(day, sum(rows.get(day) ?? []), past);
    });
    return days.some(day => day.booked || day.expected) ? {days} : null;
  }

  private senders(now: Date) {
    return sendersFrom(this.sql.exec<{installation_id: string; last_seen_at: string | null}>('SELECT installation_id, last_seen_at FROM installations').toArray(), now);
  }

  /** Senders silent too long, for the briefing: only for the report day of `now` (this morning's message), not for old days. */
  private silentSources(config: TenantConfig, date: string, now: Date): {name: string; since: string}[] {
    if (date !== reportDate(now, config.timeZone, config.businessDayCutoffHour)) return [];
    return this.senders(now).filter(row => row.silent).map(row => ({name: row.name, since: stamp(row.at, config.timeZone)}));
  }

  /** Dashboard: every kind of sender and type of data with the time it last arrived, plus the last report and cost fetches. No content. */
  private sources(config: TenantConfig) {
    const at = (value: string | null) => value ? stamp(new Date(value), config.timeZone) : null;
    const names: Record<string, string> = {bill: 'Účty z pokladny', cash_closing: 'Uzávěrky pokladen', bottle_check: 'Kontrola lahví', reservation: 'Rezervace', web_traffic: 'Návštěvnost webu', review_summary: 'Recenze', event: 'Akce podniku', menu: 'Jídelní a nápojový lístek'};
    const report = this.sql.exec<{at: string; found: number}>('SELECT at, found FROM report_fetches ORDER BY at DESC LIMIT 1').toArray()[0];
    const cost = this.sql.exec<{at: string; error: string | null}>('SELECT at, error FROM cost_fetches ORDER BY at DESC LIMIT 1').toArray()[0];
    return {
      senders: this.senders(new Date()).map(row => ({name: row.name, lastSeen: stamp(row.at, config.timeZone), silent: row.silent})),
      types: this.sql.exec<{type: string; last: string}>('SELECT type, max(received_at) AS last FROM records GROUP BY type ORDER BY type').toArray()
        .map(row => ({name: names[row.type] ?? row.type, lastReceived: at(row.last)})),
      report: report ? {at: at(report.at), found: report.found === 1} : null,
      costs: cost ? {at: at(cost.at), ok: !cost.error} : null,
    };
  }

  private briefingFor(config: TenantConfig, date: string, incomplete: boolean, now = new Date()) {
    const planHistory = [7, 14, 21, 28].map(days => this.dayRevenue(addDays(date, -days))).filter((value): value is number => value !== null).map(revenueCents => ({revenueCents}));
    const briefing = buildBriefing({businessDate: date, config, bills: this.day<Bill>('bill', date), closings: this.day<CashClosing>('cash_closing', date),
      bottleChecks: this.day<BottleCheck>('bottle_check', date), planHistory, incomplete, report: this.report(date), notes: this.notes(date),
      reservations: this.day<Reservation>('reservation', date), reservationsToday: this.day<Reservation>('reservation', addDays(date, 1)),
      web: this.day<WebTraffic>('web_traffic', date)[0], webLastWeek: this.day<WebTraffic>('web_traffic', addDays(date, -7))[0],
      reviews: this.day<ReviewSummary>('review_summary', date)[0],
      week: weekday(date) === 0 ? this.week(date) : null, silent: this.silentSources(config, date, now),
      month: weekday(date) === 0 || addDays(date, 1).endsWith('-01') ? this.month(config, date) : null,
      lastWeekRevenueCents: this.dayRevenue(addDays(date, -7)), discountHistory: this.discountHistory(date),
      ...this.outlookHistory(addDays(date, 1)), noShowHistory: this.noShowHistory(date), forecast: this.forecast(date), pendingAhead: this.pendingAhead(config, date, now), events: this.todayEvents(config, addDays(date, 1)), guestOutlook: this.guestOutlook(config, date, now),
      forecastPlanCents: this.loggedPlan(date), todayPlanCents: this.loggedPlan(addDays(date, 1)),
      costs: this.monthResult(date.slice(0, 7), date), costsPrevious: Number(date.slice(8)) <= 15 ? this.monthResult(addDays(date.slice(0, 7) + '-01', -1).slice(0, 7), addDays(date.slice(0, 7) + '-01', -1)) : null});
    return {briefing, text: renderBriefing(config.name, briefing)};
  }

  private preview(date: string | undefined): Result {
    const config = this.config();
    if (!config) return failure('NOT_CONFIGURED', 409);
    if (!isDate(date)) return failure('INVALID_REQUEST', 400);
    return ok(this.briefingFor(config, date, !this.ready(config, date)));
  }

  /** Called by the morning cron trigger. Decides whether this morning's briefing goes out now. */
  async tick(at: Date, tenant: string) {
    const config = this.config();
    if (!config) return {decision: 'not-configured'};
    const date = reportDate(at, config.timeZone, config.businessDayCutoffHour);
    const sent = this.sql.exec<{status: string}>("SELECT status FROM briefings WHERE business_date=? AND status IN ('stored','delivered')", date).toArray().length > 0;
    const hour = localHour(at, config.timeZone);
    // The managers' report is fetched only at the send hours (7, 8, 9) and only until it is in (rule of 10. 10. 2026).
    // Fetching and analysis get a time budget, so a slow OneDrive or API can never stop the 9:00 send.
    if (!sent && config.sendHours.includes(hour)) {
      await withinBudget((async () => {
        if (config.reportsLink && !this.hasReport(date)) await this.fetchReport(tenant, date);
        await this.analyse(config, date);
        // Costs once a day (a failed read is tried again at the next send hour); the quota is the venue's (5 000 requests a day on the Firma plan).
        await this.fetchCosts(tenant, date, businessDate(at, config.timeZone, 0));
        await this.refreshWeather(config, at);
      })(), PREPARE_BUDGET_MS);
    }
    const decision = briefingDecision({localHour: hour, sendHours: config.sendHours, alreadySent: sent, ready: this.ready(config, date)});
    if (decision !== 'send' && decision !== 'send-incomplete') return {decision, businessDate: date};
    const {briefing, text} = this.briefingFor(config, date, decision === 'send-incomplete', at);
    // Without a configured channel the briefing is 'stored' and readable through the admin API.
    // A 'failed' delivery is not counted as sent, so the next send hour (until the last one) tries again.
    const status = await deliver(this.env, config.recipients, text);
    // What a message that went out forecast is kept, so tomorrow's message compares the day with it; a failed one is not (the retry counts).
    for (const [horizon, day] of status === 'failed' ? [] : (briefing.forecast?.days ?? []).entries()) {
      if (day.cents !== null) this.sql.exec('INSERT OR IGNORE INTO forecast_log VALUES(?,?,?,?)', day.date, horizon, day.cents, date);
    }
    this.sql.exec(`INSERT INTO briefings VALUES(?,?,?,?,?,?) ON CONFLICT(business_date) DO UPDATE SET
      status=excluded.status, incomplete=excluded.incomplete, text=excluded.text, json=excluded.json, created_at=excluded.created_at`,
    date, status, briefing.incomplete ? 1 : 0, text, JSON.stringify(briefing), at.toISOString());
    this.archive(`t/${tenant}/export/${date}.json`, JSON.stringify(this.exportDay(date)));
    return {decision, businessDate: date, status, text};
  }

  /** Bookings for the 7 days after the starting one still waiting for confirmation: counts and the first start only, summed in SQL. */
  private pendingAhead(config: TenantConfig, date: string, now: Date): Briefing['pendingAhead'] {
    // Only for the latest day: on an old day the bookings still waiting would be today's, not that day's.
    if (date !== reportDate(now, config.timeZone, config.businessDayCutoffHour)) return null;
    const where = `FROM records WHERE type='reservation' AND business_date BETWEEN ? AND ? AND json_extract(json, '$.status') = 'pending'`;
    const total = this.sql.exec<{count: number; guests: number | null}>(`SELECT count(*) AS count, SUM(json_extract(json, '$.partySize')) AS guests ${where}`,
      addDays(date, 2), addDays(date, 8)).toArray()[0];
    const first = this.sql.exec<{day: string; starts: string}>(`SELECT business_date AS day, json_extract(json, '$.startsAt') AS starts ${where} ORDER BY starts LIMIT 1`,
      addDays(date, 2), addDays(date, 8)).toArray()[0];
    if (!total?.count || !first) return null;
    const local = localTime(new Date(first.starts), config.timeZone);
    return {count: total.count, guests: total.guests ?? 0, first: {date: first.day, time: `${local.hour}:${String(local.minute).padStart(2, '0')}`}};
  }

  /** The plan a sent morning message gave for its day (horizon 0), if any. */
  private loggedPlan(date: string): number | null {
    return this.sql.exec<{cents: number}>('SELECT cents FROM forecast_log WHERE for_date=? AND horizon=0', date).toArray()[0]?.cents ?? null;
  }

  /** The weather forecast for the venue (MET Norway, no key); a failed read keeps the last one. */
  private async refreshWeather(config: TenantConfig, at: Date) {
    if (!config.location) return;
    const last = this.sql.exec<{at: string | null}>('SELECT max(fetched_at) AS at FROM weather').toArray()[0]?.at;
    if (last && at.getTime() - Date.parse(last) < 3 * HOUR_MS) return;
    try {
      const response = await fetch(`${WEATHER_URL}?lat=${config.location.lat}&lon=${config.location.lon}`,
        {headers: {'user-agent': WEATHER_AGENT, accept: 'application/json'}, signal: AbortSignal.timeout(10000)});
      if (!response.ok) { console.log('weather', response.status); return; }
      const days = weatherDays(await response.json(), config.timeZone);
      if (!days.length) return;
      this.ctx.storage.transactionSync(() => {
        this.sql.exec('DELETE FROM weather WHERE date < ?', addDays(localTime(at, config.timeZone).date, -1));
        for (const day of days) this.sql.exec('INSERT OR REPLACE INTO weather VALUES(?,?,?)', day.date, JSON.stringify(day), at.toISOString());
      });
    } catch (error) {
      console.log('weather', error instanceof Error ? error.name : 'error');
    }
  }

  /** Everything stored about one business day, for the daily export to R2. */
  private exportDay(date: string) {
    return {
      businessDate: date, exportedAt: new Date().toISOString(),
      records: this.sql.exec<{json: string}>('SELECT json FROM records WHERE business_date=? ORDER BY type, id', date).toArray().map(row => withoutGuest(JSON.parse(row.json))),
      report: this.report(date), notes: this.notes(date),
      briefing: this.sql.exec('SELECT status, incomplete, text, created_at AS createdAt FROM briefings WHERE business_date=?', date).toArray()[0] ?? null,
    };
  }
}

/** The list of configured venues, so the morning trigger knows whom to wake. */
export class Registry extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS tenants(tenant TEXT PRIMARY KEY)');
  }
  async add(tenant: string) { this.ctx.storage.sql.exec('INSERT OR IGNORE INTO tenants VALUES(?)', tenant); }
  async has(tenant: string): Promise<boolean> { return this.ctx.storage.sql.exec('SELECT 1 FROM tenants WHERE tenant=?', tenant).toArray().length > 0; }
  async list(): Promise<string[]> { return this.ctx.storage.sql.exec<{tenant: string}>('SELECT tenant FROM tenants ORDER BY tenant').toArray().map(row => row.tenant); }
}

const routes: Record<string, string[]> = {
  'v1/ingest': ['POST'], 'admin/config': ['GET', 'PUT'], 'admin/pair': ['POST'], 'admin/history': ['POST'],
  'admin/briefing': ['GET'], 'admin/briefings': ['GET'], 'admin/tick': ['POST'], 'admin/report': ['GET', 'PUT'], 'admin/fetch': ['POST'], 'admin/logout': ['POST'],
  'admin/web': ['GET'], 'admin/ingest': ['GET'],
};

async function readBody(request: Request, limit: number): Promise<unknown | Result> {
  if (Number(request.headers.get('content-length') || 0) > limit) return failure('BODY_TOO_LARGE', 413);
  const reader = request.body?.getReader();
  if (!reader) return failure('INVALID_REQUEST', 400);
  const chunks: Uint8Array[] = [];
  let size = 0;
  // Bounded read also covers a missing or dishonest Content-Length.
  for (;;) {
    const part = await reader.read();
    if (part.done) break;
    size += part.value.byteLength;
    if (size > limit) { await reader.cancel(); return failure('BODY_TOO_LARGE', 413); }
    chunks.push(part.value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder().decode(bytes)); } catch { return failure('INVALID_REQUEST', 400); }
}

const SESSION_COOKIE = 'oko1_session';
function cookie(request: Request): string | null {
  const value = (request.headers.get('cookie') ?? '').split(/;\s*/).find(part => part.startsWith(SESSION_COOKIE + '='))?.slice(SESSION_COOKIE.length + 1);
  return value && /^[a-f0-9]{64}$/.test(value) ? value : null;
}

/** Dashboard routes under /d/{tenant}: the page, login by SMS code, logout and the day's data. */
async function dashboard(request: Request, env: Env, tenant: string, action: string | undefined): Promise<Response> {
  // An unknown venue answers exactly like a known one without a session, and no storage is created for it.
  const known = await registry(env).has(tenant);
  const stub = tenantStub(env, tenant);
  const path = `/d/${tenant}`;
  if (!action && request.method === 'GET') {
    const nonce = randomHex(16);
    return new Response(dashboardHtml(tenant, nonce), {headers: {
      'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-frame-options': 'DENY', 'referrer-policy': 'no-referrer',
      'content-security-policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
    }});
  }
  if (action === 'data' && request.method === 'GET') {
    if (!known || !await stub.validSession(cookie(request))) return json(failure('UNAUTHORIZED', 401));
    return json(await stub.dashboardData(new URL(request.url).searchParams.get('date') ?? undefined));
  }
  if (action === 'web' && request.method === 'GET') {
    if (!known || !await stub.validSession(cookie(request))) return json(failure('UNAUTHORIZED', 401));
    return json(ok({card: await webCard(env, tenant, stub)}));
  }
  if (request.method !== 'POST' || !['login', 'verify', 'logout', 'todo'].includes(action ?? '')) return json(failure('NOT_FOUND', 404));
  // Only same-site JSON posts: a form on another site cannot send them.
  if (!(request.headers.get('content-type') ?? '').startsWith('application/json')) return json(failure('UNSUPPORTED_MEDIA_TYPE', 415));
  const body = await readBody(request, 1024);
  if (isResult(body)) return json(body);
  // An unknown venue gets the same answers from the shared stand-in, which never has a code to send.
  if (action === 'login') return json(await loginStub(env, tenant, known).sendLoginCode((body as {phone?: unknown})?.phone, known ? '' : tenant) as Result);
  if (action === 'todo') {
    if (!known || !await stub.validSession(cookie(request))) return json(failure('UNAUTHORIZED', 401));
    const {date, key, done} = (body ?? {}) as {date?: unknown; key?: unknown; done?: unknown};
    return json(await stub.markTodo(date, key, done));
  }
  if (action === 'logout') {
    if (known) await stub.logout(cookie(request));
    return Response.json({ok: true}, {headers: {'set-cookie': `${SESSION_COOKIE}=; Path=${path}; HttpOnly; Secure; SameSite=Strict; Max-Age=0`}});
  }
  const result = await loginStub(env, tenant, known).verifyLoginCode((body as {code?: unknown})?.code, known ? '' : tenant) as Result;
  if (result.status !== 200) return json(result);
  const token = (result.body as {token: string}).token;
  return Response.json({ok: true}, {headers: {'cache-control': 'no-store', 'set-cookie': `${SESSION_COOKIE}=${token}; Path=${path}; HttpOnly; Secure; SameSite=Strict; Max-Age=${SESSION_MS / 1000}`}});
}

/**
 * The dashboard card "Web {venue}", read live from the website at the moment the page asks (docs/web-v1.md); nothing of
 * it is stored. Null = the venue has no website; `error` = the web cannot be read right now.
 */
async function webCard(env: Env, tenant: string, stub: DurableObjectStub<TenantObject>) {
  const setup = await stub.setup() as VenueSetup | null;
  if (!setup?.web) return null;
  const name = `Web ${setup.name}`;
  const site = webSite(setup.web, env, tenant);
  if (!site.ok) return {name, error: site.error};
  const card = await dashboardWeb(site.value, setup, new Date());
  return card.ok ? card.value : {name, error: `Web teď nejde načíst (${card.error}).`};
}

const isResult = (value: unknown): value is Result => !!value && typeof value === 'object' && 'status' in value && 'body' in value && Object.keys(value).length === 2;

const venues = (env: Env): Venues => ({known: tenant => registry(env).has(tenant), stub: tenant => tenantStub(env, tenant), login: (tenant, known) => loginStub(env, tenant, known)});
/** Paths of the MCP server and its OAuth (metadata, registration, token, the authorization page). */
const isOAuthPath = (path: string) => path === MCP_PATH || path.startsWith(`${MCP_PATH}/`) || path.startsWith('/oauth/') || path.startsWith('/.well-known/oauth-');
/** One OAuth provider per origin (its resource URL must be absolute); null = an origin where OAuth is not possible. */
const providers = new Map<string, OAuthProvider<Env> | null>();

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (!isOAuthPath(url.pathname)) return app(request, env);
    if (!env.OAUTH_KV) return json(failure('MCP_NOT_CONFIGURED', 503));
    let provider = providers.get(url.origin);
    if (provider === undefined) {
      try { provider = new OAuthProvider(oauthOptions(url.origin, app, venues)); } catch (error) {
        console.error('oauth not possible for', url.origin, error instanceof Error ? error.message : 'Error');
        provider = null;
      }
      providers.set(url.origin, provider);
    }
    return provider ? provider.fetch(request, env, ctx) : json(failure('NOT_FOUND', 404));
  },

  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    const tenants = await registry(env).list();
    for (const tenant of tenants) ctx.waitUntil(tenantStub(env, tenant).tick(new Date(event.scheduledTime), tenant));
  },
};

/** Everything but the MCP server: ingest, admin API and the dashboard. */
async function app(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const board = url.pathname.match(/^\/d\/([a-z0-9-]{3,64})(?:\/([a-z]+))?$/);
  if (board) return dashboard(request, env, board[1], board[2]);
  const match = url.pathname.match(/^\/(v1|admin)\/t\/([a-z0-9-]{3,64})\/([a-z]+)$/);
  const route = match ? `${match[1]}/${match[3]}` : '';
  if (!match || !routes[route]) return json(failure('NOT_FOUND', 404));
  if (!routes[route].includes(request.method)) return json(failure('METHOD_NOT_ALLOWED', 405));
  const authorization = request.headers.get('authorization') || '';
  if (match[1] === 'admin' && !(typeof env.ADMIN_SECRET === 'string' && env.ADMIN_SECRET.length >= 32 && same(authorization, 'Bearer ' + env.ADMIN_SECRET))) {
    return json(failure('UNAUTHORIZED', 401));
  }
  const token = match[1] === 'v1' && /^Bearer [a-f0-9]{64}$/.test(authorization) ? authorization.slice(7) : null;
  if (match[1] === 'v1' && !token) return json(failure('UNAUTHORIZED', 401));
  let body: unknown = null;
  if (request.method !== 'GET') {
    body = await readBody(request, route === 'v1/ingest' ? 1048576 : 262144);
    if (isResult(body)) return json(body);
  }
  const tenant = match[2];
  const stub = tenantStub(env, tenant);
  if (route === 'admin/web') return json(await webCheck(env, tenant, stub));
  return json(await stub.handle(tenant, route, request.method, body, token, Object.fromEntries(url.searchParams)));
}

/** Admin: can OKO1 read the venue's website right now? Reads only the list of tables; never the token or any data. */
async function webCheck(env: Env, tenant: string, stub: DurableObjectStub<TenantObject>): Promise<Result> {
  const setup = await stub.setup() as VenueSetup | null;
  if (!setup) return failure('NOT_CONFIGURED', 409);
  const status = {url: setup.web?.url ?? null, secret: webTokenName(tenant), token: webToken(env, tenant) !== null};
  const site = webSite(setup.web, env, tenant);
  if (!site.ok) return ok({...status, ok: false, tables: 0, error: site.error});
  const tables = await webTables(site.value);
  return ok({...status, ok: tables.ok, tables: tables.ok ? tables.value.length : 0, error: tables.ok ? null : tables.error});
}
