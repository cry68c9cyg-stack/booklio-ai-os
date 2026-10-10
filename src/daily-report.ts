/**
 * The managers' daily report (interim until Pexeso runs): what the Excel files on OneDrive say about one business day,
 * as flat lines. Amounts in whole haléře. Nothing is dropped: rows the rules do not recognise are kept as `unmapped`.
 */
import {InputError} from './validate.ts';
import {excelDate, type CellValue, type Sheet} from './xlsx.ts';
import {isDate} from './time.ts';

export const LINE_KINDS = ['revenue_section', 'revenue_register', 'payment', 'discount', 'void', 'expense', 'payout', 'movement', 'cash_count', 'balance', 'total', 'unmapped'] as const;
export type LineKind = typeof LINE_KINDS[number];
export type ReportLine = {kind: LineKind; key: string; label: string; count: number | null; amountCents: number};
export type DailyReport = {
  businessDate: string;
  source: 'onedrive' | 'admin';
  /** File names the report was read from (no paths, no links). */
  files: string[];
  lines: ReportLine[];
  /** The free-text "Report dne" written by the manager. */
  notes: string | null;
  warnings: string[];
};

const fail = (): never => { throw new InputError('INVALID_REPORT'); };

/** Lowercase ASCII slug: "Žárovky 2" → "zarovky-2". */
export const slug = (value: string) => value.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'x';
const norm = (value: string) => slug(value).replace(/-/g, ' ');

export function validateDailyReport(raw: unknown): DailyReport {
  const value = raw as Record<string, unknown>;
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail();
  const keys = ['businessDate', 'source', 'files', 'lines', 'notes', 'warnings'];
  if (Object.keys(value).some(key => !keys.includes(key)) || keys.some(key => !(key in value))) fail();
  if (!isDate(value.businessDate) || (value.source !== 'onedrive' && value.source !== 'admin')) fail();
  const strings = (list: unknown, max: number, length: number) => {
    if (!Array.isArray(list) || list.length > max || list.some(item => typeof item !== 'string' || item.length > length)) fail();
    return list as string[];
  };
  if (!Array.isArray(value.lines) || value.lines.length > 1000) fail();
  const lines = (value.lines as unknown[]).map(item => {
    const line = item as Record<string, unknown>;
    if (!line || typeof line !== 'object' || Object.keys(line).length !== 5) fail();
    if (!LINE_KINDS.includes(line.kind as LineKind) || typeof line.key !== 'string' || !/^[\w.:-]{1,60}$/.test(line.key)
      || typeof line.label !== 'string' || line.label.length > 100 || !Number.isSafeInteger(line.amountCents)
      || !(line.count === null || (Number.isSafeInteger(line.count) && (line.count as number) >= 0))) fail();
    return {kind: line.kind as LineKind, key: line.key as string, label: line.label as string, count: line.count as number | null, amountCents: line.amountCents as number};
  });
  if (value.notes !== null && (typeof value.notes !== 'string' || value.notes.length > 5000)) fail();
  return {businessDate: value.businessDate as string, source: value.source as DailyReport['source'], files: strings(value.files, 10, 200),
    lines, notes: (value.notes as string | null)?.trim() || null, warnings: strings(value.warnings, 50, 300)};
}

/** Crowns as Excel stores them (number or text like "67 532 Kč" / "−1 600,50") → haléře. */
export function toCents(value: CellValue | undefined): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? Math.round(value * 100) : null;
  if (typeof value !== 'string') return null;
  const text = value.replace(/[\s ]/g, '').replace(/kč$/i, '').replace(/[−–]/g, '-').replace(',', '.');
  return /^-?\d+(\.\d+)?$/.test(text) ? Math.round(Number(text) * 100) : null;
}

