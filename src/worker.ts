import {DurableObject} from 'cloudflare:workers';
import {createHash, timingSafeEqual} from 'node:crypto';
import {buildBriefing, renderBriefing} from './briefing.ts';
import {deliver, type DeliveryEnv} from './delivery.ts';
import {briefingDecision, localHour, reportDate} from './schedule.ts';
import {addDays, isDate} from './time.ts';
import {validateDailyReport, type DailyReport} from './daily-report.ts';
import {analyseNotes, type NotesAnalysis} from './notes.ts';
import {fetchDayFiles, reportFromFiles} from './onedrive.ts';
import {InputError, validateBatch, validateConfig, validateHistory, type Bill, type BottleCheck, type CashClosing, type TenantConfig} from './validate.ts';

type Env = DeliveryEnv & {
  TENANTS: DurableObjectNamespace<TenantObject>; REGISTRY: DurableObjectNamespace<Registry>; ADMIN_SECRET: string; DATA_JURISDICTION?: string;
  /** R2 bucket in the EU (production): untouched copies of everything received and a daily export. Optional: without it nothing is archived. */
  ARCHIVE?: R2Bucket;
  /** OKO1's own Claude API key for "Report dne". Optional: without it the raw text goes into the briefing. */
  ANTHROPIC_API_KEY?: string;
};
type Result = {status: number; body: unknown};

// With DATA_JURISDICTION=eu (production) the venue data is created and stored only in the EU.
// The local test runtime has no jurisdictions, so tests leave it unset.
const scoped = <T extends Rpc.DurableObjectBranded | undefined>(env: Env, namespace: DurableObjectNamespace<T>) =>
  env.DATA_JURISDICTION === 'eu' ? namespace.jurisdiction('eu') : namespace;
const tenantStub = (env: Env, tenant: string) => { const ns = scoped(env, env.TENANTS); return ns.get(ns.idFromName(tenant)); };
const registry = (env: Env) => { const ns = scoped(env, env.REGISTRY); return ns.get(ns.idFromName('registry')); };
const ok = (body: unknown): Result => ({status: 200, body});
const failure = (code: string, status: number): Result => ({status, body: {error: code}});
const json = (result: Result) => Response.json(result.body, {status: result.status, headers: {'cache-control': 'no-store'}});
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
const same = (a: string, b: string) => {
  const left = new TextEncoder().encode(a), right = new TextEncoder().encode(b);
  return left.length === right.length && timingSafeEqual(left, right);
};

