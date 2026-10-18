import {DurableObject} from 'cloudflare:workers';
import {OAuthProvider, type OAuthHelpers} from '@cloudflare/workers-oauth-provider';
import {createHash, randomInt, timingSafeEqual} from 'node:crypto';
import {buildBriefing, type Briefing, rankEvents, type EventRank, type MenuWeek, type MenuMonth, dayPart, RAIN_MM, rainFactor, type DayPart, type EventReview, eventFactor, guestOutlookDay, type GuestOutlookDay, forecast, forecastAccuracy, planFrom, reviewDrop, SEASON_MAX, SEASON_MIN, type Forecast, renderBriefing, sumMenuInterest, type MenuInterest, type DiscountHistory, type Month, type MonthPart, type ReviewStats, type Week, type WeekPart} from './briefing.ts';
import {dashboardHtml} from './dashboard.ts';
import {todoList} from './todo.ts';
import {competitorComparison, competitorSections, COMPETITOR_SHARE, itemProfit, menuChanges, menuGaps, menuItemTax, menuMatrix, menuOverview, nameKey, PART_NAMES, pairSale, priceText, priceCheck, priceExperiment, priceMismatches, pricesOfText, repricing, type ItemSale, type RepricingInput} from './menu.ts';
import {deliver, type DeliveryEnv} from './delivery.ts';
import {briefingDecision, localHour, reportDate, sendersFrom} from './schedule.ts';
import {czechHolidays, holidayName} from './holidays.ts';
import {addDays, businessDate, isDate, localTime, sameClockDaysBefore, weekday} from './time.ts';
import {JOURNAL_LABEL, validateDailyReport, type DailyReport} from './daily-report.ts';
import {analyseNotes, type NotesAnalysis} from './notes.ts';
import {fetchDayFiles, reportFromFiles} from './onedrive.ts';
import {authorizeUrl, pkce, redeem, renew} from './microsoft.ts';
import {fetchCosts, iuctoKey, type CostRow, type IuctoEnv} from './iucto.ts';
import {counted, drinkMargins, duplicateInvoices, overdueInvoices, priceRises, supplyBrief, supplySummary} from './supplies.ts';
import {CODE_MS, DAY_MS, HOUR_MS, nextCode, RESEND_MS, seconds, WRONG_PER_HOUR, type Wait} from './login.ts';
import {DEFAULT_BOTTLE_LOSS_CENTS, InputError, validateBatch, withoutGuest, validateCompetitorPrices, validateConfig, validateHistory, type Batch, type CompetitorPrices, type Bill, type BottleCheck, type CashClosing, type Menu, type Reservation, type ReviewSummary, type SupplierInvoice, type TenantConfig, type WebTraffic} from './validate.ts';
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
  /** OKO1's own Microsoft app (public client, read-only OneDrive). Optional: without it OneDrive is read only through the public API. */
  ONEDRIVE_CLIENT_ID?: string;
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
/** Order of the price findings in the Monday line: prices far off first, an odd ending last. */
const FINDING_RANK = {cheap: 0, expensive: 0, gap: 1, ending: 2} as const;
/** Record types of the ingest contract; a refused batch logs only these (anything else as `other`). */
const RECORD_TYPES = new Set(['bill', 'cash_closing', 'bottle_check', 'reservation', 'web_traffic', 'review_summary', 'event', 'menu', 'supplier_invoice']);
const SESSION_MS = 30 * 86400000;
/** A session renews itself on use, but never lives longer than a year from the SMS code that opened it. */
const SESSION_MAX_MS = 365 * 86400000;
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
/** The median of numbers (the middle two averaged). */
const medianOf = (values: number[]) => { const sorted = [...values].sort((a, b) => a - b), middle = Math.floor(sorted.length / 2); return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2; };