type Row = {label: string; numbers: number[]; texts: string[]};
/** Each row as its first text cell (the label) and the cells to the right of it. */
function rows(sheet: Sheet, column?: number, afterRow = 0): Row[] {
  const result: Row[] = [];
  for (const [index, cells] of [...sheet.cells].sort((a, b) => a[0] - b[0])) {
    if (index <= afterRow) continue;
    const ordered = [...cells].sort((a, b) => a[0] - b[0]);
    const first = ordered.findIndex(([, value]) => typeof value === 'string' && toCents(value) === null);
    if (first < 0) continue;
    const [labelColumn, label] = ordered[first];
    const right = ordered.slice(first + 1);
    if (column !== undefined) {
      if (labelColumn >= column) continue;
      const cell = cells.get(column);
      result.push({label: String(label).trim(), numbers: toCents(cell) === null ? [] : [toCents(cell)!], texts: typeof cell === 'string' && toCents(cell) === null ? [cell] : []});
    } else {
      result.push({label: String(label).trim(),
        numbers: right.map(([, value]) => toCents(value)).filter((value): value is number => value !== null),
        texts: right.map(([, value]) => value).filter((value): value is string => typeof value === 'string' && toCents(value) === null)});
    }
  }
  return result;
}

type Rule = {match: RegExp; kind: LineKind; key: string | ((label: string, found: RegExpMatchArray) => string)};
/**
 * Labels of the "Denní report" file (from the photos of the report of 9. 10. 2026; to be confirmed on the trial files).
 * Sections follow the specification §3: Restaurace den = diner, Restaurace noc = bar, Club celkem = club.
 */
const REPORT_RULES: Rule[] = [
  {match: /^restaurace den\b/, kind: 'revenue_section', key: 'diner'},
  {match: /^restaurace noc\b/, kind: 'revenue_section', key: 'bar'},
  {match: /^(club|klub) celkem\b/, kind: 'revenue_section', key: 'club'},
  {match: /^pokladna (\d)\b/, kind: 'revenue_register', key: (_, found) => `club-${found[1]}`},
  {match: /^texaco\b/, kind: 'revenue_register', key: 'texaco'},
  {match: /^hotovost\b/, kind: 'payment', key: 'cash'},
  {match: /^karty\b/, kind: 'payment', key: 'card'},
  {match: /^zakaznicke karty\b/, kind: 'payment', key: 'customer_card'},
  {match: /^celkem podle vyjezdu\b/, kind: 'total', key: 'payments'},
  {match: /^storn/, kind: 'void', key: 'void'},
  {match: /^(odpis|promo|personal|sleva|slevy \d|mz$|ig$|cosmo)/, kind: 'discount', key: label => slug(label)},
  {match: /^(slevy a odpisy )?celkem\b/, kind: 'total', key: 'discounts'},
];

/** Rows of the "Peněžní deník" sheet, read in the column of the business day. Headers open blocks. */
const BOOK_BLOCKS: {match: RegExp; block: 'expense' | 'payout' | 'cash_count' | 'total'}[] = [
  {match: /^naklady\b/, block: 'expense'},
  {match: /^vyplaty\b/, block: 'payout'},
  {match: /^total\b/, block: 'total'},
  {match: /^(prepocet|prepocitani|euro\b)/, block: 'cash_count'},
];
const BOOK_RULES: Rule[] = [
  {match: /^banka\b/, kind: 'balance', key: 'bank'},
  {match: /^trezor\b/, kind: 'balance', key: 'safe'},
  {match: /^pokladna\b/, kind: 'balance', key: 'register'},
  {match: /^(vklad|odvod)/, kind: 'movement', key: label => slug(label)},
];

function apply(rules: Rule[], label: string): {kind: LineKind; key: string} | null {
  const text = norm(label);
  for (const rule of rules) {
    const found = text.match(rule.match);
    if (found) return {kind: rule.kind, key: typeof rule.key === 'string' ? rule.key : rule.key(label, found)};
  }
  return null;
}

const NOTE_LABEL = /^(report dne|poznamk|udalosti)/;

