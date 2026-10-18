/**
 * Reads the managers' Excel files from a OneDrive folder shared with a read-only link ("anyone with the link can view").
 * Personal OneDrive no longer opens new share links (1drv.ms/f/c/…) without a sign-in: with OKO1's own read-only
 * Microsoft access (src/microsoft.ts) the folder is opened through Microsoft Graph, otherwise through the public API.
 */
import {extractCashBook, extractDailyReport, isJournalBook, JOURNAL_LABEL, type DailyReport} from './daily-report.ts';
import {readXlsx} from './xlsx.ts';
import {googleFolderId} from './validate.ts';

export type FetchedFile = {name: string; bytes: Uint8Array};
type Item = {name?: string; size?: number; folder?: unknown; file?: unknown; lastModifiedDateTime?: string; '@content.downloadUrl'?: string;
  '@microsoft.graph.downloadUrl'?: string; children?: Item[]; id?: string; parentReference?: {driveId?: string}};
/** Where the folder's items are listed: the public API (by share), or Graph with OKO1's access (by drive). */
type Api = {headers: Record<string, string>; childrenUrl: (folder: Item) => string | null};
const downloadUrl = (item: Item) => item['@content.downloadUrl'] ?? item['@microsoft.graph.downloadUrl'];

const ONEDRIVE_API = 'https://api.onedrive.com/v1.0';
const GRAPH_API = 'https://graph.microsoft.com/v1.0';
const GOOGLE_API = 'https://www.googleapis.com/drive/v3';
const MAX_FILE = 10 * 1024 * 1024;
const MAX_FOLDERS = 6;
const MAX_PAGES = 10;
const TIMEOUT_MS = 15000;
/** Microsoft hosts that serve shared OneDrive / SharePoint files. Nothing else is ever fetched. */
const ALLOWED_HOSTS = /(^|\.)(1drv\.ms|1drv\.com|onedrive\.com|onedrive\.live\.com|live\.net|sharepoint\.com|graph\.microsoft\.com|microsoftpersonalcontent\.com|www\.googleapis\.com)$/;

export function allowedUrl(value: string): boolean {
  try { const url = new URL(value); return url.protocol === 'https:' && ALLOWED_HOSTS.test(url.hostname); } catch { return false; }
}

/** Share id for the sharing API: "u!" + unpadded base64url of the link. */
export function shareId(link: string): string {
  const bytes = new TextEncoder().encode(link.trim());
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return 'u!' + btoa(binary).replace(/=+$/, '').replace(/\//g, '_').replace(/\+/g, '-');
}

/** The file names that can hold the day: the daily report carries the date in its name, the cash book is one file for many days. */
export function pickFiles(names: string[], businessDate: string): {report: string | null; books: string[]} {
  const [year, month, day] = businessDate.split('-').map(Number);
  const dated = new RegExp(`(^|[^0-9])0?${day}[._ -]+0?${month}[._ -]+(${year}|${year % 100})([^0-9]|$)`);
  const workbooks = names.filter(name => /\.xlsx$/i.test(name) && !name.startsWith('~$'));
  return {
    report: workbooks.find(name => dated.test(name) && !plain(name).includes('denik')) ?? null,
    books: workbooks.filter(name => plain(name).includes('denik')),
  };
}

async function getJson<T = Item>(url: string, headers: Record<string, string> = {}): Promise<T | null> {
  if (!allowedUrl(url)) return null;
  const response = await fetch(url, {headers: {accept: 'application/json', ...headers}, signal: AbortSignal.timeout(TIMEOUT_MS)}).catch(() => null);
  return response?.ok ? await response.json().catch(() => null) as T | null : null;
}

/** Downloads at most MAX_FILE bytes, following redirects only to Microsoft hosts. */
async function download(start: string, auth: Record<string, string> = {}): Promise<Uint8Array | null> {
  let url = start;
  for (let hop = 0; hop < 5; hop++) {
    if (!allowedUrl(url)) return null;
    // The access goes only to the API host it is for, never along a redirect to another host.
    const headers = hop === 0 || new URL(url).host === new URL(start).host ? auth : {};
    const response = await fetch(url, {redirect: 'manual', headers, signal: AbortSignal.timeout(TIMEOUT_MS)}).catch(() => null);
    if (!response) return null;
    const location = response.headers.get('location');
    if (response.status >= 300 && response.status < 400 && location) { url = new URL(location, url).toString(); continue; }
    if (!response.ok || !response.body || Number(response.headers.get('content-length') || 0) > MAX_FILE) return null;
    const reader = response.body.getReader(), chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.byteLength;
        if (size > MAX_FILE) { await reader.cancel(); return null; }
        chunks.push(part.value);
      }
    } catch { return null; }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    // Every .xlsx is a ZIP file: "PK".
    return bytes[0] === 0x50 && bytes[1] === 0x4b ? bytes : null;
  }
  return null;
}

