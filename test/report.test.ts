import assert from 'node:assert/strict';
import {test} from 'node:test';
import {buildBriefing, renderBriefing} from '../src/briefing.ts';
import {extractCashBook, extractDailyReport, JOURNAL_LABEL, line, toCents, total, validateDailyReport, type DailyReport} from '../src/daily-report.ts';
import {parseAnalysis, pseudonymise, restore} from '../src/notes.ts';
import {allowedUrl, pickFiles, reportFromFiles, shareId} from '../src/onedrive.ts';
import {InputError, validateConfig, type TenantConfig} from '../src/validate.ts';
import {excelDate, readXlsx} from '../src/xlsx.ts';
import {todoList} from '../src/todo.ts';
import {unzip} from '../src/zip.ts';
import {bookSheets, journalSheets, reportSheets, reportSheetsDated, xlsx, zip} from './xlsx-fixture.ts';

const config: TenantConfig = {
  name: 'Testovací podnik', timeZone: 'Europe/Prague', businessDayCutoffHour: 6, sendHours: [7, 8, 9],
  registers: ['diner', 'bar', 'klub'], sections: {diner: 'Diner', bar: 'Bar', club: 'Klub'}, recipients: [], bottleCheck: null, reportsLink: null, dashboardPhones: null, web: null,
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
  // An entry that inflates to more than its header says (a ZIP bomb) is refused.
  const bomb = await zip({'xl/a.xml': 'x'.repeat(100000)});
  const view = new DataView(bomb.buffer), directory = view.getUint32(bomb.length - 6, true);
  view.setUint32(directory + 24, 10, true);
  await assert.rejects(unzip(bomb), /ENTRY_TOO_LARGE/);
});

test('amounts from Excel: crowns to whole haléře', () => {
  assert.equal(toCents(12345), 1234500);
  assert.equal(toCents(1200.505), 120051);
  assert.equal(toCents('12 345 Kč'), 1234500);
  assert.equal(toCents('−2 345,50'), -234550);
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
  const outside = extractDailyReport(await readXlsx(await xlsx({List: [['Celkem', 99], ['Slevy a odpisy'], ['Personál', 1, 50], ['Celkem', 1, 50]]}))).lines;
  assert.deepEqual(outside.map(entry => [entry.kind, entry.key, entry.amountCents]), [['unmapped', 'celkem', 9900], ['discount', 'personal', 5000], ['total', 'discounts', 5000]],
    'a bare "Celkem" is the discount total only inside the discount block');
  assert.deepEqual(notes, ['DJ: Zdeněk', 'Host Novák rozbil sklenici u stolu 4. Na baru došel led, objednat. Kontrola hygieny v pondělí.']);
});

test('cash book: only the column of the business day, blocks for expenses, payouts and the cash count', async () => {
  const lines = extractCashBook(await readXlsx(await xlsx(bookSheets())), '2026-10-09')!;
  const report = {lines};
  assert.equal(line(report, 'balance', 'safe')!.amountCents, -2000000);
  assert.equal(line(report, 'balance', 'bank')!.amountCents, 31000000);
  assert.equal(total(report, 'expense'), 130000);
  assert.equal(line(report, 'movement', 'vklad-jd')!.amountCents, -5000000);
  assert.equal(line(report, 'movement', 'karty-odecet')!.amountCents, 38000000, 'the card deduction is not a cash expense');
  assert.equal(line(report, 'movement', 'oprava-zapisu')!.amountCents, -70000, 'a negative row among expenses is not spending');
  assert.equal(line(report, 'total', 'celkem')!.amountCents, 200);
  assert.deepEqual(lines.filter(entry => entry.kind === 'payout').map(entry => [entry.label, entry.amountCents]), [['Security', 800000], ['DJ', 500000]]);
  assert.deepEqual(lines.filter(entry => entry.kind === 'cash_count').map(entry => entry.key), ['euro', 'dolar']);
  assert.ok(!lines.some(entry => entry.amountCents === 4630400), 'the date header is not an amount');
  assert.equal(extractCashBook(await readXlsx(await xlsx(bookSheets())), '2026-10-20'), null);
});

