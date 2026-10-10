import assert from 'node:assert/strict';
import {test} from 'node:test';
import {buildBriefing, renderBriefing} from '../src/briefing.ts';
import {extractCashBook, extractDailyReport, line, toCents, total, validateDailyReport, type DailyReport} from '../src/daily-report.ts';
import {parseAnalysis, pseudonymise, restore} from '../src/notes.ts';
import {pickFiles, reportFromFiles, shareId} from '../src/onedrive.ts';
import {InputError, validateConfig, type TenantConfig} from '../src/validate.ts';
import {excelDate, readXlsx} from '../src/xlsx.ts';
import {bookSheets, reportSheets, xlsx} from './xlsx-fixture.ts';

const config: TenantConfig = {
  name: 'Testovací podnik', timeZone: 'Europe/Prague', businessDayCutoffHour: 6, sendHours: [7, 8, 9],
  registers: ['diner', 'bar', 'klub'], sections: {diner: 'Diner', bar: 'Bar', club: 'Klub'}, recipients: [], bottleCheck: null, reportsLink: null,
};

test('xlsx: stored and deflated workbooks, shared strings, numbers, Excel dates', async () => {
  for (const deflated of [true, false]) {
    const sheets = await readXlsx(await xlsx({'List 1': [['Tržba', 1200.5], [null, 'a & b']], 'Druhý': [[1]]}, deflated));
    assert.deepEqual(sheets.map(sheet => sheet.name), ['List 1', 'Druhý']);
    assert.equal(sheets[0].cells.get(1)!.get(1), 'Tržba');
    assert.equal(sheets[0].cells.get(1)!.get(2), 1200.5);
    assert.equal(sheets[0].cells.get(2)!.get(2), 'a & b');
  }
  assert.equal(excelDate(46304), '2026-10-09');
  await assert.rejects(readXlsx(new TextEncoder().encode('not a zip')));
});

test('amounts from Excel: crowns to whole haléře', () => {
  assert.equal(toCents(67532), 6753200);
  assert.equal(toCents(1200.505), 120051);
  assert.equal(toCents('67 532 Kč'), 6753200);
  assert.equal(toCents('−1 600,50'), -160050);
  assert.equal(toCents('Hotovost'), null);
});

test('daily report: sections, registers, payments, discounts with counts, notes, nothing dropped', async () => {
  const {lines, notes} = extractDailyReport(await readXlsx(await xlsx(reportSheets())));
  const report = {lines};
  assert.deepEqual(lines.filter(entry => entry.kind === 'revenue_section').map(entry => [entry.key, entry.amountCents]), [['diner', 6000000], ['bar', 15000000], ['club', 18000000]]);
  assert.deepEqual(lines.filter(entry => entry.kind === 'revenue_register').map(entry => entry.key), ['club-1', 'club-2', 'club-3', 'texaco']);
  assert.equal(line(report, 'payment', 'cash')!.amountCents, 1000000);
  assert.equal(line(report, 'payment', 'card')!.amountCents, 38000000);
  assert.equal(line(report, 'total', 'payments')!.amountCents, 39000000);
  assert.deepEqual(line(report, 'discount', 'personal'), {kind: 'discount', key: 'personal', label: 'Personál', count: 15, amountCents: 360000});
  assert.equal(line(report, 'discount', 'sleva-20')!.amountCents, 120050);
  assert.deepEqual([line(report, 'total', 'discounts')!.count, line(report, 'total', 'discounts')!.amountCents], [21, 570050]);
  assert.equal(line(report, 'unmapped', 'neznamy-radek')!.amountCents, 12300, 'unknown rows are kept');
  assert.deepEqual(notes, ['DJ: Pavel', 'Host Novák rozbil sklenici u stolu 4. Na baru došel led, objednat. Kontrola hygieny v pondělí.']);
});