/** A booking's `version` at or above this (ms, the year 2001) is the time of its last change; smaller versions are plain counters. */
const VERSION_AS_TIME = 1e12;

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
      -- A menu that would drop over a tenth of the items at once waits here (a broken website?) and takes over after 24 hours.
      CREATE TABLE IF NOT EXISTS menu_held(id TEXT PRIMARY KEY, held_at TEXT NOT NULL, version INTEGER NOT NULL, json TEXT NOT NULL, installation_id TEXT NOT NULL,
        removed INTEGER NOT NULL, total INTEGER NOT NULL);
      -- Prices of the menu per month, part and category (last state of the month), for the price trend.
      CREATE TABLE IF NOT EXISTS menu_months(month TEXT NOT NULL, part TEXT NOT NULL, category TEXT NOT NULL, items INTEGER NOT NULL, avg_cents INTEGER NOT NULL,
        PRIMARY KEY(month, part, category));
      -- Batches OKO1 refused as not matching the contract: when, from whom, which record types (no content).
      CREATE TABLE IF NOT EXISTS ingest_rejects(at TEXT NOT NULL, installation_id TEXT NOT NULL, code TEXT NOT NULL, types TEXT NOT NULL);
      -- Prices of comparable venues nearby from their public menus (one set, replaced by the deploy).
      CREATE TABLE IF NOT EXISTS competitor_prices(id INTEGER PRIMARY KEY CHECK(id=1), json TEXT NOT NULL, received_at TEXT NOT NULL);
      -- OKO1's read-only Microsoft access for OneDrive: the renewal (rotated on each use) and the last error; the
      -- sign-ins in progress (PKCE verifier, at most 10 minutes).
      CREATE TABLE IF NOT EXISTS onedrive_access(id INTEGER PRIMARY KEY CHECK(id=1), refresh_token TEXT, connected_at TEXT NOT NULL, error TEXT);
      CREATE TABLE IF NOT EXISTS onedrive_signins(state TEXT PRIMARY KEY, verifier TEXT NOT NULL, created_at INTEGER NOT NULL);
    `));
    // Wrong codes for unknown venues are counted per venue name in the shared stand-in (see `loginStub`).
    if (!this.sql.exec<{name: string}>('PRAGMA table_info(login_failures)').toArray().some(column => column.name === 'scope')) {
      this.sql.exec("ALTER TABLE login_failures ADD COLUMN scope TEXT NOT NULL DEFAULT ''");
    }
  }

  private config(): TenantConfig | null {
    const row = this.sql.exec<{json: string}>('SELECT json FROM config WHERE id=1').toArray()[0];
    // Configs saved before the bottle check have no `bottleCheck` key.
    return row ? {bottleCheck: null, reportsLink: null, dashboardPhones: null, web: null, disabledSources: [], ...JSON.parse(row.json)} as TenantConfig : null;
  }

  async handle(tenant: string, route: string, method: string, body: unknown, token: string | null, query: Record<string, string>): Promise<Result> {
    try {
      if (route === 'v1/ingest' && method === 'POST') return this.ingest(tenant, body, token);
      if (route === 'v1/menu' && method === 'GET') return this.menuForPos(token, query);
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
      if (route === 'admin/competitors' && method === 'PUT') {
        const data = validateCompetitorPrices(body);
        this.sql.exec('INSERT OR REPLACE INTO competitor_prices VALUES(1,?,?)', JSON.stringify(data), new Date().toISOString());
        return ok({checkedOn: data.checkedOn, venues: data.venues.length, prices: data.venues.reduce((sum, venue) => sum + venue.items.length, 0)});
      }
      if (route === 'admin/competitors' && method === 'GET') return ok(this.competitors());
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
   * Step 2: a valid code opens a session for 30 days from the last use (validSession renews it, at most a year from
   * the code); only the token's hash is stored. Each code takes at most 5 tries,
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

  /**
   * A live session is renewed to 30 days from now (at most a year from its login), so whoever uses the dashboard or
   * the MCP connection at least once a month stays logged in. Written at most once a day per session.
   */
  validSession(token: string | null, now = Date.now()): boolean {
    if (!token) return false;
    const hash = sha256(token);
    const row = this.sql.exec<{created_at: number; expires_at: number}>('SELECT created_at, expires_at FROM sessions WHERE token_hash=? AND expires_at > ?', hash, now).toArray()[0];
    if (!row) return false;
    const renewed = Math.min(now + SESSION_MS, row.created_at + SESSION_MAX_MS);
    if (renewed - row.expires_at >= DAY_MS) this.sql.exec('UPDATE sessions SET expires_at=? WHERE token_hash=?', renewed, hash);
    return true;
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
    const todo = this.todoFor(day, briefing);
    return ok({name: config.name, businessDate: day, briefing, report, balances, days: series, todo, briefingText: stored?.text ?? text,
      week: briefing.week ?? this.week(day), month: briefing.month ?? this.month(config, day), trends: this.trends(day), menuInterest: this.menuInterestWeeks(day), sources: this.sources(config), menu: this.menuCard(config, day), eventRanking: briefing.eventRanking ?? this.eventRanking(day), supplies: this.suppliesCard(config, day)});
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

  /**
   * MCP: what the morning message of a report day looked ahead to: today's bookings and plan, the revenue forecast (7 days, this and next month, with holidays,
   * weather, events and bookings), the forecast's accuracy, today's events and, for the latest day only, the guests to expect by part of the day.
   */
  posOutlook(date: string) {
    const config = this.config();
    if (!config) return null;
    const {briefing} = this.briefingFor(config, date, !this.ready(config, date));
    return {businessDate: date, forecast: briefing.forecast, today: briefing.outlook, events: briefing.events,
      guests: briefing.guestOutlook, pendingAhead: briefing.pendingAhead};
  }

  /** MCP: the 7 days up to a day against the 7 before, the month so far and twelve weeks of trends with the forecast's error. */
  posTrends(date: string) {
    const config = this.config();
    if (!config) return null;
    return {businessDate: date, week: this.week(date), month: this.month(config, date), trends: this.trends(date), menuInterest: this.menuInterestWeeks(date)};
  }

  /** MCP: sums over any stretch of days (revenue, bookings, guests, no-shows, cancellations, sources, lead time, web, reviews) and its events. */
  posPeriod(from: string, to: string) {
    if (!this.config()) return null;
    this.revenueMemo = new Map();
    try { return {from, to, ...this.weekPart(from, to), events: this.eventReviews(from, to)}; } finally { this.revenueMemo = null; }
  }

  /** MCP: the events of the half year up to a day, ranked by the guests they drew against usual same weekdays, with revenue. */
  posEvents(date: string) {
    return this.config() ? {to: date, from: addDays(date, -181), events: this.eventRanking(date)} : null;
  }

  /** MCP: the to-do list of a day as the dashboard shows it (with "Vyřízeno") and when each source last sent data. */
  posTodo(date: string) {
    const config = this.config();
    if (!config) return null;
    const {briefing} = this.briefingFor(config, date, !this.ready(config, date));
    return {businessDate: date, todo: this.todoFor(date, briefing), sources: this.sources(config)};
  }

  /** The to-do list of a day with the "Vyřízeno" switches, as the dashboard shows it. */
  private todoFor(day: string, briefing: Briefing) {
    const done = new Set(this.sql.exec<{item_key: string}>('SELECT item_key FROM todo_done WHERE business_date=?', day).toArray().map(row => row.item_key));
    return todoList(briefing, this.report(day)?.warnings ?? [])
      // "… a další 3" is not an item of its own: no switch.
      .map(item => item.text.startsWith('… a další') ? {...item, key: null, done: false} : {...item, key: todoKey(item.text), done: done.has(todoKey(item.text))});
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

  /** A paired installation (the POS) and its token, as the ingest checks them. */
  private paired(installationId: unknown, token: string | null) {
    const row = typeof installationId === 'string'
      ? this.sql.exec<{token_hash: string}>('SELECT token_hash FROM installations WHERE installation_id=?', installationId).toArray()[0] : undefined;
    return !!row && !!token && same(sha256(token), row.token_hash);
  }

  /**
   * The menu for the POS (docs/ingest-v1.md, „Lístek pro pokladnu“): the latest menu with each item's kind and VAT rate,
   * so Pexeso takes it over and offers price changes. `since` = the version the POS has; the same one returns no items.
   */
  private menuForPos(token: string | null, query: Record<string, string>): Result {
    if (!this.paired(query.installationId, token)) return failure('UNAUTHORIZED', 401);
    // The website's menu (another sender, e.g. a test, never replaces it for the POS).
    const menu = this.menu('menu-web') ?? this.menu();
    if (!menu) return ok({menu: null});
    if (query.since !== undefined && query.since === String(menu.version)) return ok({menu: null, unchanged: true, version: menu.version});
    const received = this.sql.exec<{at: string}>("SELECT received_at AS at FROM records WHERE type='menu' AND id=?", menu.id).toArray()[0].at;
    return ok({menu: {version: menu.version, businessDate: menu.businessDate, receivedAt: received,
      items: menu.items.map(item => ({...item, ...menuItemTax(item)})), notes: menu.notes}});
  }

  private ingest(tenant: string, body: unknown, token: string | null): Result {
    const installationId = (body as {installationId?: unknown})?.installationId;
    if (!this.paired(installationId, token)) return failure('UNAUTHORIZED', 401);
    let batch: Batch;
    try { batch = validateBatch(body); } catch (error) {
      // Kept so a sender whose data OKO1 keeps refusing (a broken menu from the website) is seen, not silently lost.
      if (error instanceof InputError) {
        const records = (body as {records?: unknown})?.records;
        const types = [...new Set((Array.isArray(records) ? records : []).map(record => (record as {type?: unknown})?.type).map(type => typeof type === 'string' && RECORD_TYPES.has(type) ? type : 'other'))].slice(0, 10);
        this.sql.exec('INSERT INTO ingest_rejects VALUES(?,?,?,?)', new Date().toISOString(), installationId, error.message.slice(0, 60), types.join(','));
        this.sql.exec("DELETE FROM ingest_rejects WHERE at < ?", new Date(Date.now() - 90 * 86400000).toISOString());
      }
      throw error;
    }
    const payloadHash = sha256(JSON.stringify(batch));
    return this.ctx.storage.transactionSync(() => {
      const replay = this.sql.exec<{payload_hash: string; result: string}>('SELECT payload_hash, result FROM batches WHERE batch_id=?', batch.batchId).toArray()[0];
      if (replay) return replay.payload_hash === payloadHash ? ok(JSON.parse(replay.result)) : failure('BATCH_CONFLICT', 409);
      const now = new Date().toISOString();
      let accepted = 0, stale = 0;
      // A booking first sent with counts only takes its guest details (12 Oct 2026) and the time it was made at the same version (resent once).
      for (const record of batch.records) {
        if (record.type === 'menu') {
          const result = this.storeMenu(record, batch.installationId, now, false);
          if (result === 'stale') stale++; else accepted++;
          continue;
        }
        const changed = this.sql.exec(`INSERT INTO records(type, id, version, business_date, register_id, json, installation_id, received_at) VALUES(?,?,?,?,?,?,?,?)
          ON CONFLICT(type, id) DO UPDATE SET version=excluded.version, business_date=excluded.business_date, register_id=excluded.register_id,
          json=excluded.json, installation_id=excluded.installation_id, received_at=excluded.received_at WHERE excluded.version > records.version
          OR (excluded.type = 'reservation' AND excluded.version = records.version AND instr(records.json, '"guest":') = 0 AND instr(excluded.json, '"guest":') > 0)
          OR (excluded.type = 'reservation' AND excluded.version = records.version AND instr(records.json, '"createdAt":') = 0 AND instr(excluded.json, '"createdAt":') > 0
            AND (instr(excluded.json, '"guest":') > 0 OR instr(records.json, '"guest":') = 0))`,
        record.type, record.id, record.version, record.businessDate, 'registerId' in record ? record.registerId : '', JSON.stringify(record), batch.installationId, now).rowsWritten;
        if (changed) accepted++; else stale++;
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

  /**
   * Step 1 of connecting OneDrive (from a logged-in dashboard): where to send the browser to sign in at Microsoft.
   * The state names the venue, so that the callback finds it without a cookie (Microsoft's redirect is cross-site).
   */
  async onedriveStart(tenant: string, redirectUri: string): Promise<Result> {
    const clientId = this.env.ONEDRIVE_CLIENT_ID;
    if (!clientId) return failure('ONEDRIVE_NOT_CONFIGURED', 503);
    if (!this.config()?.reportsLink) return failure('NO_REPORTS_LINK', 409);
    const now = Date.now(), state = `${tenant}~${randomHex(24)}`, {verifier, challenge} = await pkce();
    this.sql.exec('DELETE FROM onedrive_signins WHERE created_at < ?', now - 10 * 60000);
    this.sql.exec('INSERT INTO onedrive_signins VALUES(?,?,?)', sha256(state), verifier, now);
    return ok({url: authorizeUrl(clientId, redirectUri, state, challenge)});
  }

  /** Step 2: Microsoft's code for the access, once per sign-in and within 10 minutes. */
  async onedriveFinish(state: string, code: string, redirectUri: string): Promise<Result> {
    const clientId = this.env.ONEDRIVE_CLIENT_ID;
    const row = this.sql.exec<{verifier: string; created_at: number}>('SELECT verifier, created_at FROM onedrive_signins WHERE state=?', sha256(state)).toArray()[0];
    this.sql.exec('DELETE FROM onedrive_signins WHERE state=?', sha256(state));
    if (!clientId || !row || row.created_at < Date.now() - 10 * 60000) return failure('SIGNIN_EXPIRED', 400);
    const result = await redeem(clientId, redirectUri, code, row.verifier);
    if (!result.ok) return failure(result.error, 502);
    this.sql.exec('INSERT OR REPLACE INTO onedrive_access VALUES(1, ?, ?, NULL)', result.tokens.refreshToken, new Date().toISOString());
    return ok({connected: true});
  }

  /** A fresh Microsoft access for this fetch, or null (not connected, not configured, or Microsoft refused: kept as the error). */
  private async onedriveToken(): Promise<string | null> {
    const clientId = this.env.ONEDRIVE_CLIENT_ID;
    const row = this.sql.exec<{refresh_token: string | null}>('SELECT refresh_token FROM onedrive_access WHERE id=1').toArray()[0];
    if (!clientId || !row?.refresh_token) return null;
    const result = await renew(clientId, row.refresh_token);
    if (!result.ok) { this.sql.exec('UPDATE onedrive_access SET error=? WHERE id=1', result.error); return null; }
    this.sql.exec('UPDATE onedrive_access SET refresh_token=?, error=NULL WHERE id=1', result.tokens.refreshToken);
    return result.tokens.accessToken;
  }

  /** Reads the day's Excel files from the shared OneDrive folder, archives them and stores the report. */
  private async fetchReport(tenant: string, date: string) {
    const link = this.config()?.reportsLink;
    if (!link) return {found: false, warnings: ['OneDrive: odkaz na složku není nastavený.']};
    let found = false, warnings: string[];
    try {
      const access = await this.onedriveToken();
      const fetched = await fetchDayFiles(link, date, access);
      const lost = this.sql.exec<{error: string | null}>('SELECT error FROM onedrive_access WHERE id=1').toArray()[0]?.error;
      if (!access && lost) fetched.warnings.unshift(`OneDrive: přístup OKO1 vypršel (${lost}), na přehledu stačí znovu kliknout na „Připojit OneDrive“.`);
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

  /**
   * Stores a newer menu with its changes (the first one is the starting point), or holds it when it would drop more than
   * a tenth of the items at once (at least 3): a website error must not wipe the menu. A held menu takes over after
   * 24 hours (`releaseHeldMenu`) or is replaced by a newer menu; `force` stores it anyway, valid from `effectiveDate`
   * (the business day it takes over, not the day the website sent it).
   */
  private storeMenu(record: Menu, installationId: string, now: string, force: boolean, effectiveDate = record.businessDate): 'stored' | 'held' | 'stale' {
    const before = this.menu(record.id);
    if (before && before.version >= record.version) return 'stale';
    const held = this.sql.exec<{version: number}>('SELECT version FROM menu_held WHERE id=?', record.id).toArray()[0];
    if (held && held.version >= record.version && !force) return 'stale';
    if (before && !force) {
      const ids = new Set(record.items.map(item => item.id)), removed = before.items.filter(item => !ids.has(item.id)).length;
      if (removed >= 3 && removed * 10 > before.items.length) {
        // A newer menu still without the items replaces the held one, but the 24 hours run from the first.
        this.sql.exec(`INSERT INTO menu_held VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET version=excluded.version, json=excluded.json,
          installation_id=excluded.installation_id, removed=excluded.removed, total=excluded.total`, record.id, now, record.version, JSON.stringify(record), installationId, removed, before.items.length);
        return 'held';
      }
    }
    this.sql.exec(`INSERT INTO records(type, id, version, business_date, register_id, json, installation_id, received_at) VALUES('menu',?,?,?,'',?,?,?)
      ON CONFLICT(type, id) DO UPDATE SET version=excluded.version, business_date=excluded.business_date, json=excluded.json,
      installation_id=excluded.installation_id, received_at=excluded.received_at`, record.id, record.version, effectiveDate, JSON.stringify({...record, businessDate: effectiveDate}), installationId, now);
    this.sql.exec('DELETE FROM menu_held WHERE id=?', record.id);
    for (const change of before ? menuChanges(before, record) : []) {
      this.sql.exec('INSERT INTO menu_changes VALUES(?,?,?,?,?,?,?,?,?,?)', now, effectiveDate, record.id, change.itemId, change.name, change.kind,
        change.oldCents, change.newCents, change.oldText, change.newText);
    }
    // The month's prices per category for the trend: the last menu of the month wins.
    const month = effectiveDate.slice(0, 7);
    this.sql.exec('DELETE FROM menu_months WHERE month=?', month);
    for (const part of menuOverview(record).parts) for (const category of part.categories) {
      this.sql.exec('INSERT INTO menu_months VALUES(?,?,?,?,?)', month, part.part, category.name, category.items, category.avgCents);
    }
    return 'stored';
  }

  /**
   * A held menu that nobody replaced within 24 hours was meant: it takes over (the morning run), valid from the business
   * day of the release, so the days before keep their old prices. A failure never stops the morning message.
   */
  private releaseHeldMenu(at: Date, config: TenantConfig) {
    for (const row of this.sql.exec<{id: string; json: string; installation_id: string}>('SELECT id, json, installation_id FROM menu_held WHERE held_at <= ?', new Date(at.getTime() - 86400000).toISOString()).toArray()) {
      try {
        this.ctx.storage.transactionSync(() => {
          const result = this.storeMenu(JSON.parse(row.json) as Menu, row.installation_id, at.toISOString(), true, businessDate(at, config.timeZone, config.businessDayCutoffHour));
          if (result === 'stale') this.sql.exec('DELETE FROM menu_held WHERE id=?', row.id);
        });
      } catch (error) {
        console.error('menu release failed', error instanceof Error ? error.message : 'unknown');
      }
    }
  }

  /** What is wrong with the menu's flow: a held menu, or menu batches refused over the last 7 days (to-do list, morning message). */
  private menuProblems(at: Date): string[] {
    const problems = this.sql.exec<{removed: number; total: number; held_at: string}>('SELECT removed, total, held_at FROM menu_held').toArray()
      .map(row => `Web poslal lístek bez ${row.removed} z ${row.total} položek; OKO1 drží předchozí lístek a nový převezme ráno po 24 hodinách, jestli ho web mezitím neopraví.`);
    const refused = this.sql.exec<{count: number; code: string}>("SELECT count(*) AS count, max(code) AS code FROM ingest_rejects WHERE at >= ? AND (',' || types || ',') LIKE '%,menu,%'",
      new Date(at.getTime() - 7 * 86400000).toISOString()).toArray()[0];
    if (refused.count) problems.push(`Lístek z webu OKO1 ${refused.count}× odmítlo (${refused.code}); platí poslední přijatý lístek.`);
    return problems;
  }

  /** Average base price per part and category by month (the last 12 months with a menu); the current month from the current menu. */
  private menuTrend() {
    const menu = this.menu();
    if (!menu) return null;
    const current = menu.businessDate.slice(0, 7);
    const rows = this.sql.exec<{month: string; part: string; category: string; avg_cents: number}>('SELECT month, part, category, avg_cents FROM menu_months WHERE month < ? ORDER BY month DESC LIMIT 2000', current).toArray();
    const months = [...new Set(rows.map(row => row.month))].slice(0, 11).reverse().concat(current);
    const now = menuOverview(menu);
    return {months, categories: now.parts.flatMap(part => part.categories.map(category => {
      const values = months.map(month => month === current ? category.avgCents : rows.find(row => row.month === month && row.part === part.part && row.category === category.name)?.avg_cents ?? null);
      const first = values.find(value => value !== null) ?? null;
      return {part: part.part, name: category.name, values, changePermille: first ? Math.round((category.avgCents / first - 1) * 1000) : null};
    }))};
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
    const findings = priceCheck(menu), sales = this.itemSales(addDays(day, -29), day);
    const profit = sales.length ? itemProfit(menu, sales, this.menuItemCosts()) : null;
    return {...menuOverview(menu), received: stamp(new Date(received), config.timeZone), changes: changes.rows, changesTotal: changes.total,
      priceCheck: {findings: [...findings].sort((a, b) => FINDING_RANK[a.kind] - FINDING_RANK[b.kind]).slice(0, 10), total: findings.length},
      gaps: (gaps => ({items: gaps.slice(0, 20), total: gaps.length}))(menuGaps(menu)), competitors: this.competitorCard(), trend: this.menuTrend(), problems: this.menuProblems(new Date()),
      matrix: profit ? menuMatrix(menu, profit, this.newMenuItems(addDays(day, -29), day)).map(part => ({...part, classes: part.classes.map(row => ({...row, count: row.items.length, items: row.items.slice(0, 5)}))})) : null,
      experiments: profit ? this.priceExperiments(day, 5) : null,
      profit: profit && {from: addDays(day, -29), to: day, items: profit.items.slice(0, 10), itemsTotal: profit.items.length, unpaired: profit.unpaired.slice(0, 5),
        unpairedTotal: profit.unpaired.length, totals: profit.totals, missing: profit.missing}};
  }

  /**
   * What the POS sold over some days per product (closed bills only), with revenue without VAT where every line has its
   * VAT rate. A product is its POS id, or its name when the POS sends none. A line's revenue is its share of what the bill
   * was paid (`totalCents`), so a discount on the whole bill falls on its lines in proportion (docs/ingest-v1.md).
   */
  private itemSales(from: string, to: string): ItemSale[] {
    // `product` and not `key`, `bill` and not `json`: json_each has columns of those names.
    // A product linked to a menu item by the POS (`menuItemId`) is counted per item it was linked to when sold.
    return this.sql.exec<{product: string; product_id: string | null; menu_item_id: string | null; name: string; quantity: number; gross_cents: number; net: number | null; without_vat: number}>(`
      SELECT coalesce(json_extract(i.value, '$.productId'), 'name:' || json_extract(i.value, '$.name')) AS product, max(json_extract(i.value, '$.productId')) AS product_id,
        json_extract(i.value, '$.menuItemId') AS menu_item_id,
        max(json_extract(i.value, '$.name')) AS name, sum(json_extract(i.value, '$.quantity')) AS quantity, sum(json_extract(i.value, '$.totalCents') * b.paid) AS gross_cents,
        sum(json_extract(i.value, '$.totalCents') * b.paid * 100.0 / (100 + json_extract(i.value, '$.vatRate'))) AS net,
        sum(json_extract(i.value, '$.vatRate') IS NULL) AS without_vat
      FROM (SELECT r.json AS bill, coalesce(json_extract(r.json, '$.totalCents') * 1.0
          / nullif((SELECT sum(json_extract(l.value, '$.totalCents')) FROM json_each(r.json, '$.items') l), 0), 1) AS paid
        FROM records r WHERE r.type='bill' AND r.business_date BETWEEN ? AND ? AND json_extract(r.json, '$.status') = 'closed') b, json_each(b.bill, '$.items') i
      GROUP BY product, menu_item_id ORDER BY gross_cents DESC`, from, to).toArray()
      .map(row => ({key: row.menu_item_id === null ? row.product : `${row.product} ${row.menu_item_id}`, productId: row.product_id, menuItemId: row.menu_item_id, name: row.name, quantity: Math.round(row.quantity * 1000) / 1000, grossCents: Math.round(row.gross_cents),
        netCents: row.without_vat || row.net === null ? null : Math.round(row.net)}));
  }

  /**
   * Food cost per piece of a menu item without VAT in haléře, by menu item id. Empty until the purchase prices and
   * recipes are joined to the menu (the batch „Zisk a marže“ of the Dishboard work fills it); profit by item uses it as is.
   */
  private menuItemCosts(): Map<string, number> {
    return new Map();
  }

  /** MCP: profit by menu item over some days (POS bills paired to the menu); null without a venue or a menu. */
  posItemProfit(from: string, to: string) {
    const menu = this.menu();
    if (!this.config() || !menu) return null;
    const sales = this.itemSales(from, to);
    return {from, to, bills: sales.length > 0, ...itemProfit(menu, sales, this.menuItemCosts())};
  }

  /** MCP: virtual repricing of the menu, with the revenue of the last 30 days at the same pieces sold. */
  posRepricing(input: RepricingInput) {
    const config = this.config(), menu = this.menu();
    if (!config || !menu) return null;
    const today = businessDate(new Date(), config.timeZone, config.businessDayCutoffHour), from = addDays(today, -30), to = addDays(today, -1);
    const sold = new Map<string, {quantity: number; grossCents: number; netCents: number | null}>();
    for (const sale of this.itemSales(from, to)) {
      const pairing = pairSale(menu, sale);
      if (!pairing) continue;
      const row = sold.get(pairing.itemId) ?? {quantity: 0, grossCents: 0, netCents: 0};
      sold.set(pairing.itemId, {quantity: row.quantity + sale.quantity, grossCents: row.grossCents + sale.grossCents,
        netCents: row.netCents === null || sale.netCents === null ? null : row.netCents + sale.netCents});
    }
    return {salesFrom: from, salesTo: to, ...repricing(menu, input, sold)};
  }

  /**
   * MCP: how the price of items (words of the name) went over two years: today's prices, every change (new item, price,
   * removed) oldest first, and for each change of price how it sold before and after (the experiment), once there are bills.
   */
  posPriceHistory(query: string) {
    const config = this.config(), menu = this.menu();
    if (!config || !menu) return null;
    const key = nameKey(query);
    if (!key) return {query, truncated: false, items: [], changes: []};
    const today = businessDate(new Date(), config.timeZone, config.businessDayCutoffHour);
    const matches = (name: string, group?: string | null) => nameKey(`${name} ${group ?? ''}`).includes(key);
    const items = menu.items.filter(item => matches(item.name, item.group));
    // An item found today (also by its group) brings all its changes, even under an older name; a removed one is found by name.
    const ids = new Set([...items.map(item => item.id), ...this.sql.exec<{item_id: string; name: string}>('SELECT DISTINCT item_id, name FROM menu_changes WHERE business_date >= ?', addDays(today, -730)).toArray()
      .filter(row => matches(row.name)).map(row => row.item_id)]);
    const from = addDays(today, -730), list = [...ids];
    const changes: ReturnType<typeof this.menuChangesBetween>['rows'] = [];
    for (let index = 0; index < list.length; index += 50) {
      const chunk = list.slice(index, index + 50);
      changes.push(...this.sql.exec<{business_date: string; item_id: string; name: string; kind: string; old_cents: number | null; new_cents: number | null; old_text: string | null; new_text: string | null}>(
        `SELECT * FROM menu_changes WHERE business_date >= ? AND item_id IN (${chunk.map(() => '?').join(',')})`, from, ...chunk).toArray()
        .map(row => ({date: row.business_date, itemId: row.item_id, name: row.name, kind: row.kind, oldCents: row.old_cents, newCents: row.new_cents, oldText: row.old_text, newText: row.new_text})));
    }
    changes.sort((a, b) => a.date.localeCompare(b.date));
    const priced = [...new Set(changes.filter(row => row.kind === 'price').map(row => row.itemId))];
    const experiments = priced.length ? this.priceExperiments(addDays(today, 1), 2000, {from, itemIds: priced}) : [];
    return {query, truncated: changes.length > 200,
      items: items.map(item => ({itemId: item.id, name: item.name, part: item.part, category: item.category, volume: item.volume, price: priceText(item)})),
      changes: changes.slice(-200).map(row => {
        const experiment = row.kind === 'price' ? experiments.find(entry => entry.itemId === row.itemId && entry.date === row.date && entry.newText === row.newText) : undefined;
        return {...row, ...(experiment ? {experiment} : {})};
      })};
  }

  /** Price changes whose 28 days after ended in the week up to a Sunday (Monday message): how they sold before and after. */
  private priceResults(date: string) {
    // Only the changes 27–33 days back can have ended their 28 days this week, so only their bills are read.
    return this.priceExperiments(date, 2000, {from: addDays(date, -33)}).filter(entry => entry.status === 'done' && entry.revenuePermille !== null
      && addDays(entry.date, 27) >= addDays(date, -6) && addDays(entry.date, 27) <= date);
  }

  /**
   * Menu items that barely sold over a month (at most 2 pieces), for the message about its last day: only items on the
   * menu the whole month (not added in it) and with a price, and only when the POS sent bills on at least 14 days of it.
   */
  private slowSellers(month: string, through: string) {
    const menu = this.menu();
    const days = this.sql.exec<{days: number}>("SELECT count(DISTINCT business_date) AS days FROM records WHERE type='bill' AND business_date BETWEEN ? AND ?", `${month}-01`, through).toArray()[0].days;
    if (!menu || days < 14) return null;
    const sold = new Map<string, number>();
    let all = 0, paired = 0;
    for (const sale of this.itemSales(`${month}-01`, through)) {
      const pairing = pairSale(menu, sale);
      all += sale.grossCents;
      if (pairing) { sold.set(pairing.itemId, (sold.get(pairing.itemId) ?? 0) + sale.quantity); paired += sale.grossCents; }
    }
    // When the POS names do not pair well with the menu, a missing sale may only be a missing pair: no list then.
    if (!all || paired < all * 0.9) return null;
    // Items added since the month began (also after it) are too new; a size whose other sizes sold may only be booked under them.
    const fresh = this.newMenuItems(`${month}-01`, '9999-12-31');
    const soldNames = new Set(menu.items.filter(item => (sold.get(item.id) ?? 0) > 2).map(item => nameKey(item.name)));
    const items = menu.items.filter(item => item.pricesCents[0] > 0 && !fresh.has(item.id) && (sold.get(item.id) ?? 0) <= 2 && !soldNames.has(nameKey(item.name)))
      .map(item => ({name: item.name + (item.volume ? ` ${item.volume}` : ''), quantity: Math.round((sold.get(item.id) ?? 0) * 10) / 10}))
      .sort((a, b) => a.quantity - b.quantity || a.name.localeCompare(b.name, 'cs'));
    return items.length ? {month, items} : null;
  }

  /** The menu over a month for the message about its last day: changes, and the average price per category against the month before. */
  private menuMonth(month: string): MenuMonth | null {
    const rows = this.menuChangesBetween(`${month}-01`, `${month}-31`, 5000).rows;
    const prices = rows.filter(row => row.kind === 'price' && row.oldCents !== null && row.newCents !== null);
    const last = (before: string) => this.sql.exec<{month: string | null}>('SELECT max(month) AS month FROM menu_months WHERE month <= ?', before).toArray()[0].month;
    const now = last(month), [year, number] = month.split('-').map(Number);
    const previous = last(number === 1 ? `${year - 1}-12` : `${year}-${String(number - 1).padStart(2, '0')}`);
    const categories: MenuMonth['categories'] = [];
    if (now && previous && now !== previous) {
      const read = (which: string) => new Map(this.sql.exec<{part: string; category: string; avg_cents: number}>('SELECT part, category, avg_cents FROM menu_months WHERE month=?', which).toArray()
        .map(row => [`${row.part}\u0000${row.category}`, row.avg_cents]));
      const after = read(now), before = read(previous);
      const names = [...after.keys()].map(key => key.split('\u0000')[1]);
      for (const [key, cents] of after) {
        const old = before.get(key), [part, name] = key.split('\u0000');
        // A name in two parts of the menu (Ostatní) says which.
        const label = names.filter(entry => entry === name).length > 1 ? `${name} (${PART_NAMES[part as keyof typeof PART_NAMES] ?? part})` : name;
        if (old && cents !== old) categories.push({name: label, beforeCents: old, afterCents: cents, changePermille: Math.round((cents / old - 1) * 1000)});
      }
      categories.sort((a, b) => Math.abs(b.changePermille) - Math.abs(a.changePermille) || a.name.localeCompare(b.name));
    }
    // Like the week: an item priced more times counts once, from its first old price to its last one. The base price
    // decides; when it stayed, the other sizes do (225 / 255 → 225 / 265 Kč is a rise); back where it was counts as neither.
    const byItem = new Map<string, {oldCents: number; newCents: number; oldText: string | null; newText: string | null}>();
    for (const row of prices) {
      const seen = byItem.get(row.itemId);
      byItem.set(row.itemId, seen ? {...seen, oldCents: row.oldCents ?? 0, oldText: row.oldText} : {oldCents: row.oldCents ?? 0, newCents: row.newCents ?? 0, oldText: row.oldText, newText: row.newText});
    }
    const total = (text: string | null) => pricesOfText(text).reduce((sum, cents) => sum + cents, 0);
    const sign = (row: {oldCents: number; newCents: number; oldText: string | null; newText: string | null}) =>
      Math.sign(row.newCents - row.oldCents) || Math.sign(total(row.newText) - total(row.oldText));
    const moves = [...byItem.values()].map(sign);
    const result = {month, up: moves.filter(move => move > 0).length, down: moves.filter(move => move < 0).length, added: rows.filter(row => row.kind === 'added').length, removed: rows.filter(row => row.kind === 'removed').length, categories};
    return result.up + result.down + result.added + result.removed + categories.length ? result : null;
  }

  /** Products the POS charged on a day at a price the menu did not have then (to-do list and morning message). */
  private priceMismatchesOn(date: string) {
    const menu = this.menu();
    if (!menu) return [];
    const lines = this.sql.exec<{name: string; menu_item_id: string | null; unit: number; quantity: number}>(`
      SELECT json_extract(i.value, '$.name') AS name, json_extract(i.value, '$.menuItemId') AS menu_item_id, CAST(round(json_extract(i.value, '$.totalCents') * 1.0 / json_extract(i.value, '$.quantity')) AS INTEGER) AS unit,
        sum(json_extract(i.value, '$.quantity')) AS quantity
      FROM records r, json_each(r.json, '$.items') i
      WHERE r.type='bill' AND r.business_date=? AND json_extract(r.json, '$.status') = 'closed' AND json_extract(i.value, '$.quantity') > 0 GROUP BY 1, 2, 3`, date).toArray();
    if (!lines.length) return [];
    // Every price an item had before a change made that day or later was still right that day (all sizes, from the old text).
    const earlier = new Map<string, number[]>();
    for (const row of this.sql.exec<{item_id: string; old_text: string | null}>("SELECT item_id, old_text FROM menu_changes WHERE kind='price' AND business_date >= ?", date).toArray()) {
      earlier.set(row.item_id, [...(earlier.get(row.item_id) ?? []), ...pricesOfText(row.old_text)]);
    }
    return priceMismatches(menu, lines.map(row => ({name: row.name, menuItemId: row.menu_item_id, unitCents: row.unit, quantity: Math.round(row.quantity * 1000) / 1000})), earlier);
  }

  private competitors(): CompetitorPrices | null {
    const row = this.sql.exec<{json: string}>('SELECT json FROM competitor_prices WHERE id=1').toArray()[0];
    return row ? JSON.parse(row.json) as CompetitorPrices : null;
  }

  /** Our prices against the venues nearby: the date they were read, the parts of the menu and one row per compared item; null before the first set. */
  private competitorCard() {
    const data = this.competitors();
    if (!data) return null;
    const rows = competitorComparison(this.menu(), data);
    return {checkedOn: data.checkedOn, scope: data.scope ?? null, venues: data.venues.map(venue => ({name: venue.name, area: venue.area, kind: venue.kind, url: venue.url, note: venue.note, items: venue.items.length})),
      sections: competitorSections(rows), rows};
  }

  /** Monday message, in the week after the prices nearby were read: the parts of the menu and the items furthest from their median. */
  private competitorSummary(date: string) {
    const card = this.competitorCard();
    if (!card || card.checkedOn > date || card.checkedOn < addDays(date, -6)) return null;
    const rows = card.rows.filter(row => row.diffPct !== null);
    return {checkedOn: card.checkedOn, venues: card.venues.filter(venue => venue.items).length, compared: rows.length, sections: card.sections.filter(section => section.compared),
      above: rows.filter(row => row.diffPct! >= COMPETITOR_SHARE).sort((a, b) => b.diffPct! - a.diffPct!),
      below: rows.filter(row => row.diffPct! <= -COMPETITOR_SHARE).sort((a, b) => a.diffPct! - b.diffPct!)};
  }

  /** Monday message: how many prices to look at and the two weighing most (cheap and expensive items before gaps). */
  private priceCheckSummary() {
    const menu = this.menu();
    if (!menu) return null;
    const findings = priceCheck(menu);
    return {total: findings.length, top: [...findings].sort((a, b) => FINDING_RANK[a.kind] - FINDING_RANK[b.kind]).slice(0, 2)};
  }

  /** Monday message: what to fix in the menu on the website, by kind with the first names; null when nothing. */
  private menuGapsSummary() {
    const menu = this.menu();
    const gaps = menu ? menuGaps(menu) : [];
    if (!gaps.length) return null;
    const kinds = [...new Set(gaps.map(gap => gap.kind))].map(kind => {
      const rows = gaps.filter(gap => gap.kind === kind);
      return {kind, count: rows.length, names: rows.map(gap => gap.name)};
    });
    return {total: gaps.length, kinds};
  }

  /** Menu items added in `from`–`to`: too new for the matrix, which compares days of sales. */
  private newMenuItems(from: string, to: string) {
    return new Set(this.sql.exec<{item_id: string}>("SELECT item_id FROM menu_changes WHERE kind='added' AND business_date BETWEEN ? AND ?", from, to).toArray().map(row => row.item_id));
  }

  /**
   * Every price change of the year up to a day as an experiment: pieces and revenue per day 28 days before the change
   * (not before the first POS bill) against the days after it (up to 28, until the day). One read of the bills for all
   * changes; only once the POS sends bills; newest first.
   */
  private priceExperiments(day: string, limit: number, only?: {from: string; itemIds?: string[]}) {
    const menu = this.menu();
    const first = this.sql.exec<{d: string | null}>("SELECT min(business_date) AS d FROM records WHERE type='bill'").toArray()[0].d;
    if (!menu || !first) return [];
    // `only`: the changes of some items from a day on (the price history of one item), so the bills read cover just those.
    const changes = this.sql.exec<{business_date: string; item_id: string; name: string; old_text: string | null; new_text: string | null}>(
      `SELECT business_date, item_id, name, old_text, new_text FROM menu_changes WHERE kind='price' AND business_date BETWEEN ? AND ?${only?.itemIds ? ` AND item_id IN (${only.itemIds.map(() => '?').join(',')})` : ''}
        ORDER BY business_date DESC, rowid DESC LIMIT ?`,
      only ? only.from : addDays(day, -365), day, ...(only?.itemIds ?? []), limit).toArray();
    if (!changes.length) return [];
    const from = addDays(changes.map(change => change.business_date).sort()[0], -28);
    const byItem = this.dailyItemSales(menu, from, day);
    const window = (itemId: string, start: string, end: string) => {
      const rows = (byItem.get(itemId) ?? []).filter(row => row.date >= start && row.date <= end);
      return {days: end < start ? 0 : Math.round((Date.parse(end) - Date.parse(start)) / 86400000) + 1,
        quantity: Math.round(rows.reduce((sum, row) => sum + row.quantity, 0) * 1000) / 1000, grossCents: Math.round(rows.reduce((sum, row) => sum + row.grossCents, 0))};
    };
    return changes.map(change => {
      const beforeStart = [addDays(change.business_date, -28), first].sort()[1];
      const after = window(change.item_id, change.business_date, [addDays(change.business_date, 27), day].sort()[0]);
      return priceExperiment({date: change.business_date, itemId: change.item_id, name: change.name, oldText: change.old_text, newText: change.new_text},
        window(change.item_id, beforeStart, addDays(change.business_date, -1)), after);
    });
  }

  /** Pieces and revenue per day and menu item over some days (closed bills, each product name paired with the menu once). */
  private dailyItemSales(menu: Menu, from: string, to: string) {
    const daily = this.sql.exec<{date: string; name: string; menu_item_id: string | null; quantity: number; gross_cents: number}>(`
      SELECT b.date, json_extract(i.value, '$.name') AS name, json_extract(i.value, '$.menuItemId') AS menu_item_id, sum(json_extract(i.value, '$.quantity')) AS quantity, sum(json_extract(i.value, '$.totalCents') * b.paid) AS gross_cents
      FROM (SELECT r.business_date AS date, r.json AS bill, coalesce(json_extract(r.json, '$.totalCents') * 1.0
          / nullif((SELECT sum(json_extract(l.value, '$.totalCents')) FROM json_each(r.json, '$.items') l), 0), 1) AS paid
        FROM records r WHERE r.type='bill' AND r.business_date BETWEEN ? AND ? AND json_extract(r.json, '$.status') = 'closed') b, json_each(b.bill, '$.items') i
      GROUP BY 1, 2, 3`, from, to).toArray();
    const totals = new Map<string, {name: string; menuItemId: string | null; quantity: number; grossCents: number}>(), byItem = new Map<string, {date: string; quantity: number; grossCents: number}[]>();
    const keyOf = (row: {name: string; menu_item_id: string | null}) => JSON.stringify([row.name, row.menu_item_id]);
    for (const row of daily) {
      const total = totals.get(keyOf(row)) ?? {name: row.name, menuItemId: row.menu_item_id, quantity: 0, grossCents: 0};
      totals.set(keyOf(row), {...total, quantity: total.quantity + row.quantity, grossCents: total.grossCents + row.gross_cents});
    }
    const paired = new Map([...totals].map(([key, total]) => [key, pairSale(menu, total)?.itemId ?? null]));
    for (const row of daily) {
      const itemId = paired.get(keyOf(row));
      if (itemId) byItem.set(itemId, [...(byItem.get(itemId) ?? []), {date: row.date, quantity: row.quantity, grossCents: row.gross_cents}]);
    }
    return byItem;
  }

  /**
   * Dashboard: one menu item over 26 weeks (Monday to Sunday, the last one up to today): its base price at the end of each
   * week and the pieces and revenue sold. `query` = words of the name; `itemId` picks one of the matches (else the first).
   */
  posItemTrend(query: string, itemId: string | null) {
    const config = this.config(), menu = this.menu();
    if (!config || !menu) return null;
    const key = nameKey(query);
    const matches = key ? menu.items.filter(item => nameKey(`${item.name} ${item.group ?? ''}`).includes(key)).slice(0, 20) : [];
    const item = matches.find(entry => entry.id === itemId) ?? matches[0];
    const list = matches.map(entry => ({itemId: entry.id, name: entry.name, volume: entry.volume, price: priceText(entry)}));
    if (!item) return {query, matches: list, item: null, weeks: []};
    const today = businessDate(new Date(), config.timeZone, config.businessDayCutoffHour);
    const monday = addDays(today, -((weekday(today) + 6) % 7)), first = addDays(monday, -25 * 7);
    const changes = this.sql.exec<{business_date: string; old_cents: number | null}>("SELECT business_date, old_cents FROM menu_changes WHERE item_id=? AND kind='price' AND business_date > ? ORDER BY business_date, rowid",
      item.id, first).toArray();
    // Weeks that ended before the item came onto the menu have no price.
    const added = this.sql.exec<{d: string | null}>("SELECT max(business_date) AS d FROM menu_changes WHERE item_id=? AND kind='added'", item.id).toArray()[0].d;
    const sales = this.dailyItemSales(menu, first, today).get(item.id) ?? [];
    const weeks = Array.from({length: 26}, (_, index) => {
      const start = addDays(first, index * 7), end = [addDays(start, 6), today].sort()[0];
      // The price at the end of the week: the old price of the first change after it, else today's.
      const later = changes.find(change => change.business_date > end);
      const rows = sales.filter(row => row.date >= start && row.date <= end);
      return {week: start, priceCents: added && end < added ? null : later ? later.old_cents : item.pricesCents[0],
        quantity: Math.round(rows.reduce((sum, row) => sum + row.quantity, 0) * 1000) / 1000, grossCents: Math.round(rows.reduce((sum, row) => sum + row.grossCents, 0))};
    });
    return {query, matches: list, item: {itemId: item.id, name: item.name, category: item.category, volume: item.volume, price: priceText(item)}, weeks,
      hasSales: sales.length > 0};
  }

  /** MCP: menu engineering over some days and how the price changes of the year went. */
  posMenuEngineering(from: string, to: string) {
    const menu = this.menu();
    if (!this.config() || !menu) return null;
    const sales = this.itemSales(from, to);
    return {from, to, bills: sales.length > 0, matrix: sales.length ? menuMatrix(menu, itemProfit(menu, sales, this.menuItemCosts()), this.newMenuItems(from, to)) : [],
      experiments: this.priceExperiments(to, 50)};
  }

  /** MCP: prices to look at in each category of the menu, each with a suggested price. */
  posPriceCheck() {
    const menu = this.menu();
    return this.config() && menu ? {items: menu.items.length, findings: priceCheck(menu), webGaps: menuGaps(menu), competitors: this.competitorCard()} : null;
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

  /**
   * Supplier invoices issued in `from`–`to` that count: not cancelled, not from a switched-off sender (`disabledSources`).
   * With `unpaidOnly`, every unpaid invoice with a due date, whenever it was issued.
   */
  private invoices(config: TenantConfig, from: string, to: string, unpaidOnly = false): SupplierInvoice[] {
    const rows = unpaidOnly
      ? this.sql.exec<{json: string}>("SELECT json FROM records WHERE type='supplier_invoice' AND json_extract(json, '$.dueDate') IS NOT NULL AND json_extract(json, '$.paidDate') IS NULL").toArray()
      : this.sql.exec<{json: string}>("SELECT json FROM records WHERE type='supplier_invoice' AND business_date BETWEEN ? AND ?", from, to).toArray();
    return counted(rows.map(row => JSON.parse(row.json) as SupplierInvoice), config.disabledSources);
  }

  /** Revenue with VAT over `from`–`to` and the days that have it (POS, managers' report or imported history). */
  private revenueBetween(from: string, to: string) {
    let revenueCents = 0, revenueDays = 0;
    for (let day = from; day <= to; day = addDays(day, 1)) {
      const revenue = this.dayRevenue(day);
      if (revenue !== null) { revenueCents += revenue; revenueDays++; }
    }
    return {revenueCents, revenueDays};
  }

  /** Morning message: purchases of the month up to the day, rises of its last 7 days (against a year of purchases), overdue invoices. */
  private supplyBriefFor(config: TenantConfig, date: string) {
    const year = this.invoices(config, addDays(date, -365), date);
    const unpaid = this.invoices(config, '', '', true).filter(invoice => !year.some(other => other.id === invoice.id));
    const payoutsCents = this.reportSums('payout', date.slice(0, 8) + '01', date).reduce((sum, row) => sum + row.amountCents, 0);
    return supplyBrief([...year, ...unpaid], date, this.revenueBetween(date.slice(0, 8) + '01', date), {payoutsCents, menu: this.menu()});
  }

  /** Dashboard: the month up to the shown day, rises over its 30 days, invoices overdue the day after, and which senders are off. */
  private suppliesCard(config: TenantConfig, day: string) {
    const year = this.invoices(config, addDays(day, -365), day);
    const overdue = overdueInvoices(this.invoices(config, '', '', true), addDays(day, 1));
    if (!year.length && !overdue.length) return null;
    const revenue = this.revenueBetween(day.slice(0, 8) + '01', day), month = supplySummary(year, day.slice(0, 8) + '01', day, revenue);
    const payoutsCents = this.reportSums('payout', day.slice(0, 8) + '01', day).reduce((sum, row) => sum + row.amountCents, 0);
    const menu = this.menu(), margins = menu ? drinkMargins(menu, year, day) : null;
    return {month, rises: priceRises(year, addDays(day, -29), day).slice(0, 15), overdue: overdue.slice(0, 15), overdueCount: overdue.length,
      overdueCents: overdue.reduce((sum, row) => sum + row.grossCents, 0), disabled: config.disabledSources,
      duplicates: duplicateInvoices(year.filter(invoice => invoice.businessDate >= addDays(day, -34))).slice(0, 10),
      result: revenue.revenueDays ? {revenueCents: revenue.revenueCents, purchasesCents: month.netCents, payoutsCents, resultCents: revenue.revenueCents - month.netCents - payoutsCents} : null,
      margins: margins ? {rows: margins.margins.slice(0, 30), paired: margins.margins.length, unpaired: margins.unpaired} : null};
  }

  /** MCP: purchases over any stretch of days (at most 400) with price rises in it, invoices overdue today and the invoices themselves. */
  posSupplies(from: string, to: string) {
    const config = this.config();
    if (!config) return null;
    const history = this.invoices(config, addDays(from, -365), to), invoices = history.filter(invoice => invoice.businessDate >= from);
    const today = businessDate(new Date(), config.timeZone, config.businessDayCutoffHour);
    const menu = this.menu();
    return {summary: supplySummary(invoices, from, to, this.revenueBetween(from, to)), rises: priceRises(history, from, to),
      duplicates: duplicateInvoices(invoices), drinkMargins: menu ? drinkMargins(menu, history, to) : null,
      overdue: overdueInvoices(this.invoices(config, '', '', true), today), disabledSources: config.disabledSources,
      invoices: invoices.sort((a, b) => b.businessDate.localeCompare(a.businessDate)).slice(0, 1000), truncated: invoices.length > 1000};
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
  /** While set, each day's revenue is worked out once (long periods read the same days many times). */
  private revenueMemo: Map<string, number | null> | null = null;

  private dayRevenue(date: string): number | null {
    if (this.revenueMemo?.has(date)) return this.revenueMemo.get(date)!;
    const revenue = this.dayRevenueUncached(date);
    this.revenueMemo?.set(date, revenue);
    return revenue;
  }

  private dayRevenueUncached(date: string): number | null {
    const bills = this.sql.exec<{count: number; total: number | null}>(`SELECT count(*) AS count, SUM(json_extract(json, '$.totalCents')) AS total
      FROM records WHERE type='bill' AND business_date=? AND json_extract(json, '$.status') = 'closed'`, date).toArray()[0];
    if (bills.count) return bills.total ?? 0;
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
    // A cancellation is late when the booking last changed (`version`, ms) in the 24 hours before its start (not after it: a no-show cancelled later).
    const booked = this.sql.exec<Record<'reservations' | 'guests' | 'noShows' | 'noShowGuests' | 'webConfirmed' | 'cancelled' | 'lateCancelled' | 'lateCancelledGuests', number | null>>(`SELECT
        SUM(status = 'confirmed') AS reservations, SUM(CASE WHEN status = 'confirmed' THEN size ELSE 0 END) AS guests,
        SUM(status = 'confirmed' AND arrival = 'no_show') AS noShows, SUM(CASE WHEN status = 'confirmed' AND arrival = 'no_show' THEN size ELSE 0 END) AS noShowGuests,
        SUM(status = 'confirmed' AND source = 'web') AS webConfirmed, SUM(status = 'cancelled') AS cancelled,
        SUM(status = 'cancelled' AND late) AS lateCancelled, SUM(CASE WHEN status = 'cancelled' AND late THEN size ELSE 0 END) AS lateCancelledGuests
      FROM (SELECT json_extract(json, '$.status') AS status, json_extract(json, '$.partySize') AS size, json_extract(json, '$.arrival') AS arrival,
        json_extract(json, '$.source') AS source,
        json_extract(json, '$.version') >= ${VERSION_AS_TIME} AND json_extract(json, '$.version') - (julianday(json_extract(json, '$.startsAt')) - 2440587.5) * 86400000 BETWEEN -86400000 AND 0 AS late
        FROM records WHERE type='reservation' AND business_date BETWEEN ? AND ?)`, from, to).toArray()[0];
    for (const key of ['reservations', 'guests', 'noShows', 'noShowGuests', 'webConfirmed', 'cancelled', 'lateCancelled', 'lateCancelledGuests'] as const) part[key] = booked?.[key] ?? 0;
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
      const rows = this.sectionRows(date);
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
    // Public holidays are out of the weekday averages: they have their own factor.
    const history = Array.from({length: 7}, (_, day) => window.filter(entry => weekday(entry) === day && !holidayName(entry)).map(revenue).filter((value): value is number => value !== null));
    // A weekday with no revenue in 4 weeks while at least 4 others have it counts as closed (0), so it does not blank the sums.
    const open = history.filter(values => values.length >= 2).length;
    const bases = history.map(values => !values.length && open >= 4 ? 0 : planFrom(values.map(revenueCents => ({revenueCents})))?.revenueCents ?? null);
    const average = (dates: string[]) => {
      // Holidays have their own factor: last year's month averages leave them out, so they do not count twice.
      const values = dates.filter(entry => !holidayName(entry)).map(revenue).filter((value): value is number => value !== null);
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
    // A day against the other same weekdays of its month (up to the reported day) that are not like it, at least 2 with revenue:
    // the forecast's seasons go by month, so a change between months does not read as the day's own effect.
    const against = (day: string, unlike: (entry: string) => boolean) => {
      const plain = [-28, -21, -14, -7, 7, 14, 21, 28].map(shift => addDays(day, shift))
        .filter(entry => entry.slice(0, 7) === day.slice(0, 7) && entry <= date && unlike(entry)).map(revenue).filter((value): value is number => value !== null);
      const made = revenue(day), base = planFrom(plain.map(revenueCents => ({revenueCents})));
      return made !== null && base && base.revenueCents > 0 ? made / base.revenueCents : null;
    };
    // Public holidays: the same holiday last year against its weekdays; without it, the median of the holidays over the past year (at least 3).
    const plainOf = (entry: string) => !holidayName(entry) && !eventDates.has(entry);
    const known = Array.from({length: 365}, (_, i) => addDays(date, -i)).filter(entry => holidayName(entry))
      .map(entry => against(entry, plainOf)).filter((value): value is number => value !== null);
    const usualHoliday = known.length >= 3 ? medianOf(known) : null;
    const holidays: Record<string, {name: string; factor: number | null}> = {};
    // From the 1st of the month: an elapsed day without data is estimated in the month total too.
    for (let day = month + '-01'; day <= addDays(month + '-01', 62); day = addDays(day, 1)) {
      const name = holidayName(day);
      if (!name) continue;
      // The same holiday last year by its name (Easter moves, a leap year shifts the dates).
      const lastYear = Object.entries(czechHolidays(Number(day.slice(0, 4)) - 1)).find(([, other]) => other === name)?.[0];
      const ratio = lastYear !== undefined && lastYear <= date ? against(lastYear, plainOf) : null;
      const factor = ratio ?? usualHoliday;
      holidays[day] = {name, factor: factor === null ? null : Math.round(Math.min(2, Math.max(0, factor)) * 100) / 100};
    }
    // Rain: past rainy days (5 mm and more, by the weather kept for each day) against their weekdays without rain, half a year back.
    const rainy = new Set(this.sql.exec<{date: string}>("SELECT date FROM weather WHERE date BETWEEN ? AND ? AND json_extract(json, '$.rainMm') >= ?",
      addDays(date, -182 - 56), date, RAIN_MM).toArray().map(row => row.date));
    const rainRatios = [...rainy].filter(day => day >= addDays(date, -182) && !holidayName(day) && !eventDates.has(day))
      .map(day => against(day, other => !rainy.has(other) && !holidayName(other) && !eventDates.has(other))).filter((value): value is number => value !== null);
    const result = forecast({today, bases, seasonal, monthActual: {cents, days, missing}, bookings, weather, accuracy, events, eventFactor: eventFactor(ratios),
      holidays, rainFactor: rainFactor(rainRatios)});
    // Each forecast day split by section with the shares of its weekday over the 8 weeks up to the reported day (at least 2 days with sections).
    const config = this.config();
    if (config) {
      const shares = Array.from({length: 7}, (_, day) => {
        const totals = new Map<string, number>();
        let known = 0;
        for (const entry of Array.from({length: 56}, (_, i) => addDays(date, -i)).filter(entry => weekday(entry) === day)) {
          const rows = this.sectionRows(entry);
          if (!rows.length) continue;
          known++;
          for (const row of rows) totals.set(row.key, (totals.get(row.key) ?? 0) + row.amountCents);
        }
        const sum = [...totals.values()].reduce((total, cents) => total + cents, 0);
        return known >= 2 && totals.size > 1 && sum > 0 ? [...totals].map(([section, cents]) => ({section, share: cents / sum})) : null;
      });
      const order = Object.keys(config.sections);
      for (const day of result.days) {
        const split = shares[weekday(day.date)];
        if (!split || !day.cents) continue;
        const rows = split.map(row => ({section: row.section, label: Object.hasOwn(config.sections, row.section) ? config.sections[row.section] : row.section, cents: Math.round(day.cents! * row.share)}))
          .sort((a, b) => (order.indexOf(a.section) + 1 || 99) - (order.indexOf(b.section) + 1 || 99) || a.section.localeCompare(b.section));
        // Rounding goes to the largest section, so the parts add up to the day.
        const largest = rows.reduce((top, row) => row.cents > top.cents ? row : top, rows[0]);
        largest.cents += day.cents - rows.reduce((total, row) => total + row.cents, 0);
        day.bySection = rows;
      }
    }
    return result;
  }

  /** A day's revenue by section: POS bills, else the managers' report; none for a day known only from the imported history. */
  private sectionRows(date: string): {key: string; amountCents: number}[] {
    const bills = this.sql.exec<{key: string; amount_cents: number}>(`SELECT json_extract(json, '$.section') AS key, SUM(json_extract(json, '$.totalCents')) AS amount_cents
      FROM records WHERE type='bill' AND business_date=? AND json_extract(json, '$.status') = 'closed' GROUP BY key`, date).toArray().map(row => ({key: row.key, amountCents: row.amount_cents}));
    return bills.length ? bills
      : this.sql.exec<{key: string; amount_cents: number}>("SELECT key, amount_cents FROM report_lines WHERE business_date=? AND kind='revenue_section'", date).toArray()
        .map(row => ({key: row.key, amountCents: row.amount_cents}));
  }

  /** Events of the half year up to a day ranked by how many guests they drew against usual same weekdays (MCP, dashboard, briefing). */
  private eventRanking(date: string): EventRank[] {
    const outer = this.revenueMemo;
    this.revenueMemo ??= new Map();
    try { return rankEvents(this.eventReviews(addDays(date, -181), date)); } finally { this.revenueMemo = outer; }
  }

  /** The menu's changes over the 7 days (Monday message) or the one day (other days) up to a day. */
  private menuWeek(date: string, days = 7): MenuWeek | null {
    const rows = this.menuChangesBetween(addDays(date, 1 - days), date, 500).rows;
    if (!rows.length) return null;
    // Newest first: an item priced twice in the week shows once, from its first old price to its latest one.
    const prices = new Map<string, {name: string; oldText: string | null; newText: string | null}>();
    for (const row of rows.filter(row => row.kind === 'price')) {
      const seen = prices.get(row.itemId);
      prices.set(row.itemId, seen ? {...seen, oldText: row.oldText} : {name: row.name, oldText: row.oldText, newText: row.newText});
    }
    return {prices: [...prices.values()],
      added: rows.filter(row => row.kind === 'added').map(row => row.name), removed: rows.filter(row => row.kind === 'removed').map(row => row.name)};
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

  /** Twelve weeks up to the shown day, oldest first: the week's sums and how far the morning forecasts were from the revenue. */
  private trends(date: string) {
    return Array.from({length: 12}, (_, i) => 11 - i).map(back => {
      const to = addDays(date, -7 * back), from = addDays(to, -6), part = this.weekPart(from, to);
      // The plans the morning messages gave against the revenue; a week's error shows from 4 such days.
      // Up to the day before the shown one: its revenue may still be incomplete.
      const rows = this.sql.exec<{day: string; cents: number}>('SELECT for_date AS day, cents FROM forecast_log WHERE horizon=0 AND for_date BETWEEN ? AND ? AND for_date < ? AND cents > 0', from, to, date).toArray()
        .map(row => ({forecast: row.cents, actual: this.dayRevenue(row.day)})).filter((row): row is {forecast: number; actual: number} => row.actual !== null);
      return {from, to, revenueCents: part.revenueCents, revenueDays: part.revenueDays, reservations: part.reservations, guests: part.guests, noShowGuests: part.noShowGuests,
        visits: part.visits, webSent: part.webSent, webConfirmed: part.webConfirmed, reviews: part.reviews, starsTenths: part.starsTenths,
        errorPermille: rows.length >= 4 ? Math.round(rows.reduce((sum, row) => sum + Math.abs(row.actual - row.forecast) / row.forecast, 0) / rows.length * 1000) : null};
    });
  }

  /** The website's days (web traffic records, oldest first, the first one of a day) between two days. */
  private webDays(from: string, to: string): WebTraffic[] {
    return this.sql.exec<{json: string}>("SELECT json FROM records WHERE type='web_traffic' AND business_date BETWEEN ? AND ? ORDER BY business_date, id", from, to).toArray()
      .map(row => JSON.parse(row.json) as WebTraffic);
  }

  /** Interest in the menu on the website: the 7 days up to the reported day against the 7 before. */
  private menuInterestWeek(date: string) {
    const days = this.webDays(addDays(date, -13), date);
    return {current: sumMenuInterest(days, addDays(date, -6), date), previous: sumMenuInterest(days, addDays(date, -13), addDays(date, -7))};
  }

  /** Interest in the menu on the website over twelve weeks up to the shown day, oldest first (weeks as in `trends`). */
  private menuInterestWeeks(date: string): MenuInterest[] {
    const days = this.webDays(addDays(date, -83), date);
    return Array.from({length: 12}, (_, i) => 11 - i).map(back => {
      const to = addDays(date, -7 * back);
      return sumMenuInterest(days, addDays(to, -6), to);
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
    // Cancelled bookings of past days count as booked between their creation and their cancellation (the booking's last change, `version` in ms).
    const rows = new Map<string, {part: DayPart; size: number; created: number | null; cancelled: number | null}[]>();
    for (const row of this.sql.exec<{day: string; starts: string; size: number | null; created: string | null; status: string; version: number}>(`SELECT business_date AS day,
        json_extract(json, '$.startsAt') AS starts, json_extract(json, '$.partySize') AS size, json_extract(json, '$.createdAt') AS created,
        json_extract(json, '$.status') AS status, json_extract(json, '$.version') AS version
      FROM records WHERE type='reservation' AND business_date BETWEEN ? AND ? AND (json_extract(json, '$.status') = 'confirmed'
        OR (json_extract(json, '$.status') = 'cancelled' AND business_date < ?))`, addDays(today, -56), addDays(today, 6), today)) {
      // A cancellation counts only with the time of booking and a version that is a time in ms (docs/ingest-v1.md); otherwise as before: left out.
      if (row.status === 'cancelled' && (!row.created || !(row.version >= VERSION_AS_TIME))) continue;
      const list = rows.get(row.day) ?? [];
      list.push({part: dayPart(localTime(new Date(row.starts), config.timeZone).hour), size: row.size ?? 0, created: row.created ? Date.parse(row.created) : null,
        cancelled: row.status === 'cancelled' ? row.version : null});
      rows.set(row.day, list);
    }
    const sum = (list: {part: DayPart; size: number}[]) => list.reduce((parts, row) => { parts[row.part] += row.size; return parts; }, empty());
    const kept = <T extends {cancelled: number | null}>(list: T[]) => list.filter(row => row.cancelled === null);
    const days = [0, 1, 2, 3, 4, 5, 6].map(ahead => {
      const day = addDays(today, ahead);
      // Past days count only when most of their guests have the time of booking (older data has none, it would show no later bookings).
      const past = [1, 2, 3, 4, 5, 6, 7, 8].map(back => ({back, list: rows.get(addDays(day, -7 * back)) ?? []}))
        .filter(({list}) => kept(list).length > 0 && 2 * kept(list).filter(row => row.created !== null).reduce((guests, row) => guests + row.size, 0) >= kept(list).reduce((guests, row) => guests + row.size, 0))
        .map(({back, list}) => {
          // The same moment before that day as now is before this one (same local clock time).
          const moment = sameClockDaysBefore(now, 7 * back, config.timeZone);
          return {final: sum(kept(list)), early: sum(list.filter(row => (row.created === null || row.created <= moment) && (row.cancelled === null || row.cancelled > moment)))};
        });
      return guestOutlookDay(day, sum(kept(rows.get(day) ?? [])), past);
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
  /** The dashboard's "Připojit OneDrive": shown when the folder is set, OKO1 has its Microsoft app and no working access. */
  private onedriveStatus(config: TenantConfig) {
    if (!config.reportsLink) return null;
    const row = this.sql.exec<{connected_at: string; error: string | null}>('SELECT connected_at, error FROM onedrive_access WHERE id=1').toArray()[0];
    return {canConnect: !!this.env.ONEDRIVE_CLIENT_ID, connected: !!row && !row.error, since: row ? stamp(new Date(row.connected_at), config.timeZone) : null, error: row?.error ?? null};
  }

  private sources(config: TenantConfig) {
    const at = (value: string | null) => value ? stamp(new Date(value), config.timeZone) : null;
    const names: Record<string, string> = {bill: 'Účty z pokladny', cash_closing: 'Uzávěrky pokladen', bottle_check: 'Kontrola lahví', reservation: 'Rezervace', web_traffic: 'Návštěvnost webu', review_summary: 'Recenze', event: 'Akce podniku', menu: 'Jídelní a nápojový lístek', supplier_invoice: 'Faktury dodavatelů'};
    const report = this.sql.exec<{at: string; found: number}>('SELECT at, found FROM report_fetches ORDER BY at DESC LIMIT 1').toArray()[0];
    const cost = this.sql.exec<{at: string; error: string | null}>('SELECT at, error FROM cost_fetches ORDER BY at DESC LIMIT 1').toArray()[0];
    return {
      senders: this.senders(new Date()).map(row => ({name: row.name, lastSeen: stamp(row.at, config.timeZone), silent: row.silent})),
      types: this.sql.exec<{type: string; last: string}>('SELECT type, max(received_at) AS last FROM records GROUP BY type ORDER BY type').toArray()
        .map(row => ({name: names[row.type] ?? row.type, lastReceived: at(row.last)})),
      report: report ? {at: at(report.at), found: report.found === 1} : null,
      costs: cost ? {at: at(cost.at), ok: !cost.error} : null,
      onedrive: this.onedriveStatus(config),
    };
  }

  private briefingFor(config: TenantConfig, date: string, incomplete: boolean, now = new Date()) {
    const guestOutlook = this.guestOutlook(config, date, now);
    const planHistory = [7, 14, 21, 28].map(days => this.dayRevenue(addDays(date, -days))).filter((value): value is number => value !== null).map(revenueCents => ({revenueCents}));
    const briefing = buildBriefing({businessDate: date, config, bills: this.day<Bill>('bill', date), closings: this.day<CashClosing>('cash_closing', date),
      bottleChecks: this.day<BottleCheck>('bottle_check', date), planHistory, incomplete, report: this.report(date), notes: this.notes(date),
      reservations: this.day<Reservation>('reservation', date), reservationsToday: this.day<Reservation>('reservation', addDays(date, 1)),
      web: this.day<WebTraffic>('web_traffic', date)[0], webLastWeek: this.day<WebTraffic>('web_traffic', addDays(date, -7))[0],
      webUsual: [7, 14, 21, 28].map(back => this.day<WebTraffic>('web_traffic', addDays(date, -back))[0]).filter((web): web is WebTraffic => !!web)
        .map(web => ({visits: web.visits, sent: web.actions['rezervace-odeslana'] ?? 0, ...(web.menu ? {menuVisits: web.menu.visits} : {})})),
      reviews: this.day<ReviewSummary>('review_summary', date)[0],
      week: weekday(date) === 0 ? this.week(date) : null, silent: this.silentSources(config, date, now),
      month: weekday(date) === 0 || addDays(date, 1).endsWith('-01') ? this.month(config, date) : null,
      lastWeekRevenueCents: this.dayRevenue(addDays(date, -7)), discountHistory: this.discountHistory(date),
      ...this.outlookHistory(addDays(date, 1)), noShowHistory: this.noShowHistory(date), forecast: this.forecast(date), pendingAhead: this.pendingAhead(config, date, now), events: this.todayEvents(config, addDays(date, 1)), guestOutlook,
      // The ranking only when it is shown: tips for weak days, and the message about a month's last day.
      eventRanking: guestOutlook?.days.some(day => day.weak) || addDays(date, 1).endsWith('-01') ? this.eventRanking(date) : null,
      menuWeek: weekday(date) === 0 ? this.menuWeek(date) : null, menuMonth: addDays(date, 1).endsWith('-01') ? this.menuMonth(date.slice(0, 7)) : null,
      slowSellers: addDays(date, 1).endsWith('-01') ? this.slowSellers(date.slice(0, 7), date) : null, priceResults: weekday(date) === 0 ? this.priceResults(date) : [], menuDay: weekday(date) === 0 ? null : this.menuWeek(date, 1), priceMismatches: this.priceMismatchesOn(date),
      menuProblems: this.menuProblems(now),
      priceCheck: weekday(date) === 0 ? this.priceCheckSummary() : null,
      menuGaps: weekday(date) === 0 ? this.menuGapsSummary() : null,
      menuInterest: weekday(date) === 0 ? this.menuInterestWeek(date) : null,
      competitors: weekday(date) === 0 ? this.competitorSummary(date) : null,
      menuByLanguage: weekday(date) === 0 ? sumMenuInterest(this.webDays(addDays(date, -27), date), addDays(date, -27), date) : null,
      forecastPlanCents: this.loggedPlan(date), todayPlanCents: this.loggedPlan(addDays(date, 1)),
      supplies: this.supplyBriefFor(config, date),
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
    this.releaseHeldMenu(at, config);
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
        // Past days are kept (a year): the last forecast for a day stands for its weather when rain is weighed.
        this.sql.exec('DELETE FROM weather WHERE date < ?', addDays(localTime(at, config.timeZone).date, -400));
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
  'v1/ingest': ['POST'], 'v1/menu': ['GET'], 'admin/config': ['GET', 'PUT'], 'admin/pair': ['POST'], 'admin/history': ['POST'],
  'admin/briefing': ['GET'], 'admin/briefings': ['GET'], 'admin/tick': ['POST'], 'admin/report': ['GET', 'PUT'], 'admin/fetch': ['POST'], 'admin/logout': ['POST'],
  'admin/web': ['GET'], 'admin/ingest': ['GET'], 'admin/competitors': ['GET', 'PUT'],
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
    const token = cookie(request);
    if (!known || !await stub.validSession(token)) return json(failure('UNAUTHORIZED', 401));
    // The browser keeps the cookie as long as the server keeps the session: each visit renews both.
    const response = json(await stub.dashboardData(new URL(request.url).searchParams.get('date') ?? undefined));
    response.headers.append('set-cookie', `${SESSION_COOKIE}=${token}; Path=${path}; HttpOnly; Secure; SameSite=Strict; Max-Age=${SESSION_MS / 1000}`);
    return response;
  }
  if (action === 'web' && request.method === 'GET') {
    if (!known || !await stub.validSession(cookie(request))) return json(failure('UNAUTHORIZED', 401));
    return json(ok({card: await webCard(env, tenant, stub)}));
  }
  // "Připojit OneDrive": a same-site click from the logged-in dashboard sends the browser to Microsoft's sign-in.
  if (action === 'onedrive' && request.method === 'GET') {
    if (!known || !await stub.validSession(cookie(request))) return Response.redirect(new URL(path, request.url).toString(), 303);
    const start = await stub.onedriveStart(tenant, new URL(ONEDRIVE_CALLBACK, request.url).toString()) as Result;
    if (start.status !== 200) return onedrivePage(tenant, 'OneDrive teď připojit nejde (' + String((start.body as {error?: string}).error) + ').');
    return new Response(null, {status: 303, headers: {location: (start.body as {url: string}).url, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer'}});
  }
  // One menu item over half a year: price and sales by week (the search in the menu card).
  if (action === 'item' && request.method === 'GET') {
    if (!known || !await stub.validSession(cookie(request))) return json(failure('UNAUTHORIZED', 401));
    const params = new URL(request.url).searchParams, query = (params.get('q') ?? '').slice(0, 100), id = params.get('id');
    const trend = await stub.posItemTrend(query, id ? id.slice(0, 200) : null);
    return json(trend ? ok(trend) : failure('NOT_FOUND', 404));
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

const ONEDRIVE_CALLBACK = '/onedrive/callback';

/** The short page after the Microsoft sign-in, with the way back to the dashboard. */
function onedrivePage(tenant: string | null, message: string, status = 200): Response {
  const esc = (text: string) => text.replace(/[&<>"]/g, char => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'})[char]!);
  const back = tenant ? `<p><a href="/d/${esc(tenant)}">Zpět na přehled</a></p>` : '';
  return new Response(`<!doctype html><html lang="cs"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>OKO1 – OneDrive</title>` +
    `<body style="font:16px/1.5 system-ui,sans-serif;max-width:440px;margin:8vh auto;padding:16px"><h1 style="font-size:20px">OKO1 – OneDrive</h1><p>${esc(message)}</p>${back}</body></html>`,
  {status, headers: {'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-frame-options': 'DENY', 'referrer-policy': 'no-referrer',
    'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"}});
}

/** Microsoft's redirect after the sign-in: the state names the venue and the sign-in it belongs to. */
async function onedriveCallback(request: Request, env: Env): Promise<Response> {
  const params = new URL(request.url).searchParams, state = params.get('state') ?? '', code = params.get('code');
  const tenant = state.match(/^([a-z0-9-]{3,64})~[a-f0-9]{48}$/)?.[1] ?? null;
  if (!tenant || !await registry(env).has(tenant)) return onedrivePage(null, 'Odkaz pro připojení neplatí.', 400);
  if (!code) return onedrivePage(tenant, 'Připojení se nedokončilo: ve vašem účtu Microsoft nebyl přístup povolen. Zkuste to na přehledu znovu.', 400);
  const result = await tenantStub(env, tenant).onedriveFinish(state, code.slice(0, 2000), new URL(ONEDRIVE_CALLBACK, request.url).toString()) as Result;
  if (result.status !== 200) return onedrivePage(tenant, `Připojení se nepovedlo (${String((result.body as {error?: string}).error)}). Zkuste to na přehledu znovu.`, 400);
  return onedrivePage(tenant, 'OneDrive je připojený. OKO1 si odteď bude reporty manažerů ze složky brát každé ráno samo.');
}

/** Everything but the MCP server: ingest, admin API and the dashboard. */
async function app(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === ONEDRIVE_CALLBACK && request.method === 'GET') return onedriveCallback(request, env);
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
    // Prices of every venue nearby are bigger than other admin bodies (stored as one row, which SQLite caps at 2 MB).
    body = await readBody(request, route === 'v1/ingest' || route === 'admin/competitors' ? 1048576 : 262144);
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