/** All children of a folder, following paging. */
async function children(api: Api, folder: Item): Promise<Item[]> {
  if (folder.children && !(folder as {'children@odata.nextLink'?: string})['children@odata.nextLink']) return folder.children;
  let next: string | undefined = api.childrenUrl(folder) ?? undefined;
  if (!next) return folder.children ?? [];
  const result: Item[] = [];
  for (let page = 0; next && page < MAX_PAGES; page++) {
    const body: {value?: Item[]; '@odata.nextLink'?: string} | null = await getJson(next, api.headers);
    if (!body) break;
    result.push(...(body.value ?? []));
    next = body['@odata.nextLink'];
  }
  return result;
}

/**
 * Lists the shared folder (and up to a few subfolders, newest first, for a folder per month) and downloads the
 * workbooks of the business day. A link to a single workbook is downloaded as it is. `accessToken` = OKO1's Microsoft
 * access (Graph), or OKO1's Google account for a Google Drive folder; without it the public API is tried.
 */
export async function fetchDayFiles(link: string, businessDate: string, accessToken: string | null = null): Promise<{files: FetchedFile[]; warnings: string[]}> {
  const google = googleFolderId(link);
  if (google) return googleDayFiles(google, businessDate, accessToken);
  const id = shareId(link);
  if (accessToken) {
    const headers = {authorization: `Bearer ${accessToken}`};
    const api: Api = {headers, childrenUrl: folder => folder.id && folder.parentReference?.driveId
      ? `${GRAPH_API}/drives/${encodeURIComponent(folder.parentReference.driveId)}/items/${encodeURIComponent(folder.id)}/children?$top=200` : null};
    const root = await getJson(`${GRAPH_API}/shares/${id}/driveItem?$expand=children`, headers);
    return root ? dayFiles(api, root, businessDate) : {files: [], warnings: ['OneDrive: složka se ani s přístupem OKO1 neotevřela (odkaz neplatí nebo ho vlastník zrušil).']};
  }
  const api: Api = {headers: {}, childrenUrl: folder => folder.id ? `${ONEDRIVE_API}/shares/${id}/items/${encodeURIComponent(folder.id)}/children?$top=200` : null};
  const root = await getJson(`${ONEDRIVE_API}/shares/${id}/root?expand=children`);
  if (!root) {
    if (!allowedUrl(link.trim())) return {files: [], warnings: ['OneDrive: odkaz nevede na OneDrive.']};
    const separator = link.includes('?') ? '&' : '?';
    const single = await download(link.trim() + separator + 'download=1');
    return single ? {files: [{name: 'sdileny-soubor.xlsx', bytes: single}], warnings: []} : {files: [], warnings: ['OneDrive: sdílený odkaz nejde otevřít bez přihlášení. Na přehledu OKO1 v kartě Zdroje dat stačí jednou kliknout na „Připojit OneDrive“.']};
  }
  return dayFiles(api, root, businessDate);
}