test('cash book: only the column of the business day, blocks for expenses, payouts and the cash count', async () => {
  const lines = extractCashBook(await readXlsx(await xlsx(bookSheets())), '2026-10-09')!;
  const report = {lines};
  assert.equal(line(report, 'balance', 'safe')!.amountCents, -2000000);
  assert.equal(line(report, 'balance', 'bank')!.amountCents, 31000000);
  assert.equal(total(report, 'expense'), 130000);
  assert.equal(line(report, 'movement', 'vklad-jd')!.amountCents, -5000000);
  assert.deepEqual(lines.filter(entry => entry.kind === 'payout').map(entry => [entry.label, entry.amountCents]), [['Security', 800000], ['DJ', 500000]]);
  assert.deepEqual(lines.filter(entry => entry.kind === 'cash_count').map(entry => entry.key), ['euro', 'dolar']);
  assert.ok(!lines.some(entry => entry.amountCents === 4630400), 'the date header is not an amount');
  assert.equal(extractCashBook(await readXlsx(await xlsx(bookSheets())), '2026-10-20'), null);
});

test('OneDrive: share id, picking the day\'s files, report from the downloaded workbooks', async () => {
  assert.equal(shareId('https://1drv.ms/f/s!abc?e=x'), 'u!' + Buffer.from('https://1drv.ms/f/s!abc?e=x').toString('base64url'));
  const names = ['Denní report 8.10.2026.xlsx', 'Denní report 9.10.2026.xlsx', 'Denní report 19.10.2026.xlsx', 'Peněžní deník 2026.xlsx', '~$Denní report 9.10.2026.xlsx'];
  assert.deepEqual(pickFiles(names, '2026-10-09'), {report: 'Denní report 9.10.2026.xlsx', book: 'Peněžní deník 2026.xlsx'});
  assert.deepEqual(pickFiles(['Denni report 09_10_26.xlsx'], '2026-10-09'), {report: 'Denni report 09_10_26.xlsx', book: null});
  const report = (await reportFromFiles([
    {name: 'Denní report 9.10.2026.xlsx', bytes: await xlsx(reportSheets())},
    {name: 'Peněžní deník 2026.xlsx', bytes: await xlsx(bookSheets())},
    {name: 'rozbité.xlsx', bytes: new Uint8Array([1, 2, 3])},
  ], '2026-10-09'))!;
  assert.deepEqual(report.files, ['Denní report 9.10.2026.xlsx', 'Peněžní deník 2026.xlsx']);
  assert.equal(line(report, 'balance', 'safe')!.amountCents, -2000000);
  assert.equal(total(report, 'revenue_section'), 39000000);
  assert.deepEqual(report.warnings, ['Soubor rozbité.xlsx není čitelný sešit Excelu.']);
  assert.equal(validateDailyReport(JSON.parse(JSON.stringify(report))).lines.length, report.lines.length, 'what the reader builds passes the contract');
  assert.equal(await reportFromFiles([], '2026-10-09'), null);
});

test('daily report contract rejects anything unexpected', () => {
  const ok: DailyReport = {businessDate: '2026-10-09', source: 'admin', files: [], lines: [{kind: 'payment', key: 'cash', label: 'Hotovost', count: null, amountCents: 100}], notes: '  ', warnings: []};
  assert.equal(validateDailyReport(ok).notes, null);
  assert.throws(() => validateDailyReport({...ok, extra: 1}), InputError);
  assert.throws(() => validateDailyReport({...ok, businessDate: '9.10.2026'}), InputError);
  assert.throws(() => validateDailyReport({...ok, lines: [{...ok.lines[0], amountCents: 1.5}]}), InputError);
  assert.throws(() => validateDailyReport({...ok, lines: [{...ok.lines[0], kind: 'tip'}]}), InputError);
});

