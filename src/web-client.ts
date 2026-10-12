/**
 * Live reads from the venue's website (James Dean) through its read-only API /api/oko1/v1 (docs/web-v1.md). OKO1 reads
 * guest names and contacts only at the moment it needs them (an MCP question, the dashboard) and never stores them: no
 * table, no R2, no log with data (new architecture, approved by MC on 12. 10. 2026).
 * Same guards as the OneDrive reader: only allowed hosts over HTTPS, no redirects, a timeout on every request, a size
 * limit on every response and never an error thrown upwards (errors are short Czech texts). The token goes only into
 * the Authorization header.
 */
import {isDate} from './time.ts';
import {WEB_HOSTS} from './validate.ts';

/** Worker secrets with the web's read token, one per venue: WEB_TOKEN_JAMES_DEAN for `james-dean`. */
export type WebEnv = {[name: `WEB_TOKEN_${string}`]: string | undefined};
export type WebSite = {url: string; token: string};
export type Fetched<T> = {ok: true; value: T} | {ok: false; error: string};
export type WebRow = Record<string, unknown>;
/** Narrowing a table on the web: days from–to on the table's date column, and equality on its filter columns. */
export type TableFilter = {od?: string; do?: string; rovno?: [string, string | number][]};
export type TableInfo = {nazev: string; klic: string[]; datum: string | null; filtry: string[]};

export const API = '/api/oko1/v1';
const TIMEOUT_MS = 10000;
/** One live read (all its pages) at most; an MCP answer must not hang. */
const READ_MS = 25000;
/** One response at most (a page of 1000 rows or a whole document). */
export const MAX_RESPONSE_BYTES = 20 * 1024 * 1024;
const PAGE = 1000;
/** Rows of one live read by default; more come back cut with `truncated: true`. */
export const MAX_ROWS = 5000;
/** Hard ceiling for internal joins (tables of a booking list). */
const MAX_ROWS_CEILING = 50000;
const NAME = /^[a-z][a-z0-9_]{0,62}$/;

export function allowedWebUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && WEB_HOSTS.includes(url.hostname) && !url.port && !url.username && !url.password;
  } catch {
    return false;
  }
}

/** Name of the Worker secret with the venue's web token: upper case, '-' becomes '_'. */
export function webTokenName(tenant: string): string {
  return 'WEB_TOKEN_' + tenant.toUpperCase().replace(/-/g, '_');
}

/** The venue's web token from the Worker secrets, or null when it is missing or not 64 hex characters. */
export function webToken(env: WebEnv, tenant: string): string | null {
  const value = env[webTokenName(tenant) as `WEB_TOKEN_${string}`];
  const token = typeof value === 'string' ? value.trim() : '';
  return /^[a-f0-9]{64}$/i.test(token) ? token.toLowerCase() : null;
}

/** Where and how to read the venue's website, or a Czech warning why it cannot be read. */
export function webSite(web: {url: string} | null, env: WebEnv, tenant: string): Fetched<WebSite> {
  if (!web || !allowedWebUrl(web.url)) return {ok: false, error: 'Web není připojený: provozovna nemá v nastavení adresu webu (web.url).'};
  const token = webToken(env, tenant);
  if (!token) return {ok: false, error: `Web není připojený: chybí tajemství ${webTokenName(tenant)} (vytvoří ho nasazení).`};
  return {ok: true, value: {url: web.url, token}};
}

const reasons: Record<number, string> = {401: 'neplatný token', 404: 'rozhraní je vypnuté nebo nic takového není', 429: 'moc špatných pokusů'};

/** Bounded read of a response body; null when it is larger than `limit`. */
async function readBounded(response: Response, limit: number): Promise<Uint8Array | null> {
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader(), chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const part = await reader.read();
    if (part.done) break;
    size += part.value.byteLength;
    if (size > limit) { await reader.cancel(); return null; }
    chunks.push(part.value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

/** One GET as JSON. Errors come back as a short Czech text without the token or any data. */
export async function getJson(site: WebSite, path: string, deadline = Date.now() + READ_MS): Promise<Fetched<unknown>> {
  let url: string;
  try { url = new URL(path, site.url).toString(); } catch { return {ok: false, error: 'neplatná adresa'}; }
  if (!allowedWebUrl(url)) return {ok: false, error: 'adresa mimo povolené weby'};
  const left = deadline - Date.now();
  if (left <= 0) return {ok: false, error: 'web neodpověděl včas'};
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'GET', redirect: 'manual', headers: {authorization: `Bearer ${site.token}`, accept: 'application/json'},
      signal: AbortSignal.timeout(Math.min(TIMEOUT_MS, left)),
    });
  } catch (error) {
    const name = error instanceof Error ? error.name : '';
    return {ok: false, error: name === 'TimeoutError' || name === 'AbortError' ? 'web neodpověděl včas' : 'web není dostupný'};
  }
  try {
    if (response.status >= 300 && response.status < 400) { await response.body?.cancel(); return {ok: false, error: `přesměrování ${response.status} (nepovoleno)`}; }
    if (!response.ok) {
      // The web explains a refused filter (422) in its own words; nothing else from an error body is passed on.
      const detail = response.status === 422 ? await readBounded(response, 4096).then(bytes => bytes && (JSON.parse(new TextDecoder().decode(bytes)) as {chyba?: unknown}).chyba).catch(() => null) : null;
      if (response.status !== 422) await response.body?.cancel();
      const reason = typeof detail === 'string' ? detail.slice(0, 200) : reasons[response.status];
      return {ok: false, error: `HTTP ${response.status}${reason ? ` (${reason})` : ''}`};
    }
    if (Number(response.headers.get('content-length') || 0) > MAX_RESPONSE_BYTES) { await response.body?.cancel(); return {ok: false, error: 'odpověď je příliš velká'}; }
    const bytes = await readBounded(response, MAX_RESPONSE_BYTES);
    if (!bytes) return {ok: false, error: 'odpověď je příliš velká'};
    return {ok: true, value: JSON.parse(new TextDecoder().decode(bytes))};
  } catch {
    return {ok: false, error: 'odpověď webu nejde přečíst'};
  }
}