async function dayFiles(api: Api, root: Item, businessDate: string): Promise<{files: FetchedFile[]; warnings: string[]}> {
  if (root.file) {
    const url = downloadUrl(root);
    const bytes = url ? await download(url) : null;
    return bytes ? {files: [{name: root.name ?? 'soubor.xlsx', bytes}], warnings: []} : {files: [], warnings: ['OneDrive: soubor nejde stáhnout.']};
  }
  const files = new Map<string, Item>();
  const queue: Item[] = [root];
  for (let visited = 0; queue.length && visited < MAX_FOLDERS; visited++) {
    const folder = queue.shift()!;
    const items = await children(api, folder);
    for (const child of items) if (child.file && child.name && !files.has(child.name)) files.set(child.name, child);
    const picked = pickFiles([...files.keys()], businessDate);
    if (picked.report && picked.books.length) break;
    queue.push(...items.filter(child => child.folder).sort((a, b) => (b.lastModifiedDateTime ?? '').localeCompare(a.lastModifiedDateTime ?? '')));
  }
  const picked = pickFiles([...files.keys()], businessDate);
  // Monthly cash books: the newest few are downloaded; the one with the day's column is used.
  const books = picked.books.sort((a, b) => (files.get(b)!.lastModifiedDateTime ?? '').localeCompare(files.get(a)!.lastModifiedDateTime ?? '')).slice(0, 3);
  const result: FetchedFile[] = [], warnings: string[] = [];
  for (const name of [picked.report, ...books]) {
    if (!name) continue;
    const item = files.get(name)!;
    const url = downloadUrl(item);
    const bytes = (item.size ?? 0) <= MAX_FILE && url ? await download(url) : null;
    if (bytes) result.push({name, bytes}); else warnings.push(`OneDrive: soubor ${name} nejde stáhnout.`);
  }
  if (!picked.report) warnings.push('OneDrive: denní report za tento den ve složce není.');
  if (!books.length) warnings.push('OneDrive: peněžní deník ve složce není.');
  return {files: result, warnings};
}

type GoogleFile = {id: string; name: string; mimeType: string; modifiedTime?: string};
const GOOGLE_FOLDER = 'application/vnd.google-apps.folder', GOOGLE_SHEET = 'application/vnd.google-apps.spreadsheet';
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/** Files of a Google Drive folder that is shared with OKO1's own Google account (read-only), following paging. */
async function googleList(folderId: string, headers: Record<string, string>): Promise<GoogleFile[] | null> {
  const result: GoogleFile[] = [];
  let pageToken = '';
  for (let page = 0; page < MAX_PAGES; page++) {
    const params = new URLSearchParams({q: `'${folderId}' in parents and trashed = false`, fields: 'nextPageToken, files(id, name, mimeType, modifiedTime)',
      pageSize: '200', supportsAllDrives: 'true', includeItemsFromAllDrives: 'true', ...(pageToken ? {pageToken} : {})});
    const body = await getJson<{files?: GoogleFile[]; nextPageToken?: string}>(`${GOOGLE_API}/files?${params}`, headers);
    if (!body) return page ? result : null;
    result.push(...(body.files ?? []));
    if (!body.nextPageToken) break;
    pageToken = body.nextPageToken;
  }
  return result;
}

