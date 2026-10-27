import assert from 'node:assert/strict';
import {test} from 'node:test';
import {aboPlan, buildAbo, knownAccounts, normalAccount, parseAbo, symbolFromNumber} from '../src/abo.ts';
import {hasPhoto, mailInvoiceId, NO_HEADER_SUPPLIER, parseExtraction, photosAreDocuments, photoType, invoiceAttachments, parseIsdoc} from '../src/mail-invoices.ts';
import {aboMail, missingDraft, monthExportMail, receiptsMail, receiptsReminder, receiptsText, reportMissingMail, type PaymentBatch} from '../src/supplies.ts';
import type {Mail} from '../src/mime.ts';

// Synthetic ABO file of a fictitious venue and fictitious suppliers (accounts made up).
const latin1 = (text: string) => Uint8Array.from(text, char => char.charCodeAt(0));
const template = latin1([
  'UHL1101026TESTOVACI PODNIK     1234567890001999000000000000',
  '1 1501 101000 5500',
  '2 000000-0000123456 00000000150000 201026',
  '000000-0000999111 000000100000 0000002601 55000308 0000000000',
  '000019-0000222333 000000050000 0000077001 08000000 0000000000',
  '3 +',
  '5 +',
].join('\r\n') + '\r\n');

test('ABO: reads the template, accounts normalised and symbols without zeros', () => {
  const file = parseAbo(template)!;
  assert.equal(file.payerAccount, '123456');
  assert.equal(file.padded, true);
  assert.equal(file.bankLine, '1 1501 101000 5500');
  assert.deepEqual(file.items, [
    {account: '999111', bankCode: '5500', amountCents: 100000, variableSymbol: '2601', constantSymbol: '308', specificSymbol: null},
    {account: '19-222333', bankCode: '0800', amountCents: 50000, variableSymbol: '77001', constantSymbol: null, specificSymbol: null},
  ]);
  assert.equal(parseAbo(latin1('Dobrý den, posílám fakturu')), null);
  assert.equal(normalAccount('000019-0002000145399'), '19-2000145399');
  assert.equal(normalAccount('12 3456'), '123456');
  assert.equal(normalAccount('CZ6508000000192000145399'), null);
  assert.equal(symbolFromNumber('FV-2026/0042'), '20260042');
  assert.equal(symbolFromNumber('ABC'), null);
  assert.equal(symbolFromNumber('123456789012'), null);
});

test('ABO: ISDOC accounts first, else the account an earlier file paid the supplier, else by hand', () => {
  const file = parseAbo(template)!;
  const supplier: Record<string, string> = {old1: 'mlekarna', a: 'mlekarna', b: 'pekarna', c: 'novy', d: 'isdoc'};
  const key = (id: string) => supplier[id] ?? id;
  const known = knownAccounts([file], [{id: 'old1', number: '2601'}], key);
  assert.deepEqual(known.get('mlekarna'), {account: '999111', bankCode: '5500', constantSymbol: '308', specificSymbol: null});
  const exact = new Map([['d', {account: '555', bankCode: '0100', variableSymbol: '9', constantSymbol: null, specificSymbol: null, from: 'isdoc' as const}]]);
  const plan = aboPlan([
    {id: 'a', supplier: 'Mlékárna Test', number: '2650', grossCents: 123456, dueDate: '2026-10-21'},
    {id: 'b', supplier: 'Pekárna Test', number: '17', grossCents: 2000, dueDate: '2026-10-21'},
    {id: 'c', supplier: 'Nový Test', number: '1', grossCents: 3000, dueDate: '2026-10-21'},
    {id: 'd', supplier: 'ISDOC Test', number: 'X', grossCents: 4000, dueDate: '2026-10-21'},
  ], exact, known, key);
  assert.deepEqual(plan.rows.map(row => [row.id, row.payTo.account, row.payTo.variableSymbol, row.payTo.from]), [['a', '999111', '2650', 'abo'], ['d', '555', '9', 'isdoc']]);
  assert.deepEqual(plan.missing.map(row => row.id), ['b', 'c']);
  assert.equal(plan.totalCents, 127456);

  const bytes = buildAbo(file, plan, '2026-10-22', '2026-10-21', 1022);
  const lines = new TextDecoder('latin1').decode(bytes).split('\r\n');
  assert.equal(lines[0], 'UHL1211026TESTOVACI PODNIK     1234567890001999000000000000');
  assert.equal(lines[1], '1 1501 022000 5500');
  assert.equal(lines[2], '2 000000-0000123456 00000000127456 221026');
  assert.equal(lines[3], '000000-0000999111 000000123456 0000002650 55000308 0000000000');
  assert.equal(lines[4], '000000-0000000555 000000004000 0000000009 01000000 0000000000');
  assert.deepEqual(lines.slice(5), ['3 +', '5 +', '']);
  // The file OKO1 makes reads back the same.
  const again = parseAbo(bytes)!;
  assert.deepEqual(again.items.map(item => [item.account, item.amountCents, item.variableSymbol]), [['999111', 123456, '2650'], ['555', 4000, '9']]);
});