const PREPARE_BUDGET_MS = 60000;
/** Waits for `work` at most `ms`; errors and overruns are logged, never thrown. The work may still finish later. */
async function withinBudget(work: Promise<unknown>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    work.catch(error => console.error('prepare failed', String(error))),
    new Promise(resolve => { timer = setTimeout(() => { console.error('prepare over budget'); resolve(null); }, ms); }),
  ]);
  clearTimeout(timer);
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
    `));
  }

  private config(): TenantConfig | null {
    const row = this.sql.exec<{json: string}>('SELECT json FROM config WHERE id=1').toArray()[0];
    // Configs saved before the bottle check have no `bottleCheck` key.
    return row ? {bottleCheck: null, reportsLink: null, ...JSON.parse(row.json)} as TenantConfig : null;
  }

  async handle(tenant: string, route: string, method: string, body: unknown, token: string | null, query: Record<string, string>): Promise<Result> {
    try {
      if (route === 'v1/ingest' && method === 'POST') return this.ingest(tenant, body, token);
      if (route === 'admin/report' && method === 'PUT') return ok(this.saveReport(validateDailyReport(body)));
      if (route === 'admin/report' && method === 'GET') return isDate(query.date) ? ok({report: this.report(query.date), notes: this.notes(query.date)}) : failure('INVALID_REQUEST', 400);
      if (route === 'admin/fetch' && method === 'POST') {
        const date = (body as {date?: unknown})?.date;
        if (!isDate(date)) return failure('INVALID_REQUEST', 400);
        return ok(await this.fetchReport(tenant, date));
      }
      if (route === 'admin/config' && method === 'PUT') return this.saveConfig(tenant, body);
      if (route === 'admin/config' && method === 'GET') return ok(this.config());
      if (route === 'admin/pair' && method === 'POST') return this.pair(body);
      if (route === 'admin/history' && method === 'POST') return this.importHistory(body);
      if (route === 'admin/briefing' && method === 'GET') return this.preview(query.date);
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

  private saveConfig(tenant: string, body: unknown): Result {
    const config = validateConfig(body);
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
      for (const record of batch.records) {
        const changed = this.sql.exec(`INSERT INTO records(type, id, version, business_date, register_id, json, installation_id, received_at) VALUES(?,?,?,?,?,?,?,?)
          ON CONFLICT(type, id) DO UPDATE SET version=excluded.version, business_date=excluded.business_date, register_id=excluded.register_id,
          json=excluded.json, installation_id=excluded.installation_id, received_at=excluded.received_at WHERE excluded.version > records.version`,
        record.type, record.id, record.version, record.businessDate, record.type === 'bottle_check' ? '' : record.registerId, JSON.stringify(record), batch.installationId, now).rowsWritten;
        if (changed) accepted++; else stale++;
      }
      const result = {batchId: batch.batchId, accepted, stale};
      this.sql.exec('INSERT INTO batches VALUES(?,?,?,?,?)', batch.batchId, batch.installationId, payloadHash, JSON.stringify(result), now);
      this.sql.exec('UPDATE installations SET last_seen_at=? WHERE installation_id=?', now, batch.installationId);
      this.archive(`t/${tenant}/ingest/${now.slice(0, 10)}/${batch.batchId}.json`, JSON.stringify(batch));
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

  private day<T>(type: string, date: string): T[] {
    return this.sql.exec<{json: string}>('SELECT json FROM records WHERE type=? AND business_date=? ORDER BY id', type, date).toArray().map(row => JSON.parse(row.json) as T);
  }

  /** Revenue of a past day: POS data when there is any, then the managers' report, otherwise the imported history. */
  private dayRevenue(date: string): number | null {
    const bills = this.day<Bill>('bill', date).filter(bill => bill.status === 'closed');
    if (bills.length) return bills.reduce((sum, bill) => sum + bill.totalCents, 0);
    const reported = this.sql.exec<{total: number | null}>("SELECT SUM(amount_cents) AS total FROM report_lines WHERE business_date=? AND kind='revenue_section'", date).toArray()[0]?.total;
    if (reported !== null && reported !== undefined) return reported;
    return this.sql.exec<{revenue_cents: number}>('SELECT revenue_cents FROM history WHERE business_date=?', date).toArray()[0]?.revenue_cents ?? null;
  }

  /** A stored report counts only when it has revenue: a cash book column alone is not the day's report. */
  private hasReport(date: string): boolean {
    return this.sql.exec("SELECT 1 FROM report_lines WHERE business_date=? AND kind='revenue_section' LIMIT 1", date).toArray().length > 0;
  }

  /** The day is ready when the managers' report is in, or when every register has closed. */
  private ready(config: TenantConfig, date: string): boolean {
    if (this.hasReport(date)) return true;
    const closings = this.day<CashClosing>('cash_closing', date);
    if (!config.registers.length) return closings.length > 0;
    const closed = new Set(closings.map(closing => closing.registerId));
    return config.registers.every(register => closed.has(register));
  }

  private briefingFor(config: TenantConfig, date: string, incomplete: boolean) {
    const planHistory = [7, 14, 21, 28].map(days => this.dayRevenue(addDays(date, -days))).filter((value): value is number => value !== null).map(revenueCents => ({revenueCents}));
    const briefing = buildBriefing({businessDate: date, config, bills: this.day<Bill>('bill', date), closings: this.day<CashClosing>('cash_closing', date),
      bottleChecks: this.day<BottleCheck>('bottle_check', date), planHistory, incomplete, report: this.report(date), notes: this.notes(date)});
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
      })(), PREPARE_BUDGET_MS);
    }
    const decision = briefingDecision({localHour: hour, sendHours: config.sendHours, alreadySent: sent, ready: this.ready(config, date)});
    if (decision !== 'send' && decision !== 'send-incomplete') return {decision, businessDate: date};
    const {briefing, text} = this.briefingFor(config, date, decision === 'send-incomplete');
    // Without a configured channel the briefing is 'stored' and readable through the admin API.
    // A 'failed' delivery is not counted as sent, so the next send hour (until the last one) tries again.
    const status = await deliver(this.env, config.recipients, text);
    this.sql.exec(`INSERT INTO briefings VALUES(?,?,?,?,?,?) ON CONFLICT(business_date) DO UPDATE SET
      status=excluded.status, incomplete=excluded.incomplete, text=excluded.text, json=excluded.json, created_at=excluded.created_at`,
    date, status, briefing.incomplete ? 1 : 0, text, JSON.stringify(briefing), at.toISOString());
    this.archive(`t/${tenant}/export/${date}.json`, JSON.stringify(this.exportDay(date)));
    return {decision, businessDate: date, status, text};
  }

  /** Everything stored about one business day, for the daily export to R2. */
  private exportDay(date: string) {
    return {
      businessDate: date, exportedAt: new Date().toISOString(),
      records: this.sql.exec<{json: string}>('SELECT json FROM records WHERE business_date=? ORDER BY type, id', date).toArray().map(row => JSON.parse(row.json)),
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
  async list(): Promise<string[]> { return this.ctx.storage.sql.exec<{tenant: string}>('SELECT tenant FROM tenants ORDER BY tenant').toArray().map(row => row.tenant); }
}

const routes: Record<string, string[]> = {
  'v1/ingest': ['POST'], 'admin/config': ['GET', 'PUT'], 'admin/pair': ['POST'], 'admin/history': ['POST'],
  'admin/briefing': ['GET'], 'admin/briefings': ['GET'], 'admin/tick': ['POST'], 'admin/report': ['GET', 'PUT'], 'admin/fetch': ['POST'],
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

const isResult = (value: unknown): value is Result => !!value && typeof value === 'object' && 'status' in value && 'body' in value && Object.keys(value).length === 2;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
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
    return json(await stub.handle(tenant, route, request.method, body, token, Object.fromEntries(url.searchParams)));
  },

  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    const tenants = await registry(env).list();
    for (const tenant of tenants) ctx.waitUntil(tenantStub(env, tenant).tick(new Date(event.scheduledTime), tenant));
  },
};