/** The "Denní report" workbook of one day. */
export function extractDailyReport(sheets: Sheet[]): {lines: ReportLine[]; notes: string[]} {
  const lines: ReportLine[] = [], notes: string[] = [];
  const seen = new Set<string>();
  for (const sheet of sheets) {
    for (const row of rows(sheet)) {
      const text = norm(row.label);
      if (NOTE_LABEL.test(text)) { if (row.texts.length) notes.push(row.texts.join(' ')); continue; }
      if (/^dj\b/.test(text)) { if (row.texts.length) notes.push(`DJ: ${row.texts.join(', ')}`); continue; }
      if (!row.numbers.length) continue;
      const rule = apply(REPORT_RULES, row.label) ?? {kind: 'unmapped' as const, key: slug(row.label)};
      // The same label repeated (charts, copies on other sheets) counts once.
      const id = `${rule.kind}:${rule.key}`;
      if (seen.has(id)) continue;
      seen.add(id);
      // Discount rows carry count and amount; every other row only an amount.
      const counted = rule.kind === 'discount' || rule.kind === 'void' || rule.key === 'discounts';
      const [count, amount] = counted && row.numbers.length >= 2 ? [row.numbers[0] / 100, row.numbers[1]] : [null, row.numbers[0]];
      lines.push({kind: rule.kind, key: rule.key, label: row.label.slice(0, 100), count: count !== null && Number.isSafeInteger(count) && count >= 0 ? count : null, amountCents: amount});
    }
  }
  return {lines, notes};
}

/** Finds the column whose header is the business day: an Excel date number or text such as "9.10." / "9. 10. 2026". */
export function dayColumn(sheet: Sheet, businessDate: string): {row: number; column: number} | null {
  const [year, month, day] = businessDate.split('-').map(Number);
  const textual = new RegExp(`^\\s*0?${day}\\.\\s*0?${month}\\.(\\s*(${year}|${year % 100}))?\\s*$`);
  for (const [row, cells] of [...sheet.cells].sort((a, b) => a[0] - b[0])) {
    for (const [column, value] of cells) {
      if (typeof value === 'number' && value > 40000 && value < 80000 && Number.isInteger(value) && excelDate(value) === businessDate) return {row, column};
      if (typeof value === 'string' && textual.test(value)) return {row, column};
    }
  }
  return null;
}

/** The "Peněžní deník" workbook: the column of the business day on the first sheet that has one. */
export function extractCashBook(sheets: Sheet[], businessDate: string): ReportLine[] | null {
  for (const sheet of sheets) {
    const found = dayColumn(sheet, businessDate);
    if (found === null) continue;
    const lines: ReportLine[] = [];
    let block: typeof BOOK_BLOCKS[number]['block'] | null = null;
    const used = new Map<string, number>();
    for (const row of rows(sheet, found.column, found.row)) {
      const header = BOOK_BLOCKS.find(entry => entry.match.test(norm(row.label)));
      if (header) block = header.block;
      if (!row.numbers.length) continue;
      let rule = apply(BOOK_RULES, row.label);
      if (!rule || block === 'cash_count') rule = block ? {kind: block === 'total' ? 'total' : block, key: slug(row.label)} : {kind: 'unmapped', key: slug(row.label)};
      // Rows without an amount for the day are skipped; repeated labels get a suffix so nothing overwrites.
      if (row.numbers[0] === 0) continue;
      const n = (used.get(`${rule.kind}:${rule.key}`) ?? 0) + 1;
      used.set(`${rule.kind}:${rule.key}`, n);
      lines.push({kind: rule.kind, key: n > 1 ? `${rule.key}-${n}`.slice(0, 60) : rule.key, label: row.label.slice(0, 100), count: null, amountCents: row.numbers[0]});
    }
    return lines;
  }
  return null;
}

/** Sum of the lines of one kind. */
export const total = (report: Pick<DailyReport, 'lines'>, kind: LineKind) => report.lines.filter(line => line.kind === kind).reduce((sum, line) => sum + line.amountCents, 0);
export const line = (report: Pick<DailyReport, 'lines'>, kind: LineKind, key: string) => report.lines.find(entry => entry.kind === kind && entry.key === key) ?? null;