const mail = (extra: Partial<Mail>): Mail => ({messageId: null, inReplyTo: null, references: [], date: '2026-10-31T10:00:00Z', subject: '', from: {name: 'Někdo', address: 'host@example.com'},
  to: [], cc: [], text: '', attachments: [], automated: false, ...extra} as Mail);

test('photos: read only when the venue sent them or the message is about documents', () => {
  assert.equal(photosAreDocuments(mail({from: {name: 'Kancelář', address: 'info@example.cz'}}), 'INFO@example.cz'), true);
  assert.equal(photosAreDocuments(mail({subject: 'Účtenky za říjen'}), 'info@example.cz'), true);
  assert.equal(photosAreDocuments(mail({subject: 'Ztracená bunda', text: 'Posílám fotku, jestli jste ji nenašli.'}), 'info@example.cz'), false);
  assert.equal(photoType(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0])), 'image/jpeg');
  assert.equal(photoType(Uint8Array.from([0x89, 0x50, 0x4e, 0x47])), 'image/png');
  assert.equal(photoType(Uint8Array.from([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70])), null);
  assert.equal(hasPhoto('(("TEXT" "PLAIN" ("CHARSET" "utf-8") NIL NIL "7BIT" 20 1 NIL NIL NIL)("IMAGE" "JPEG" ("NAME" "IMG_0001.jpeg") NIL NIL "BASE64" 2400000 NIL ("INLINE" ("FILENAME" "IMG_0001.jpeg")) NIL) "MIXED")'), true);
  assert.equal(hasPhoto('(("TEXT" "HTML" NIL NIL NIL "7BIT" 20 1 NIL NIL NIL)("IMAGE" "PNG" ("NAME" "image001.png") "<logo>" NIL "BASE64" 8000 NIL NIL NIL) "RELATED")'), false);
  const big = new Uint8Array(30000), small = new Uint8Array(500);
  const parts = invoiceAttachments(mail({attachments: [{filename: 'IMG_1.JPG', contentType: 'image/jpeg', data: big}, {filename: 'logo.png', contentType: 'image/png', data: small}]}));
  assert.deepEqual(parts.images.map(file => file.filename), ['IMG_1.JPG']);
});

