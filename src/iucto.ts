/**
 * Costs from the venue's accounting in iÚčto (https://online.iucto.cz/api/1.3, docs https://developers.iucto.cz).
 * OKO1 only reads: GET /chart_account (the venue's chart of accounts) and GET /journal (posted entries). From the
 * journal it keeps only sums per synthetic cost account (class 5) and month; no supplier, customer or entry text is
 * stored. The key is the Worker secret IUCTO_KEY_<TENANT>; it goes only into the X-Auth-Key header and never into a
 * log or an error text. Same guards as the other readers: one host over HTTPS, no redirects, a timeout on every
 * request, a size limit on every response, errors as short Czech texts, never thrown upwards.
 */

export const IUCTO_API = 'https://online.iucto.cz/api/1.3';
const TIMEOUT_MS = 15000;
const MAX_RESPONSE_BYTES = 10 * 1024 * 1024;
const PAGE_SIZE = 200;
/** One month of a restaurant's journal fits easily; more pages mean something is off, and the quota is the venue's. */
const MAX_PAGES = 40;

export type IuctoEnv = {[name: `IUCTO_KEY_${string}`]: string | undefined};
export type Fetched<T> = {ok: true; value: T} | {ok: false; error: string};
/** Posted costs of one month on one synthetic account (e.g. 518), in haléře. */
export type CostRow = {account: string; name: string; amountCents: number};

/** Name of the Worker secret with the venue's iÚčto key: IUCTO_KEY_JAMES_DEAN for `james-dean`. */
export function iuctoKeyName(tenant: string): string {
  return 'IUCTO_KEY_' + tenant.toUpperCase().replace(/-/g, '_');
}

/** The venue's iÚčto key, or null when it is missing or does not look like a key. */
export function iuctoKey(env: IuctoEnv, tenant: string): string | null {
  const value = env[iuctoKeyName(tenant) as `IUCTO_KEY_${string}`];
  const key = typeof value === 'string' ? value.trim() : '';
  return /^[\w.:-]{8,200}$/.test(key) ? key : null;
}

/** Names of the usual synthetic cost accounts (Czech chart of accounts); others take the name iÚčto gives. */
const SYNTHETIC: Record<string, string> = {
  '501': 'Spotřeba materiálu', '502': 'Energie', '504': 'Prodané zboží', '511': 'Opravy a udržování', '512': 'Cestovné',
  '513': 'Reprezentace', '518': 'Služby', '521': 'Mzdy', '523': 'Odměny orgánům', '524': 'Sociální a zdravotní pojištění',
  '525': 'Ostatní sociální pojištění', '527': 'Zákonné sociální náklady', '528': 'Ostatní sociální náklady', '531': 'Daň silniční',
  '532': 'Daň z nemovitých věcí', '538': 'Ostatní daně a poplatky', '541': 'Zůstatková cena prodaného majetku', '543': 'Dary',
  '544': 'Smluvní pokuty a úroky z prodlení', '545': 'Ostatní pokuty a penále', '546': 'Odpis pohledávky', '548': 'Ostatní provozní náklady',
  '549': 'Manka a škody', '551': 'Odpisy', '562': 'Úroky', '563': 'Kurzové ztráty', '568': 'Ostatní finanční náklady', '591': 'Daň z příjmů',
};

const reasons: Record<number, string> = {400: 'chybný dotaz', 401: 'neplatný klíč', 402: 'vyčerpaný denní limit nebo tarif bez API', 404: 'nenalezeno'};

/** One GET as JSON. Errors come back as a short Czech text without the key or any data. */
async function getJson(key: string, path: string, deadline: number): Promise<Fetched<unknown>> {
  const left = deadline - Date.now();
  if (left <= 0) return {ok: false, error: 'iÚčto neodpovědělo včas'};
  let response: Response;
  try {
    response = await fetch(IUCTO_API + path, {
      method: 'GET', redirect: 'manual', headers: {'x-auth-key': key, accept: 'application/json'},
      signal: AbortSignal.timeout(Math.min(TIMEOUT_MS, left)),
    });
  } catch (error) {
    const name = error instanceof Error ? error.name : '';
    return {ok: false, error: name === 'TimeoutError' || name === 'AbortError' ? 'iÚčto neodpovědělo včas' : 'iÚčto není dostupné'};
  }
  try {
    if (!response.ok) {
      await response.body?.cancel();
      return {ok: false, error: `iÚčto: HTTP ${response.status}${reasons[response.status] ? ` (${reasons[response.status]})` : ''}`};
    }
    const text = await response.text();
    if (text.length > MAX_RESPONSE_BYTES) return {ok: false, error: 'iÚčto: odpověď je příliš velká'};
    return {ok: true, value: JSON.parse(text)};
  } catch {
    return {ok: false, error: 'iÚčto: odpověď nejde přečíst'};
  }
}

