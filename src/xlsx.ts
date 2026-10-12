/** Reads cell values from an .xlsx workbook. Values only: no styles, formulas are read as their cached result. */
import {unzip} from './zip.ts';

export type CellValue = string | number | boolean;
/** One sheet as a sparse grid; rows and columns are numbered from 1 like in Excel. */
export type Sheet = {name: string; cells: Map<number, Map<number, CellValue>>};

const entities: Record<string, string> = {amp: '&', lt: '<', gt: '>', quot: '"', apos: "'"};
const decodeXml = (value: string) => value.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, code: string) =>
  code[0] === '#' ? String.fromCodePoint(code[1] === 'x' || code[1] === 'X' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10)) : entities[code.toLowerCase()]);
const attr = (tag: string, name: string) => tag.match(new RegExp(`\\s${name}="([^"]*)"`))?.[1];
/** Text of all <t> runs inside a fragment (shared strings and inline strings may be split into rich-text runs). */
const runs = (xml: string) => [...xml.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map(match => decodeXml(match[1])).join('');

/** "AB12" → column 28, row 12. */
export function cellRef(ref: string): {column: number; row: number} {
  const match = ref.match(/^([A-Z]{1,3})(\d+)$/);
  if (!match) throw new Error('BAD_CELL_REF');
  let column = 0;
  for (const letter of match[1]) column = column * 26 + letter.charCodeAt(0) - 64;
  return {column, row: Number(match[2])};
}

function parseSheet(name: string, xml: string, shared: string[]): Sheet {
  const cells = new Map<number, Map<number, CellValue>>();
  for (const match of xml.matchAll(/<c\s([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
    const tag = ' ' + match[1], body = match[2] ?? '';
    const ref = attr(tag, 'r');
    if (!ref) continue;
    const type = attr(tag, 't') ?? 'n';
    const raw = body.match(/<v>([\s\S]*?)<\/v>/)?.[1];
    let value: CellValue | undefined;
    if (type === 'inlineStr') value = runs(body.match(/<is>([\s\S]*?)<\/is>/)?.[1] ?? '');
    else if (raw === undefined) continue;
    else if (type === 's') value = shared[Number(raw)] ?? '';
    else if (type === 'str') value = decodeXml(raw);
    else if (type === 'b') value = raw === '1';
    else if (type === 'e') continue;
    else { const number = Number(raw); if (Number.isFinite(number)) value = number; }
    if (value === undefined || value === '') continue;
    const {column, row} = cellRef(ref);
    if (!cells.has(row)) cells.set(row, new Map());
    cells.get(row)!.set(column, value);
  }
  return {name, cells};
}

/** All sheets in workbook order. */
export async function readXlsx(bytes: Uint8Array): Promise<Sheet[]> {
  const files = await unzip(bytes, name => name === 'xl/workbook.xml' || name === 'xl/_rels/workbook.xml.rels'
    || name === 'xl/sharedStrings.xml' || /^xl\/worksheets\/[^/]+\.xml$/.test(name));
  const text = (name: string) => { const file = files.get(name); return file ? new TextDecoder().decode(file) : null; };
  const workbook = text('xl/workbook.xml'), rels = text('xl/_rels/workbook.xml.rels');
  if (!workbook || !rels) throw new Error('NOT_A_WORKBOOK');
  const shared = [...(text('xl/sharedStrings.xml') ?? '').matchAll(/<si>([\s\S]*?)<\/si>/g)].map(match => runs(match[1]));
  const targets = new Map([...rels.matchAll(/<Relationship\s[^>]*>/g)].map(match => [attr(match[0], 'Id'), attr(match[0], 'Target')]));
  const sheets: Sheet[] = [];
  for (const match of workbook.matchAll(/<sheet\s[^>]*>/g)) {
    const target = targets.get(attr(match[0], 'r:id'));
    if (!target) continue;
    const path = target.startsWith('/') ? target.slice(1) : 'xl/' + target.replace(/^\.\//, '');
    const xml = text(path);
    if (xml) sheets.push(parseSheet(decodeXml(attr(match[0], 'name') ?? ''), xml, shared));
  }
  return sheets;
}

/** Excel serial day number (1900 date system) → YYYY-MM-DD. */
export function excelDate(serial: number): string {
  return new Date(Math.round((serial - 25569) * 86400000)).toISOString().slice(0, 10);
}