test('a receipt without a header: its own supplier name, the mail day and paid', () => {
  const receipt = parseExtraction({isSupplierInvoice: true, documentType: 'receipt', supplier: '', supplierId: null, number: null, issueDate: null, dueDate: null, paid: false,
    netTotal: null, grossTotal: 89, kind: 'other', category: null, items: [{name: 'Lepicí páska', quantity: 1, unit: 'ks', unitPrice: 89, net: null, kind: 'other'}]}, '2026-10-30')!;
  assert.equal(receipt.supplier, NO_HEADER_SUPPLIER);
  assert.equal(receipt.issueDate, '2026-10-30');
  assert.equal(receipt.grossCents, 8900);
  assert.equal(receipt.paid, true);
  // Two receipts of the same amount on the same day are two purchases (told apart by the photo).
  assert.notEqual(mailInvoiceId(receipt, Uint8Array.from([1])), mailInvoiceId(receipt, Uint8Array.from([2])));
  assert.equal(mailInvoiceId(receipt, Uint8Array.from([1])), mailInvoiceId(receipt, Uint8Array.from([1])));
});

test('ISDOC: the account and symbols of the payment', () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?><Invoice xmlns="http://isdoc.cz/namespace/2013" version="6.0.2"><DocumentType>1</DocumentType><ID>FV2026-17</ID>
  <IssueDate>2026-10-05</IssueDate><LocalCurrencyCode>CZK</LocalCurrencyCode>
  <AccountingSupplierParty><Party><PartyIdentification><ID>12345678</ID></PartyIdentification><PartyName><Name>Dodavatel Test s.r.o.</Name></PartyName></Party></AccountingSupplierParty>
  <AccountingCustomerParty><Party><PartyName><Name>Testovací podnik</Name></PartyName></Party></AccountingCustomerParty>
  <InvoiceLines></InvoiceLines>
  <LegalMonetaryTotal><TaxExclusiveAmount>1000</TaxExclusiveAmount><TaxInclusiveAmount>1210</TaxInclusiveAmount><PayableAmount>1210</PayableAmount></LegalMonetaryTotal>
  <PaymentMeans><Payment><PaidAmount>1210</PaidAmount><PaymentMeansCode>42</PaymentMeansCode><Details><PaymentDueDate>2026-10-19</PaymentDueDate>
  <ID>19-123457</ID><BankCode>0800</BankCode><VariableSymbol>202617</VariableSymbol><ConstantSymbol>0308</ConstantSymbol></Details></Payment></PaymentMeans></Invoice>`;
  const invoice = parseIsdoc(xml);
  assert.ok(invoice);
  assert.deepEqual(invoice.payment, {account: '19-123457', bankCode: '0800', variableSymbol: '202617', constantSymbol: '308', specificSymbol: null});
});

test('receipts: reminded from the last day of the month to the 2nd while none came', () => {
  assert.deepEqual(receiptsReminder('2026-10-31', 0), {month: '2026-10', by: '2026-11-02', arrived: 0});
  assert.deepEqual(receiptsReminder('2026-11-02', 0), {month: '2026-10', by: '2026-11-02', arrived: 0});
  assert.equal(receiptsReminder('2026-11-02', 1), null);
  assert.equal(receiptsReminder('2026-11-03', 0), null);
  assert.equal(receiptsReminder('2026-10-30', 0), null);
  assert.deepEqual(receiptsReminder('2026-12-31', 0), {month: '2026-12', by: '2027-01-02', arrived: 0});
  assert.match(receiptsText(receiptsReminder('2026-10-31', 0)!), /účtenky za říjen .*„Účtenky“ do 2\. 11\./);
  assert.match(receiptsMail(receiptsReminder('2026-10-31', 0)!, 'Testovací podnik', 'info@example.cz').text, /JPG/);
});

test('office mails: ABO for checking, the month for the accountant, a draft to a supplier', () => {
  const batch: PaymentBatch = {payDay: '2026-10-20', nextPayDay: '2026-10-22', totalCents: 5000, rows: [
    {id: 'a', supplier: 'Mlékárna Test', supplierId: null, number: '1', dueDate: '2026-10-20', grossCents: 3000, source: 'posta'},
    {id: 'b', supplier: 'Pekárna Test', supplierId: null, number: '2', dueDate: '2026-10-21', grossCents: 2000, source: 'posta'}]};
  const mail = aboMail(batch, {rows: [{supplier: 'Mlékárna Test', number: '1', grossCents: 3000, from: 'abo'}], missing: [{supplier: 'Pekárna Test', number: '2', grossCents: 2000, reason: 'účet dodavatele zatím OKO1 nezná'}], totalCents: 3000}, 'Testovací podnik');
  assert.match(mail.subject, /^ABO k hromadné platbě úterý 20\. 10\.: 1× /);
  assert.match(mail.text, /Zaplatit ručně[\s\S]*Pekárna Test/);
  assert.match(aboMail(batch, null, 'Testovací podnik').text, /dřívější soubor ABO/);
  assert.match(monthExportMail('2026-10', 'Testovací podnik', 12, 2, 1, 2).subject, /za říjen 2026 \(1\/2\)$/);
  const draft = missingDraft({supplier: 'Mlékárna Test', supplierId: null, usualDay: 5, lastDate: '2026-09-04', lastGrossCents: 120000, since: '2026-10-10'}, 'Testovací podnik', '2026-10');
  assert.match(draft.text, /za říjen nám od vás zatím nepřišla faktura/);
});

test('accountant: the firm address first, then the name; never the venue itself', async () => {
  const {findAccountant} = await import('../src/accountant.ts');
  const rows = [
    {direction: 'in' as const, sender: 'p.dvorak@example.net', senderName: 'Petr Dvořák', recipients: []},
    {direction: 'out' as const, sender: 'info@podnik.test', senderName: null, recipients: ['ucetni@infotax.test', 'host@example.com']},
    {direction: 'in' as const, sender: 'p.dvorak@example.net', senderName: 'Petr Dvořák', recipients: []},
    {direction: 'in' as const, sender: 'dvorak@podnik.test', senderName: 'Dvořák', recipients: []},
    {direction: 'in' as const, sender: 'host@example.com', senderName: 'Jana Nováková', recipients: []},
  ];
  assert.deepEqual(findAccountant(rows, 'podnik.test'), {address: 'ucetni@infotax.test', messages: 1});
  assert.deepEqual(findAccountant(rows.filter(row => row.direction === 'in'), 'podnik.test'), {address: 'p.dvorak@example.net', messages: 2});
  assert.equal(findAccountant(rows.slice(4), 'podnik.test'), null);
  assert.deepEqual(findAccountant([{direction: 'in', sender: 'jana@ucetni.test', senderName: 'Jana Šafránková', recipients: []}], 'podnik.test'), {address: 'jana@ucetni.test', messages: 1});
});

test('Missing daily report: an important e-mail with the day, the folder and what was found', () => {
  const mail = reportMissingMail('2026-10-18', 'Testovací podnik', 'Testovací reporty', ['Google Drive: denní report za tento den ve složce není (naposledy uložené: Deník.xlsx).']);
  assert.equal(mail.subject, '[DŮLEŽITÉ] Chybí denní report za neděli 18. 10., doplnit');
  assert.match(mail.text, /„Testovací reporty“/);
  assert.match(mail.text, /Denní report 18\.10\.2026\.xlsx/);
  assert.match(mail.text, /naposledy uložené: Deník\.xlsx/);
  assert.doesNotMatch(reportMissingMail('2026-10-19', 'Testovací podnik', 'Testovací reporty', []).text, /Co OKO1/);
  const streak = reportMissingMail('2026-10-26', 'Testovací podnik', 'Testovací reporty', [], '2026-10-17');
  assert.equal(streak.subject, '[DŮLEŽITÉ] Chybí denní report za pondělí 26. 10. (už 9 dní, poslední 17. 10.), doplnit');
  assert.match(streak.text, /nepřišel už 9 dní, poslední je za 17\. 10\. Prosím doplňte i chybějící dny\./);
  assert.equal(reportMissingMail('2026-10-18', 'Testovací podnik', 'Testovací reporty', [], '2026-10-17').subject, mail.subject, 'one day: as before');
});