test('cash book as a journal: the day\'s block, expenses, payouts, money in, cash count and its difference', async () => {
  const lines = extractCashBook(await readXlsx(await xlsx(journalSheets())), '2026-10-09')!;
  const report = {lines};
  assert.deepEqual(lines.filter(entry => entry.kind === 'expense').map(entry => [entry.label, entry.amountCents]), [['Dodavatel B', 200000], ['DJ oprava světel', 150000]]);
  assert.deepEqual(lines.filter(entry => entry.kind === 'payout').map(entry => [entry.label, entry.amountCents]), [['Security', 600000], ['DJ', 400000], ['Zkouška barman', 70000]]);
  assert.deepEqual(lines.filter(entry => entry.kind === 'movement').map(entry => entry.key), ['vklad-jd', 'prodej-oleje'], 'cash received is not spending');
  assert.equal(line(report, 'balance', 'register-start')!.amountCents, 9900100);
  assert.equal(line(report, 'balance', 'register')!.amountCents, 14080100);
  assert.equal(line(report, 'balance', 'safe')!.amountCents, 3000000, 'the counted safe');
  assert.deepEqual(lines.filter(entry => entry.kind === 'cash_count').map(entry => entry.key), ['euro', 'hotovost', 'celkem']);
  assert.equal(line(report, 'total', 'trzba-restaurace-den')!.amountCents, 300000, 'the cash part of the revenue is only a total');
  assert.equal(line(report, 'total', 'cash-difference')!.amountCents, 17000000 - 14080100);
  assert.ok(!lines.some(entry => entry.label.startsWith('Dodavatel A') || entry.label.startsWith('Dodavatel C')), 'other days stay out');
  assert.equal(extractCashBook(await readXlsx(await xlsx(journalSheets())), '2026-10-20'), null);
});

test('cash book as a journal: the closing count wins, no day column guessed, a lone journal is a book', async () => {
  const sheet = {List1: [
    [46304, null, 'Počáteční stav', 1000, null, 'Počáteční výčetka'],
    [null, null, 'Dodavatel', 100, null, 'Trezor', 500],
    [null, null, null, 0, null, 'Celkem', 1000],
    [null, null, 'Zůstatek', 900, null, 'Konečná výčetka'],
    [null, null, null, null, null, 'Trezor', 800],
    [null, null, null, null, null, 'Celkem', 901],
    [46305, null, 'Počáteční stav', null],
    [null, null, 'Tržba Club', 46310],
  ]};
  const lines = extractCashBook(await readXlsx(await xlsx(sheet)), '2026-10-09')!;
  assert.equal(line({lines}, 'balance', 'safe')!.amountCents, 80000);
  assert.equal(line({lines}, 'total', 'cash-difference')!.amountCents, 100);
  assert.equal(extractCashBook(await readXlsx(await xlsx(sheet)), '2026-10-15'), null, 'an amount equal to a date serial is not a day column');
  assert.equal(line({lines: extractCashBook(await readXlsx(await xlsx(sheet)), '2026-10-10')!}, 'total', 'trzba-club')!.amountCents, 4631000, 'an empty opening balance keeps the amount column');
  const lone = (await reportFromFiles([{name: 'sdileny-soubor.xlsx', bytes: await xlsx(journalSheets())}], '2026-10-09'))!;
  assert.equal(lone.notes, null);
  assert.equal(total(lone, 'payout'), 1070000);
});

test('cash book as a journal: revenue by section as a fallback, the daily report wins', async () => {
  const lines = extractCashBook(await readXlsx(await xlsx(journalSheets())), '2026-10-09')!;
  assert.deepEqual(lines.filter(entry => entry.kind === 'revenue_section').map(entry => [entry.key, entry.amountCents, entry.label.startsWith(JOURNAL_LABEL)]),
    [['diner', 5000000, true], ['bar', 10000000, true], ['club', 15000000, true]], 'Texaco belongs to the club');
  assert.equal(line({lines}, 'revenue_register', 'texaco')!.amountCents, 4000000);
  assert.deepEqual(['cash', 'card'].map(key => line({lines}, 'payment', key)!.amountCents), [500000, 29500000]);
  assert.equal(line({lines}, 'payment', 'customer_card'), null, 'zero is left out');
  assert.equal(line({lines}, 'total', 'payments')!.amountCents, 30000000);
  const alone = (await reportFromFiles([{name: 'Peněžní deník.xlsx', bytes: await xlsx(journalSheets())}], '2026-10-09'))!;
  assert.equal(total(alone, 'revenue_section'), 30000000);
  assert.deepEqual(alone.warnings, ['Denní report chybí, tržby jsou jen z peněžního deníku.']);
  const both = (await reportFromFiles([
    {name: 'Peněžní deník.xlsx', bytes: await xlsx(journalSheets())},
    {name: 'Denní report 9.10.2026.xlsx', bytes: await xlsx(reportSheetsDated())},
  ], '2026-10-09'))!;
  assert.ok(!both.lines.some(entry => entry.kind !== 'journal_revenue' && entry.kind !== 'journal_payment' && entry.label.startsWith(JOURNAL_LABEL)), 'no double revenue');
  assert.deepEqual(both.lines.filter(entry => entry.kind === 'journal_payment').map(entry => [entry.key, entry.amountCents]),
    [['cash', 500000], ['card', 29500000]], 'the cash book\'s payments stay beside it for the check');
  assert.deepEqual(both.lines.filter(entry => entry.kind === 'journal_revenue').map(entry => [entry.key, entry.amountCents]),
    [['diner', 5000000], ['bar', 10000000], ['club', 15000000]], 'the cash book\'s revenue stays beside it for the check');
  assert.equal(total(both, 'revenue_section'), 30000000);
  assert.deepEqual(buildBriefing({businessDate: '2026-10-09', config, bills: [], closings: [], planHistory: [], incomplete: false, report: both}).report!.journalMismatches, [], 'both say the same');
  assert.equal(line(both, 'payment', 'cash')!.amountCents, 2000000, 'payments from the daily report');
});

