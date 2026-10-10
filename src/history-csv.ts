import {isDate} from './time.ts';
import type {HistoryRow} from './validate.ts';

/**
 * Parses a daily revenue export (e.g. from rkeeper) into history rows.
 * Accepts `;`, `,` or tab as separator, Czech or ISO dates and amounts like "84 320,50".
 * Required columns: date and revenue; bills and guests are optional.
 */
const aliases: Record<keyof HistoryRow, string[]> = {
  businessDate: ['datum', 'date', 'den', 'business_date', 'businessdate'],
  revenueCents: ['trzba', 'tržba', 'revenue', 'trzba s dph', 'tržba s dph', 'celkem', 'total'],
  bills: ['ucty', 'účty', 'pocet uctu', 'počet účtů', 'bills', 'checks'],
  guests: ['hoste', 'hosté', 'pocet hostu', 'počet hostů', 'guests', 'covers'],
};

export class CsvError extends Error {}

function normalize(header: string): string {
  return header.trim().toLowerCase().replace(/^﻿/, '').replace(/\s+/g, ' ');
}

function splitLine(line: string, separator: string): string[] {
  const cells: string[] = [];
  let cell = '', quoted = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      if (quoted && line[i + 1] === '"') { cell += '"'; i++; } else quoted = !quoted;
    } else if (char === separator && !quoted) { cells.push(cell); cell = ''; } else cell += char;
  }
  cells.push(cell);
  return cells.map(value => value.trim());
}

export function parseDate(value: string): string | null {
  const date = toIso(value.trim());
  return date && isDate(date) ? date : null;
}

function toIso(value: string): string | null {
  let match = value.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (match) return `${match[1]}-${match[2].padStart(2, '0')}-${match[3].padStart(2, '0')}`;
  match = value.match(/^(\d{1,2})\.\s*(\d{1,2})\.\s*(\d{4})/);
  if (match) return `${match[3]}-${match[2].padStart(2, '0')}-${match[1].padStart(2, '0')}`;
  return null;
}

/** "84 320,50", "84320.5", "84 320 Kč" → 8432050 haléřů. */
export function parseCrowns(value: string): number | null {
  let text = value.replace(/kč|czk/gi, '').replace(/[\s  ]/g, '');
  if (!text) return null;
  if (text.includes(',') && text.includes('.')) {
    text = text.lastIndexOf(',') > text.lastIndexOf('.') ? text.replace(/\./g, '').replace(',', '.') : text.replace(/,/g, '');
  } else text = text.replace(',', '.');
  if (!/^-?\d+(\.\d{1,2})?$/.test(text)) return null;
  return Math.round(Number(text) * 100);
}

function parseCount(value: string): number | null {
  if (!value) return null;
  const number = Number(value.replace(/[\s ]/g, ''));
  return Number.isSafeInteger(number) && number >= 0 ? number : NaN;
}

export function parseHistoryCsv(text: string): HistoryRow[] {
  const lines = text.split(/\r?\n/).filter(line => line.trim());
  if (lines.length < 2) throw new CsvError('Soubor nemá hlavičku a aspoň jeden řádek.');
  const separator = [';', '\t', ','].map(sep => [sep, lines[0].split(sep).length] as const).sort((a, b) => b[1] - a[1])[0][0];
  const headers = splitLine(lines[0], separator).map(normalize);
  const column = Object.fromEntries(Object.entries(aliases).map(([key, names]) => [key, headers.findIndex(header => names.includes(header))])) as Record<keyof HistoryRow, number>;
  if (column.businessDate < 0 || column.revenueCents < 0) throw new CsvError(`Chybí sloupec s datem nebo tržbou. Nalezené sloupce: ${headers.join(', ')}`);
  const rows = new Map<string, HistoryRow>();
  lines.slice(1).forEach((line, index) => {
    const cells = splitLine(line, separator), row = index + 2;
    const businessDate = parseDate(cells[column.businessDate] ?? '');
    const revenueCents = parseCrowns(cells[column.revenueCents] ?? '');
    if (!businessDate) throw new CsvError(`Řádek ${row}: neplatné datum „${cells[column.businessDate]}“.`);
    if (revenueCents === null || revenueCents < 0) throw new CsvError(`Řádek ${row}: neplatná tržba „${cells[column.revenueCents]}“.`);
    const bills = column.bills >= 0 ? parseCount(cells[column.bills] ?? '') : null;
    const guests = column.guests >= 0 ? parseCount(cells[column.guests] ?? '') : null;
    if (Number.isNaN(bills) || Number.isNaN(guests)) throw new CsvError(`Řádek ${row}: neplatný počet účtů nebo hostů.`);
    // Several rows for one day (e.g. one per register) are added together.
    const previous = rows.get(businessDate);
    rows.set(businessDate, previous ? {
      businessDate,
      revenueCents: previous.revenueCents + revenueCents,
      bills: previous.bills === null || bills === null ? null : previous.bills + bills,
      guests: previous.guests === null || guests === null ? null : previous.guests + guests,
    } : {businessDate, revenueCents, bills, guests});
  });
  return [...rows.values()].sort((a, b) => a.businessDate.localeCompare(b.businessDate));
}