/** The day's workbooks from Google Drive; Google Sheets are exported as xlsx. `accessToken` = OKO1's Google account. */
async function googleDayFiles(folderId: string, businessDate: string, accessToken: string | null): Promise<{files: FetchedFile[]; warnings: string[]}> {
  if (!accessToken) return {files: [], warnings: ['Google Drive: OKO1 zatím nemá svůj účet u Googlu (tajemství GOOGLE_SERVICE_ACCOUNT).']};
  const headers = {authorization: `Bearer ${accessToken}`};
  const files = new Map<string, GoogleFile>();
  const queue = [folderId];
  let opened = false;
  for (let visited = 0; queue.length && visited < MAX_FOLDERS; visited++) {
    const entries = await googleList(queue.shift()!, headers);
    if (!entries) continue;
    opened = true;
    for (const entry of entries) {
      const name = entry.mimeType === GOOGLE_SHEET && !/\.xlsx$/i.test(entry.name) ? entry.name + '.xlsx' : entry.name;
      if (entry.mimeType !== GOOGLE_FOLDER && !files.has(name)) files.set(name, entry);
    }
    const picked = pickFiles([...files.keys()], businessDate);
    if (picked.report && picked.books.length) break;
    queue.push(...entries.filter(entry => entry.mimeType === GOOGLE_FOLDER).sort((a, b) => (b.modifiedTime ?? '').localeCompare(a.modifiedTime ?? '')).map(entry => entry.id));
  }
  if (!opened) return {files: [], warnings: ['Google Drive: složka není nasdílená účtu OKO1 (ve sdílení přidat jeho e-mail jako Čtenář).']};
  const picked = pickFiles([...files.keys()], businessDate);
  const books = picked.books.sort((a, b) => (files.get(b)!.modifiedTime ?? '').localeCompare(files.get(a)!.modifiedTime ?? '')).slice(0, 3);
  const result: FetchedFile[] = [], warnings: string[] = [];
  for (const name of [picked.report, ...books]) {
    if (!name) continue;
    const entry = files.get(name)!, id = encodeURIComponent(entry.id);
    const bytes = await download(entry.mimeType === GOOGLE_SHEET ? `${GOOGLE_API}/files/${id}/export?mimeType=${encodeURIComponent(XLSX)}` : `${GOOGLE_API}/files/${id}?alt=media&supportsAllDrives=true`, headers);
    if (bytes) result.push({name, bytes}); else warnings.push(`Google Drive: soubor ${name} nejde stáhnout.`);
  }
  if (!picked.report) warnings.push('Google Drive: denní report za tento den ve složce není.');
  if (!books.length) warnings.push('Google Drive: peněžní deník ve složce není.');
  return {files: result, warnings};
}

const plain = (name: string) => name.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

/** Builds the day's report from the downloaded workbooks. Returns null when nothing for the day was found. */
export async function reportFromFiles(files: FetchedFile[], businessDate: string, warnings: string[] = []): Promise<DailyReport | null> {
  const lines: DailyReport['lines'] = [], notes: string[] = [], used: string[] = [];
  const problems = [...warnings];
  let bookUsed = false;
  for (const file of files) {
    let sheets;
    try { sheets = await readXlsx(file.bytes); } catch { problems.push(`Soubor ${file.name} není čitelný sešit Excelu.`); continue; }
    const day = extractDailyReport(sheets);
    const revenue = day.lines.some(entry => entry.kind === 'revenue_section');
    // A cash book holds many days: only the business day counts. A workbook with revenue by section is the day's report,
    // even when its header carries the date (that alone does not make it a cash book).
    const isBook = plain(file.name).includes('denik') || isJournalBook(sheets) || (!revenue && !day.notes.length);
    const book = isBook ? extractCashBook(sheets, businessDate) : null;
    if (book?.length && !bookUsed) { lines.push(...book); used.push(file.name); bookUsed = true; }
    if (!isBook && (revenue || day.notes.length)) {
      lines.push(...day.lines); notes.push(...day.notes); if (!used.includes(file.name)) used.push(file.name);
    }
  }
  if (!lines.length && !notes.length) return null;
  // The daily report's revenue and payments win over the cash book's.
  const reported = lines.some(entry => entry.kind === 'revenue_section' && !entry.label.startsWith(JOURNAL_LABEL));
  // The cash book's revenue by section and its payments stay beside it (`journal_revenue`, `journal_payment`), so that the two can be checked.
  if (reported) lines.splice(0, lines.length, ...lines.filter(entry => !entry.label.startsWith(JOURNAL_LABEL)),
    ...lines.filter(entry => entry.kind === 'revenue_section' && entry.label.startsWith(JOURNAL_LABEL)).map(entry => ({...entry, kind: 'journal_revenue' as const})),
    ...lines.filter(entry => entry.kind === 'payment' && entry.label.startsWith(JOURNAL_LABEL)).map(entry => ({...entry, kind: 'journal_payment' as const})));
  else if (lines.some(entry => entry.kind === 'revenue_section')) problems.push('Denní report chybí, tržby jsou jen z peněžního deníku.');
  if (!lines.some(entry => entry.kind === 'revenue_section')) problems.push('V reportu chybí tržby po částech.');
  return {businessDate, source: 'onedrive', files: used.map(name => name.slice(0, 200)), lines, notes: notes.join('\n').slice(0, 5000) || null, warnings: problems.slice(0, 50).map(text => text.slice(0, 300))};
}
