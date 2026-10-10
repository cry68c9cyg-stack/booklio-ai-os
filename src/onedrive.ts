/**
 * Reads the managers' Excel files from a OneDrive folder shared with a read-only link ("anyone with the link can view").
 * No Microsoft account or app for OKO1: the share link is the only credential, and it can only read.
 */
import {extractCashBook, extractDailyReport, type DailyReport} from './daily-report.ts';
import {readXlsx} from './xlsx.ts';

export type FetchedFile = {name: string; bytes: Uint8Array};
type Item = {name?: string; size?: number; folder?: unknown; file?: unknown; lastModifiedDateTime?: string; '@content.downloadUrl'?: string; children?: Item[]; id?: string};

const ONEDRIVE_API = 'https://api.onedrive.com/v1.0';
const MAX_FILE = 10 * 1024 * 1024;
const MAX_FOLDERS = 6;

/** Share id for the sharing API: "u!" + unpadded base64url of the link. */
export function shareId(link: string): string {
  const bytes = new TextEncoder().encode(link.trim());
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return 'u!' + btoa(binary).replace(/=+$/, '').replace(/\//g, '_').replace(/\+/g, '-');
}

/** The file names that can hold the day: the daily report carries the date in its name, the cash book is one file for many days. */
export function pickFiles(names: string[], businessDate: string): {report: string | null; book: string | null} {
  const [year, month, day] = businessDate.split('-').map(Number);
  const dated = new RegExp(`(^|[^0-9])0?${day}[._ -]+0?${month}[._ -]+(${year}|${year % 100})([^0-9]|$)`);
  const workbooks = names.filter(name => /\.xlsx$/i.test(name) && !name.startsWith('~$'));
  const plain = (name: string) => name.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  return {
    report: workbooks.find(name => dated.test(name) && !plain(name).includes('denik')) ?? null,
    book: workbooks.find(name => plain(name).includes('denik')) ?? null,
  };
}

async function getJson(url: string): Promise<Item | null> {
  const response = await fetch(url, {headers: {accept: 'application/json'}});
  return response.ok ? await response.json() as Item : null;
}

async function download(url: string): Promise<Uint8Array | null> {
  const response = await fetch(url, {redirect: 'follow'});
  if (!response.ok) return null;
  if (Number(response.headers.get('content-length') || 0) > MAX_FILE) return null;
  const bytes = new Uint8Array(await response.arrayBuffer());
  // Every .xlsx is a ZIP file: "PK".
  return bytes.length <= MAX_FILE && bytes[0] === 0x50 && bytes[1] === 0x4b ? bytes : null;
}

/**
 * Lists the shared folder (and up to a few subfolders, newest first, for a folder per month) and downloads the
 * workbooks of the business day. A link to a single workbook is downloaded as it is.
 */
export async function fetchDayFiles(link: string, businessDate: string): Promise<{files: FetchedFile[]; warnings: string[]}> {
  const id = shareId(link);
  const root = await getJson(`${ONEDRIVE_API}/shares/${id}/root?expand=children`);
  if (!root) {
    const separator = link.includes('?') ? '&' : '?';
    const single = await download(link.trim() + separator + 'download=1');
    return single ? {files: [{name: 'sdileny-soubor.xlsx', bytes: single}], warnings: []} : {files: [], warnings: ['OneDrive: sdílený odkaz nejde otevřít bez přihlášení.']};
  }
  if (root.file) {
    const bytes = root['@content.downloadUrl'] ? await download(root['@content.downloadUrl']) : null;
    return bytes ? {files: [{name: root.name ?? 'soubor.xlsx', bytes}], warnings: []} : {files: [], warnings: ['OneDrive: soubor nejde stáhnout.']};
  }
  const files = new Map<string, Item>();
  const queue: Item[] = [root];
  for (let visited = 0; queue.length && visited < MAX_FOLDERS; visited++) {
    const folder = queue.shift()!;
    const children = folder.children ?? (folder.id ? (await getJson(`${ONEDRIVE_API}/shares/${id}/items/${encodeURIComponent(folder.id)}/children`) as {value?: Item[]} | null)?.value ?? [] : []);
    for (const child of children) if (child.file && child.name && !files.has(child.name)) files.set(child.name, child);
    const picked = pickFiles([...files.keys()], businessDate);
    if (picked.report && picked.book) break;
    queue.push(...children.filter(child => child.folder).sort((a, b) => (b.lastModifiedDateTime ?? '').localeCompare(a.lastModifiedDateTime ?? '')));
  }
  const picked = pickFiles([...files.keys()], businessDate);
  const result: FetchedFile[] = [], warnings: string[] = [];
  for (const name of [picked.report, picked.book]) {
    if (!name) continue;
    const item = files.get(name)!;
    const bytes = (item.size ?? 0) <= MAX_FILE && item['@content.downloadUrl'] ? await download(item['@content.downloadUrl']) : null;
    if (bytes) result.push({name, bytes}); else warnings.push(`OneDrive: soubor ${name} nejde stáhnout.`);
  }
  if (!picked.report) warnings.push('OneDrive: denní report za tento den ve složce není.');
  if (!picked.book) warnings.push('OneDrive: peněžní deník ve složce není.');
  return {files: result, warnings};
}

/** Builds the day's report from the downloaded workbooks. Returns null when nothing for the day was found. */
export async function reportFromFiles(files: FetchedFile[], businessDate: string, warnings: string[] = []): Promise<DailyReport | null> {
  const lines: DailyReport['lines'] = [], notes: string[] = [], used: string[] = [];
  const problems = [...warnings];
  for (const file of files) {
    let sheets;
    try { sheets = await readXlsx(file.bytes); } catch { problems.push(`Soubor ${file.name} není čitelný sešit Excelu.`); continue; }
    const book = extractCashBook(sheets, businessDate);
    const day = extractDailyReport(sheets);
    // A cash book holds many days: only its column for the business day counts. Any other workbook is the day's report.
    if (book) { lines.push(...book); used.push(file.name); }
    const isBook = file.name.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().includes('denik');
    if (files.length === 1 || (!book && !isBook)) {
      const revenue = day.lines.some(entry => entry.kind === 'revenue_section');
      if (revenue || day.notes.length) { lines.push(...day.lines.filter(entry => !book || entry.kind !== 'unmapped')); notes.push(...day.notes); if (!used.includes(file.name)) used.push(file.name); }
    }
  }
  if (!lines.length && !notes.length) return null;
  if (!lines.some(entry => entry.kind === 'revenue_section')) problems.push('V reportu chybí tržby po částech.');
  return {businessDate, source: 'onedrive', files: used.map(name => name.slice(0, 200)), lines, notes: notes.join('\n').slice(0, 5000) || null, warnings: problems.slice(0, 50).map(text => text.slice(0, 300))};
}
