// Builds small synthetic .xlsx files for tests. Cell values: strings go to shared strings, numbers stay numbers.

const crcTable = Array.from({length: 256}, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (data: Uint8Array) => {
  let c = 0xffffffff;
  for (const byte of data) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

async function deflate(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data]).stream().pipeThrough(new CompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** ZIP with the given files; `deflated` = compress (method 8), otherwise stored (method 0). */
export async function zip(files: Record<string, string>, deflated = true): Promise<Uint8Array> {
  const encoder = new TextEncoder();
  const locals: Uint8Array[] = [], central: Uint8Array[] = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const raw = encoder.encode(content), data = deflated ? await deflate(raw) : raw, nameBytes = encoder.encode(name);
    const local = new Uint8Array(30 + nameBytes.length + data.length), lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true); lv.setUint16(4, 20, true); lv.setUint16(8, deflated ? 8 : 0, true);
    lv.setUint32(14, crc32(raw), true); lv.setUint32(18, data.length, true); lv.setUint32(22, raw.length, true); lv.setUint16(26, nameBytes.length, true);
    local.set(nameBytes, 30); local.set(data, 30 + nameBytes.length);
    const entry = new Uint8Array(46 + nameBytes.length), cv = new DataView(entry.buffer);
    cv.setUint32(0, 0x02014b50, true); cv.setUint16(4, 20, true); cv.setUint16(6, 20, true); cv.setUint16(10, deflated ? 8 : 0, true);
    cv.setUint32(16, crc32(raw), true); cv.setUint32(20, data.length, true); cv.setUint32(24, raw.length, true); cv.setUint16(28, nameBytes.length, true);
    cv.setUint32(42, offset, true); entry.set(nameBytes, 46);
    locals.push(local); central.push(entry); offset += local.length;
  }
  const size = central.reduce((sum, part) => sum + part.length, 0);
  const end = new Uint8Array(22), ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true); ev.setUint16(8, central.length, true); ev.setUint16(10, central.length, true);
  ev.setUint32(12, size, true); ev.setUint32(16, offset, true);
  const parts = [...locals, ...central, end], result = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) { result.set(part, at); at += part.length; }
  return result;
}

const escape = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const column = (n: number) => { let s = ''; for (n++; n; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + (n - 1) % 26) + s; return s; };

/** Workbook from sheets given as rows of values (null = empty cell). */
export async function xlsx(sheets: Record<string, (string | number | null)[][]>, deflated = true): Promise<Uint8Array> {
  const shared: string[] = [];
  const files: Record<string, string> = {};
  const names = Object.keys(sheets);
  names.forEach((name, i) => {
    const rows = sheets[name].map((row, r) => `<row r="${r + 1}">` + row.map((value, c) => {
      if (value === null) return '';
      const ref = column(c) + (r + 1);
      if (typeof value === 'number') return `<c r="${ref}"><v>${value}</v></c>`;
      shared.push(value);
      return `<c r="${ref}" t="s"><v>${shared.length - 1}</v></c>`;
    }).join('') + '</row>').join('');
    files[`xl/worksheets/sheet${i + 1}.xml`] = `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><cols><col min="1" max="1"/></cols><sheetData>${rows}</sheetData></worksheet>`;
  });
  files['xl/workbook.xml'] = `<?xml version="1.0"?><workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${
    names.map((name, i) => `<sheet name="${escape(name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>`;
  files['xl/_rels/workbook.xml.rels'] = `<?xml version="1.0"?><Relationships>${
    names.map((_, i) => `<Relationship Id="rId${i + 1}" Type="worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}</Relationships>`;
  files['xl/sharedStrings.xml'] = `<?xml version="1.0"?><sst>${shared.map(value => `<si><t xml:space="preserve">${escape(value)}</t></si>`).join('')}</sst>`;
  files['[Content_Types].xml'] = '<?xml version="1.0"?><Types/>';
  return zip(files, deflated);
}