test('cash book as a journal: an unfinished day gives no revenue; a negative cash part is shown as an amount', async () => {
  const sheet = {List1: [
    [46305, null, 'Počáteční stav', 1000, null, null, null, 'Karty', null, 'Zákaznické karty', 'Tržba celkem'],
    [null, null, 'Tržba Restaurace den', 500, null, null, null, 7000, null, 0, 7500],
    [null, null, 'Tržba Restaurace noc', 0, null, null, null, 0, null, 0, 0],
    [null, null, 'Tržba Club', 0, null, null, null, 0, null, 0, 0],
    [null, null, 'Tržba hotovost + karty celkem + ZK', 500, null, null, null, 7000, null, 0, 7500],
    [null, null, 'Zůstatek', 1500],
  ]};
  const lines = extractCashBook(await readXlsx(await xlsx(sheet)), '2026-10-10')!;
  assert.ok(!lines.some(entry => entry.kind === 'revenue_section' || entry.kind === 'payment'), 'a night still running is not the day\'s revenue');
  const briefing = buildBriefing({businessDate: '2026-10-09', config, bills: [], closings: [], planHistory: [], incomplete: false, report: {
    businessDate: '2026-10-09', source: 'admin', files: [], notes: null, warnings: [], lines: [
      {kind: 'revenue_section', key: 'bar', label: 'Bar', count: null, amountCents: 100000},
      {kind: 'payment', key: 'card', label: 'Karty', count: null, amountCents: 105000}, {kind: 'payment', key: 'cash', label: 'Hotovost', count: null, amountCents: -5000}]}});
  assert.match(renderBriefing('Testovací podnik', briefing), /\nPlatby: karta 100 %, hotovost −50 Kč\n/);
});

test('OneDrive: a report with the date in its header is the report, not a cash book', async () => {
  const report = (await reportFromFiles([
    {name: 'Peněžní deník.xlsx', bytes: await xlsx(journalSheets())},
    {name: 'Denní report 9.10.2026.xlsx', bytes: await xlsx(reportSheetsDated())},
  ], '2026-10-09'))!;
  assert.deepEqual(report.files, ['Peněžní deník.xlsx', 'Denní report 9.10.2026.xlsx']);
  assert.equal(total(report, 'revenue_section'), 30000000);
  assert.deepEqual([line(report, 'total', 'discounts')!.amountCents, line(report, 'discount', 'promo-club')!.count], [300000, 2]);
  assert.equal(total(report, 'payout'), 1070000);
  assert.deepEqual(report.warnings, []);
  const briefing = buildBriefing({businessDate: '2026-10-09', config, bills: [], closings: [], planHistory: [], incomplete: false, report});
  assert.equal(briefing.report!.cashDifferenceCents, 2919900);
  assert.match(renderBriefing('Testovací podnik', briefing), /\n⚠ Přepočet pokladny nesedí se zůstatkem v deníku: přebývá 29 199 Kč\n/);
  assert.ok(todoList(briefing).some(item => item.text === 'Přepočet pokladny nesedí s deníkem: +29 199 Kč'));
  assert.deepEqual(briefing.report!.paymentMismatches.map(row => [row.section, row.reportCents, row.journalCents]), [['cash', 2000000, 500000], ['card', 28000000, 29500000]]);
  assert.match(renderBriefing('Testovací podnik', briefing), /\n⚠ Platby v reportu nesedí s deníkem: hotovost: report 20 000 Kč, deník 5 000 Kč, karta: report 280 000 Kč, deník 295 000 Kč$/);
  assert.ok(todoList(briefing).some(item => item.text.startsWith('Platba nesedí s deníkem, hotovost: report 20 000 Kč')));
});