test('config: only an HTTPS OneDrive or SharePoint link', () => {
  assert.equal(validateConfig({...config, reportsLink: 'https://1drv.ms/f/s!abc'}).reportsLink, 'https://1drv.ms/f/s!abc');
  assert.equal(validateConfig({...config, reportsLink: 'https://firma-my.sharepoint.com/:f:/g/personal/x'}).reportsLink, 'https://firma-my.sharepoint.com/:f:/g/personal/x');
  assert.equal(validateConfig({...config, reportsLink: ''}).reportsLink, null);
  assert.throws(() => validateConfig({...config, reportsLink: 'http://1drv.ms/f/s!abc'}), InputError);
  assert.throws(() => validateConfig({...config, reportsLink: 'https://evil.example/1drv.ms'}), InputError);
});

test('"Report dne": names, phones and e-mails never leave OKO1', () => {
  const {text, names} = pseudonymise('Host Novák volal z +420 777 123 456, psal na x.y@example.com. Pavla zaskočila za Petra. V Klubu bylo plno.', ['James Dean']);
  assert.equal(text, 'Host [X1] volal z [telefon], psal na [e-mail]. [X2] zaskočila za [X3]. V [X4] bylo plno.');
  assert.equal(restore('[X2] a [X1] · [X9]', names), 'Pavla a Novák · [X9]');
  assert.deepEqual(parseAnalysis({summary: 'Klid.', points: [{kind: 'task', text: 'Objednat led', amountCents: null}]}), {summary: 'Klid.', points: [{kind: 'task', text: 'Objednat led', amountCents: null}]});
  assert.equal(parseAnalysis({summary: 'x', points: [{kind: 'order', text: 'y', amountCents: null}]}), null);
  assert.equal(parseAnalysis({summary: 'x', points: [{kind: 'task', text: 'y', amountCents: 1.5}]}), null);
});

test('briefing from the managers\' report: revenue, payments, discounts, cash, negative safe, notes', async () => {
  const report = (await reportFromFiles([
    {name: 'Denní report 9.10.2026.xlsx', bytes: await xlsx(reportSheets())},
    {name: 'Peněžní deník.xlsx', bytes: await xlsx(bookSheets())},
  ], '2026-10-09'))!;
  const base = {businessDate: '2026-10-09', config, bills: [], closings: [], planHistory: [{revenueCents: 39000000}, {revenueCents: 35000000}], incomplete: false, report};
  const raw = buildBriefing(base);
  assert.equal(raw.source, 'report');
  assert.equal(raw.revenueCents, 39000000);
  assert.equal(raw.discountsCents, 570050);
  const text = renderBriefing('Testovací podnik', raw);
  assert.match(text, /^Testovací podnik · pátek 9\. 10\. 2026\nTržba: 390 000 Kč \(plán 370 000 Kč, \+5 %\)\nDiner 60 000 Kč · Bar 150 000 Kč · Klub 180 000 Kč\nPlatby: karta 97 %, hotovost 3 %\n/);
  assert.doesNotMatch(text, /Účty 0/);
  assert.match(text, /\nSlevy a odpisy: Personál 15× 3 600 Kč, Sleva 20 % 4× 1 201 Kč, Odpisy Club 2× 900 Kč\n/);
  assert.match(text, /\nVýdaje z kasy 1 300 Kč · výplaty v hotovosti 13 000 Kč\n⚠ Trezor je v deníku záporný: −20 000 Kč\n/);
  assert.match(text, /\nReport dne: DJ: Pavel \/ Host Novák rozbil sklenici/);
  const analysed = renderBriefing('Testovací podnik', buildBriefing({...base, notes: {summary: 'Rozbitá sklenice, došel led.', points: [
    {kind: 'task', text: 'Objednat led', amountCents: null}, {kind: 'incident', text: 'Host rozbil sklenici', amountCents: null},
    {kind: 'info', text: 'DJ Pavel', amountCents: null}, {kind: 'task', text: 'Hygiena v pondělí', amountCents: null},
  ]}}));
  assert.match(analysed, /\nReport dne:\n⚠ Host rozbil sklenici\n• Objednat led\n• Hygiena v pondělí\n… a další 1$/);
});