/** Synthetic daily report in the layout of the managers' Excel (made-up numbers and names). */
export const reportSheets = (day = '9.10.2026') => ({
  'Denní report': [
    [`Denní report ${day}`],
    ['Tržby', null, 'Kč'],
    ['Restaurace den', null, 60000],
    ['Restaurace noc', null, 150000],
    ['Club celkem', null, 180000],
    ['Pokladna 1', null, 2000],
    ['Pokladna 2', null, 60000],
    ['Pokladna 3', null, 78000],
    ['Texaco', null, 40000],
    ['Hotovost', null, 10000],
    ['Karty', null, 380000],
    ['Celkem podle výjezdů', null, 390000],
    ['Storno', 0, 0],
    ['DJ', 'Zdeněk'],
    ['Slevy a odpisy', 'počet', 'Kč'],
    ['Personál', 15, 3600],
    ['Sleva 20 %', 4, 1200.5],
    ['Odpisy Club', 2, 900],
    ['Celkem', 21, 5700.5],
    ['Neznámý řádek', null, 123],
    ['Report dne', 'Host Novák rozbil sklenici u stolu 4. Na baru došel led, objednat. Kontrola hygieny v pondělí.'],
  ],
});

/** Synthetic cash book: a column per day, header row with Excel date numbers. */
export const bookSheets = () => ({
  'Říjen': [
    ['Peněžní deník', null, 46303, 46304],
    ['Banka', null, 300000, 310000],
    ['Trezor', null, 5000, -20000],
    ['Pokladna', null, 140000, 142000],
    ['Náklady', null, null, null],
    ['Karty', null, 300000, 380000],
    ['Obi', null, null, 1000],
    ['Oprava zápisu', null, null, -700],
    ['Žárovky', null, 300, 300],
    ['Vklad JD', null, null, -50000],
    ['Výplaty', null, null, null],
    ['Security', null, 8000, 8000],
    ['DJ', null, 5000, 5000],
    ['TOTAL', null, null, null],
    ['Dát do trezoru', null, 1000, 40000],
    ['Celkem', null, 1, 2],
    ['Euro', null, 50000, 52000],
    ['Dolar', null, null, 11000],
  ],
});

/** Synthetic daily report as the managers really save it: the date in the header row, a bare "SLEVY" block, "CELKEM" at its end. */
export const reportSheetsDated = () => ({
  List1: [
    [null, 'ST', '09.10.2026', 'suma'],
    [null, null, 'RESTAURACE DEN', 50000],
    [null, null, 'RESTAURACE NOC', 100000],
    [null, null, 'CLUB Celkem', 150000],
    [null, null, 'HOTOVOST', 20000],
    [null, null, 'KARTY', 280000],
    [null, null, 'CELKEM podle výjezdů', 300000],
    [null, null, 'Storno:', 0],
    [null, null, 'SLEVY'],
    [null, null, 'Personál', 10, 2000],
    [null, null, 'Promo Club', 2, 1000],
    [null, null, 'CELKEM', null, 3000],
  ],
});

/** Synthetic cash book as a journal: a block per day from "Počáteční stav" (with the date) to "Zůstatek", cash count beside it. */
export const journalSheets = () => {
  const row = (date: number | null, text: string | null, amount: number | null, side: [string, number] | null = null, revenue: (string | number)[] | null = null) =>
    [date, null, text, amount, null, null, null, revenue?.[0] ?? null, null, revenue?.[1] ?? null, revenue?.[2] ?? null, null, side?.[0] ?? null, side?.[1] ?? null];
  const headers = ['Karty', 'Zákaznické karty', 'Tržba celkem'];
  return {
    List1: [
      [null, 'Doklad', 'Text', 'Hotovost'],
      row(46303, 'Počáteční stav', 100000),
      row(null, 'Dodavatel A', 999),
      row(null, 'Zůstatek', 99001),
      row(46304, 'Počáteční stav', 99001, null, headers),
      row(null, 'Dodavatel B', 2000),
      row(null, 'Vklad JD', -50000),
      row(null, 'Prodej oleje', -1000),
      row(null, null, 0, ['Euro', 40000]),
      row(null, 'Tržba Restaurace den', 3000, ['Trezor', 30000], [47000, 0, 50000]),
      row(null, 'Security', 6000, ['Hotovost', 100000]),
      row(null, 'DJ', 4000, ['Celkem', 170000]),
      row(null, 'DJ oprava světel', 1500),
      row(null, 'Zkouška barman', 700),
      row(null, 'Tržba Restaurace noc', 2000, null, [98000, 0, 100000]),
      row(null, 'Tržba Texaco bar', 0, null, [40000, 0, 40000]),
      row(null, 'Tržba Club', 0, null, [110000, 0, 110000]),
      row(null, 'Tržba hotovost + karty celkem + ZK', 5000, null, [295000, 0, 300000]),
      row(null, 'Zůstatek', 140801),
      row(46305, 'Počáteční stav', 140801),
      row(null, 'Dodavatel C', 300),
    ],
  };
};