test('OneDrive: share id, picking the day\'s files, report from the downloaded workbooks', async () => {
  assert.equal(shareId('https://1drv.ms/f/s!abc?e=x'), 'u!' + Buffer.from('https://1drv.ms/f/s!abc?e=x').toString('base64url'));
  const names = ['Denní report 8.10.2026.xlsx', 'Denní report 9.10.2026.xlsx', 'Denní report 19.10.2026.xlsx', 'Peněžní deník 2026.xlsx', '~$Denní report 9.10.2026.xlsx'];
  assert.deepEqual(pickFiles(names, '2026-10-09'), {report: 'Denní report 9.10.2026.xlsx', books: ['Peněžní deník 2026.xlsx']});
  assert.deepEqual(pickFiles(['Denni report 09_10_26.xlsx'], '2026-10-09'), {report: 'Denni report 09_10_26.xlsx', books: []});
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
  assert.ok(allowedUrl('https://public.bn1304.files.1drv.com/y4m/x.xlsx') && allowedUrl('https://firma.sharepoint.com/x'));
  assert.ok(!allowedUrl('https://169.254.169.254/') && !allowedUrl('http://1drv.ms/x') && !allowedUrl('https://1drv.ms.evil.example/'));
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
  assert.equal(pseudonymise('volat 777-123-456 nebo 777/123/456, tržba 1 184 382 Kč, 2 345,50 Kč').text, 'volat [telefon] nebo [telefon], tržba 1 184 382 Kč, 2 345,50 Kč');
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
  assert.match(text, /\nVýdaje z kasy 1 300 Kč · výplaty v hotovosti 13 000 Kč \(3,3 % tržby\)\n⚠ Trezor je v deníku záporný: −20 000 Kč\n/);
  assert.match(text, /\nReport dne: DJ: Zdeněk \/ Host Novák rozbil sklenici/);
  const analysed = renderBriefing('Testovací podnik', buildBriefing({...base, notes: {summary: 'Rozbitá sklenice, došel led.', points: [
    {kind: 'task', text: 'Objednat led', amountCents: null}, {kind: 'incident', text: 'Host rozbil sklenici', amountCents: null},
    {kind: 'info', text: 'DJ Zdeněk', amountCents: null}, {kind: 'task', text: 'Hygiena v pondělí', amountCents: null},
  ]}}));
  assert.match(analysed, /\nReport dne:\n⚠ Host rozbil sklenici\n• Objednat led\n• Hygiena v pondělí\n… a další 1$/);
});

test('to-do list: missing report first, then warnings by Kč, at most fifteen', async () => {
  const briefing = buildBriefing({businessDate: '2026-10-09', config, bills: [], closings: [], planHistory: [], incomplete: true, notes: {summary: '', points: [
    {kind: 'problem', text: 'Rozbitý mrazák', amountCents: null}, {kind: 'incident', text: 'Chybí 5 000 Kč v kase', amountCents: 500000},
    ...Array.from({length: 20}, (_, i) => ({kind: 'task' as const, text: `Úkol ${i}`, amountCents: null})),
  ]}});
  const list = todoList(briefing);
  assert.deepEqual(list.slice(0, 3).map(item => item.text), ['Report za den chybí (uzávěrky: diner, bar, klub).', 'Chybí 5 000 Kč v kase', 'Rozbitý mrazák']);
  assert.equal(list.length, 15);
  assert.equal(list.at(-1)!.text, '… a další 9');
  assert.deepEqual(validateConfig({...config, dashboardPhones: ['+420600000001']}).dashboardPhones, ['+420600000001']);
  assert.throws(() => validateConfig({...config, dashboardPhones: ['600000001']}), InputError);
});

test('daily report against the cash book: a section that differs by a crown or more is a warning', () => {
  const entry = (kind: 'revenue_section' | 'journal_revenue', key: string, amountCents: number) => ({kind, key, label: kind === 'journal_revenue' ? JOURNAL_LABEL + key : key, count: null, amountCents});
  const briefing = buildBriefing({businessDate: '2026-10-09', config, bills: [], closings: [], planHistory: [], incomplete: false, report: {
    businessDate: '2026-10-09', source: 'onedrive', files: [], notes: null, warnings: [], lines: [
      entry('revenue_section', 'diner', 4520000), entry('journal_revenue', 'diner', 4490000),
      entry('revenue_section', 'bar', 1000050), entry('journal_revenue', 'bar', 1000000),
      entry('revenue_section', 'club', 2000000), entry('journal_revenue', 'club', 1999900)]}});
  assert.equal(briefing.revenueCents, 7520050, 'the cash book\'s revenue is not counted');
  assert.deepEqual(briefing.report!.journalMismatches.map(row => [row.section, row.reportCents, row.journalCents]), [['diner', 4520000, 4490000], ['club', 2000000, 1999900]], 'half a crown is rounding');
  assert.match(renderBriefing('Testovací podnik', briefing), /⚠ Tržba v reportu nesedí s deníkem: Diner: report 45 200 Kč, deník 44 900 Kč, Klub: report 20 000 Kč, deník 19 999 Kč/);
  const todo = todoList(briefing);
  assert.equal(todo[0].text, 'Tržba nesedí s deníkem, Diner: report 45 200 Kč, deník 44 900 Kč');
  assert.equal(todo[0].amountCents, 30000);
});