const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const strings = (value: unknown) => Array.isArray(value) && value.every(item => typeof item === 'string') ? value as string[] : null;

/** The tables the web lets OKO1 read, with their key, date column and filter columns. */
export function parseTableList(body: unknown): TableInfo[] | null {
  if (!isObject(body) || !Array.isArray(body.tabulky) || body.tabulky.length > 100) return null;
  const tables: TableInfo[] = [];
  for (const entry of body.tabulky) {
    if (!isObject(entry) || typeof entry.nazev !== 'string' || !NAME.test(entry.nazev)) return null;
    tables.push({nazev: entry.nazev, klic: strings(entry.klic) ?? [], datum: typeof entry.datum === 'string' ? entry.datum : null, filtry: strings(entry.filtry) ?? []});
  }
  return tables;
}

/** One page of a table: its rows and where the next page starts (after this one, otherwise paging would never end). */
export function parsePage(body: unknown, name: string, after: number): {rows: WebRow[]; next: number | null} | null {
  if (!isObject(body) || body.nazev !== name || !Array.isArray(body.radky)) return null;
  const next = body.dalsi;
  if (next !== null && !(typeof next === 'number' && Number.isSafeInteger(next) && next > after)) return null;
  if (!body.radky.every(isObject)) return null;
  return {rows: body.radky as WebRow[], next};
}

/** Query string of one page; a filter that does not make sense is refused before anything is sent. */
export function pageQuery(after: number, filter: TableFilter): string | null {
  const query = new URLSearchParams({po: String(after), limit: String(PAGE)});
  for (const key of ['od', 'do'] as const) {
    const value = filter[key];
    if (value === undefined) continue;
    if (!isDate(value)) return null;
    query.set(key, value);
  }
  for (const [column, value] of filter.rovno ?? []) {
    if (!NAME.test(column) || String(value).length > 200) return null;
    query.append('rovno', `${column}:${value}`);
  }
  return query.toString();
}

export async function webTables(site: WebSite): Promise<Fetched<TableInfo[]>> {
  const got = await getJson(site, `${API}/tabulky`);
  if (!got.ok) return got;
  const tables = parseTableList(got.value);
  return tables ? {ok: true, value: tables} : {ok: false, error: 'seznam tabulek má neznámý tvar'};
}

/**
 * Rows of one table, narrowed on the web, page by page. At most `maxRows` (5000 by default): a longer answer comes back
 * cut with `truncated: true`, so a live question never pulls a whole history.
 */
export async function webTable(site: WebSite, name: string, filter: TableFilter = {}, maxRows = MAX_ROWS): Promise<Fetched<{rows: WebRow[]; truncated: boolean}>> {
  if (!NAME.test(name)) return {ok: false, error: 'neplatný název tabulky'};
  const limit = Math.min(Math.max(1, maxRows), MAX_ROWS_CEILING), deadline = Date.now() + READ_MS;
  const rows: WebRow[] = [];
  let after = 0;
  for (;;) {
    const query = pageQuery(after, filter);
    if (query === null) return {ok: false, error: 'neplatný filtr (od a do jako RRRR-MM-DD, rovno jako sloupec:hodnota)'};
    const got = await getJson(site, `${API}/tabulka/${name}?${query}`, deadline);
    if (!got.ok) return got;
    const page = parsePage(got.value, name, after);
    if (!page) return {ok: false, error: `tabulka ${name} má neznámý tvar`};
    for (const row of page.rows) {
      if (rows.length >= limit) return {ok: true, value: {rows, truncated: true}};
      rows.push(row);
    }
    if (page.next === null) return {ok: true, value: {rows, truncated: false}};
    if (rows.length >= limit) return {ok: true, value: {rows, truncated: true}};
    after = page.next;
  }
}

/** Visits like the admin's page (`statistiky` by day and `online`), from `od` (the web allows at most 13 months back). */
export async function webVisits(site: WebSite, od?: string): Promise<Fetched<Record<string, unknown>>> {
  if (od !== undefined && !isDate(od)) return {ok: false, error: 'od musí být den RRRR-MM-DD'};
  const got = await getJson(site, `${API}/navstevnost${od ? `?od=${od}` : ''}`);
  if (!got.ok) return got;
  return isObject(got.value) ? {ok: true, value: got.value} : {ok: false, error: 'návštěvnost má neznámý tvar'};
}

/** Settings and state like the admin's menu (confirmation, holding time, capacity, assistants, SMS credit, pending). */
export async function webOverview(site: WebSite): Promise<Fetched<Record<string, unknown>>> {
  const got = await getJson(site, `${API}/prehled`);
  if (!got.ok) return got;
  return isObject(got.value) ? {ok: true, value: got.value} : {ok: false, error: 'přehled má neznámý tvar'};
}