const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

/** Chart of accounts: internal id → account number and name ("518100 - Služby ostatní"). */
export function parseChart(body: unknown): Map<number, {number: string; name: string}> | null {
  if (!isObject(body)) return null;
  const chart = new Map<number, {number: string; name: string}>();
  for (const [id, label] of Object.entries(body)) {
    if (!/^\d{1,10}$/.test(id) || typeof label !== 'string') continue;
    const match = /^\s*(\d{3,6})\s*-\s*(.*)$/.exec(label);
    if (match) chart.set(Number(id), {number: match[1], name: match[2].trim().slice(0, 100)});
  }
  return chart;
}

type Entry = {md: number; dal: number; price: number};
/** One journal page: only the accounts and the amount of each entry are kept. */
export function parseJournalPage(body: unknown): {entries: Entry[]; pageCount: number} | null {
  if (!isObject(body) || !isObject(body._embedded) || !Array.isArray(body._embedded.journal)) return null;
  const pageCount = typeof body.pageCount === 'number' && Number.isSafeInteger(body.pageCount) ? body.pageCount : 1;
  const entries: Entry[] = [];
  for (const row of body._embedded.journal) {
    if (!isObject(row)) return null;
    const price = typeof row.price === 'number' ? row.price : Number(row.price);
    if (!Number.isFinite(price)) return null;
    entries.push({md: Number(row.chartaccount_md), dal: Number(row.chartaccount_dal), price});
  }
  return {entries, pageCount};
}

/**
 * Costs per synthetic account: a cost account on the debit side adds, on the credit side (a correction) subtracts.
 * Largest first; accounts that net to zero are left out.
 */
export function sumCosts(entries: Entry[], chart: Map<number, {number: string; name: string}>): CostRow[] {
  const sums = new Map<string, {name: string; cents: number}>();
  const add = (id: number, cents: number) => {
    const account = chart.get(id);
    if (!account || !account.number.startsWith('5')) return;
    const synthetic = account.number.slice(0, 3);
    const row = sums.get(synthetic) ?? {name: SYNTHETIC[synthetic] ?? account.name, cents: 0};
    row.cents += cents;
    sums.set(synthetic, row);
  };
  for (const entry of entries) {
    const cents = Math.round(entry.price * 100);
    add(entry.md, cents);
    add(entry.dal, -cents);
  }
  return [...sums].map(([account, row]) => ({account, name: row.name, amountCents: row.cents}))
    .filter(row => row.amountCents !== 0).sort((a, b) => b.amountCents - a.amountCents || a.account.localeCompare(b.account));
}

/** Posted costs with the expense date in `from`–`to` (YYYY-MM-DD, inclusive). */
export async function fetchCosts(key: string, from: string, to: string, budgetMs = 25000): Promise<Fetched<CostRow[]>> {
  const deadline = Date.now() + budgetMs;
  const chartBody = await getJson(key, '/chart_account', deadline);
  if (!chartBody.ok) return chartBody;
  const chart = parseChart(chartBody.value);
  if (!chart?.size) return {ok: false, error: 'iÚčto: účtová osnova nejde přečíst'};
  const entries: Entry[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const query = new URLSearchParams({date_expense_from: from, date_expense_to: to, page: String(page), pageSize: String(PAGE_SIZE)});
    const body = await getJson(key, `/journal?${query}`, deadline);
    if (!body.ok) return body;
    const parsed = parseJournalPage(body.value);
    if (!parsed) return {ok: false, error: 'iÚčto: účetní deník nejde přečíst'};
    entries.push(...parsed.entries);
    if (page >= parsed.pageCount) return {ok: true, value: sumCosts(entries, chart)};
  }
  return {ok: false, error: `iÚčto: účetní deník má víc než ${MAX_PAGES * PAGE_SIZE} položek za období`};
}
