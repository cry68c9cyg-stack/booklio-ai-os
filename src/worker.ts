import {DurableObject} from 'cloudflare:workers';
import {createHash, timingSafeEqual} from 'node:crypto';
import {buildBriefing, renderBriefing} from './briefing.ts';
import {briefingDecision, localHour, reportDate} from './schedule.ts';
import {addDays, isDate} from './time.ts';
import {InputError, validateBatch, validateConfig, validateHistory, type Bill, type CashClosing, type TenantConfig} from './validate.ts';

type Env = {TENANTS: DurableObjectNamespace<TenantObject>; REGISTRY: DurableObjectNamespace<Registry>; ADMIN_SECRET: string};
type Result = {status: number; body: unknown};

const ok = (body: unknown): Result => ({status: 200, body});
const failure = (code: string, status: number): Result => ({status, body: {error: code}});
const json = (result: Result) => Response.json(result.body, {status: result.status, headers: {'cache-control': 'no-store'}});
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
const same = (a: string, b: string) => {
  const left = new TextEncoder().encode(a), right = new TextEncoder().encode(b);
  return left.length === right.length && timingSafeEqual(left, right);
};

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
    `));
  }

  private config(): TenantConfig | null {
    const row = this.sql.exec<{json: string}>('SELECT json FROM config WHERE id=1').toArray()[0];
    return row ? JSON.parse(row.json) as TenantConfig : null;
  }

  async handle(tenant: string, route: string, method: string, body: unknown, token: string | null, query: Record<string, string>): Promise<Result> {
    try {
      if (route === 'v1/ingest' && method === 'POST') return this.ingest(body, token);
      if (route === 'admin/config' && method === 'PUT') return this.saveConfig(tenant, body);
      if (route === 'admin/config' && method === 'GET') return ok(this.config());
      if (route === 'admin/pair' && method === 'POST') return this.pair(body);
      if (route === 'admin/history' && method === 'POST') return this.importHistory(body);
      if (route === 'admin/briefing' && method === 'GET') return this.preview(query.date);
      if (route === 'admin/briefings' && method === 'GET') return ok(this.sql.exec('SELECT business_date AS businessDate, status, incomplete, text, created_at AS createdAt FROM briefings ORDER BY business_date DESC LIMIT 60').toArray());
      if (route === 'admin/tick' && method === 'POST') {
        const at = (body as {at?: unknown})?.at;
        if (typeof at !== 'string' || Number.isNaN(Date.parse(at))) return failure('INVALID_REQUEST', 400);
        return ok(await this.tick(new Date(at)));
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
    this.ctx.waitUntil(this.env.REGISTRY.get(this.env.REGISTRY.idFromName('registry')).add(tenant));
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

  private ingest(body: unknown, token: string | null): Result {
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
        record.type, record.id, record.version, record.businessDate, record.registerId, JSON.stringify(record), batch.installationId, now).rowsWritten;
        if (changed) accepted++; else stale++;
      }
      const result = {batchId: batch.batchId, accepted, stale};
      this.sql.exec('INSERT INTO batches VALUES(?,?,?,?,?)', batch.batchId, batch.installationId, payloadHash, JSON.stringify(result), now);
      this.sql.exec('UPDATE installations SET last_seen_at=? WHERE installation_id=?', now, batch.installationId);
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

  private day<T>(type: string, date: string): T[] {
    return this.sql.exec<{json: string}>('SELECT json FROM records WHERE type=? AND business_date=? ORDER BY id', type, date).toArray().map(row => JSON.parse(row.json) as T);
  }

  /** Revenue of a past day: POS data when there is any, otherwise the imported history. */
  private dayRevenue(date: string): number | null {
    const bills = this.day<Bill>('bill', date).filter(bill => bill.status === 'closed');
    if (bills.length) return bills.reduce((sum, bill) => sum + bill.totalCents, 0);
    return this.sql.exec<{revenue_cents: number}>('SELECT revenue_cents FROM history WHERE business_date=?', date).toArray()[0]?.revenue_cents ?? null;
  }

  private ready(config: TenantConfig, closings: CashClosing[]): boolean {
    if (!config.registers.length) return closings.length > 0;
    const closed = new Set(closings.map(closing => closing.registerId));
    return config.registers.every(register => closed.has(register));
  }

  private briefingFor(config: TenantConfig, date: string, incomplete: boolean) {
    const planHistory = [7, 14, 21, 28].map(days => this.dayRevenue(addDays(date, -days))).filter((value): value is number => value !== null).map(revenueCents => ({revenueCents}));
    const briefing = buildBriefing({businessDate: date, config, bills: this.day<Bill>('bill', date), closings: this.day<CashClosing>('cash_closing', date), planHistory, incomplete});
    return {briefing, text: renderBriefing(config.name, briefing)};
  }

  private preview(date: string | undefined): Result {
    const config = this.config();
    if (!config) return failure('NOT_CONFIGURED', 409);
    if (!isDate(date)) return failure('INVALID_REQUEST', 400);
    return ok(this.briefingFor(config, date, !this.ready(config, this.day<CashClosing>('cash_closing', date))));
  }

  /** Called every hour by the cron trigger. Decides whether this morning's briefing goes out now. */
  async tick(at: Date) {
    const config = this.config();
    if (!config) return {decision: 'not-configured'};
    const date = reportDate(at, config.timeZone, config.businessDayCutoffHour);
    const sent = this.sql.exec<{status: string}>("SELECT status FROM briefings WHERE business_date=? AND status IN ('stored','delivered')", date).toArray().length > 0;
    const decision = briefingDecision({
      localHour: localHour(at, config.timeZone), sendHours: config.sendHours, alreadySent: sent,
      ready: this.ready(config, this.day<CashClosing>('cash_closing', date)),
    });
    if (decision !== 'send' && decision !== 'send-incomplete') return {decision, businessDate: date};
    const {briefing, text} = this.briefingFor(config, date, decision === 'send-incomplete');
    // No message channel is connected yet: the briefing is stored and readable through the admin API.
    // A WhatsApp/SMS adapter will deliver it here and set the status to 'delivered' or 'failed'.
    this.sql.exec(`INSERT INTO briefings VALUES(?,?,?,?,?,?) ON CONFLICT(business_date) DO UPDATE SET
      status=excluded.status, incomplete=excluded.incomplete, text=excluded.text, json=excluded.json, created_at=excluded.created_at`,
    date, 'stored', briefing.incomplete ? 1 : 0, text, JSON.stringify(briefing), at.toISOString());
    return {decision, businessDate: date, text};
  }
}

/** The list of configured venues, so the hourly trigger knows whom to wake. */
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
  'admin/briefing': ['GET'], 'admin/briefings': ['GET'], 'admin/tick': ['POST'],
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
    const stub = env.TENANTS.get(env.TENANTS.idFromName(tenant));
    return json(await stub.handle(tenant, route, request.method, body, token, Object.fromEntries(url.searchParams)));
  },

  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    const tenants = await env.REGISTRY.get(env.REGISTRY.idFromName('registry')).list();
    for (const tenant of tenants) ctx.waitUntil(env.TENANTS.get(env.TENANTS.idFromName(tenant)).tick(new Date(event.scheduledTime)));
  },
};
