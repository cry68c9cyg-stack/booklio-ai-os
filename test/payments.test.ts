import assert from 'node:assert/strict';
import {test} from 'node:test';
import {amountConflicts, costOutlook, missingInvoices, missingText, monthClosing, nextPaymentBatch, paymentBatch, paymentMail, renderSupplies, supplyBrief, supplySummary} from '../src/supplies.ts';
import {dotStuffed, encodedWord, mailMessage, SmtpReader, validAddress} from '../src/smtp.ts';
import {todoList} from '../src/todo.ts';
import {buildBriefing} from '../src/briefing.ts';
import type {SupplierInvoice, TenantConfig} from '../src/validate.ts';

// Synthetic invoices of fictitious suppliers.
const invoice = (id: string, extra: Partial<SupplierInvoice> = {}): SupplierInvoice => ({type: 'supplier_invoice', id, version: 1, businessDate: '2026-10-05', source: 'dishboard',
  supplier: 'Zelenina Test', supplierId: null, number: id, dueDate: null, paidDate: null, status: 'active', netCents: 100000, grossCents: 112000, kind: 'food', category: null, items: [], ...extra});

test('the batch payment on Tuesday and Thursday: due before the next payment day', () => {
  const invoices = [
    invoice('a', {dueDate: '2026-10-21', grossCents: 50000}), // Wednesday: in Tuesday's batch
    invoice('b', {dueDate: '2026-10-22', grossCents: 70000}), // Thursday: in Thursday's batch
    invoice('c', {dueDate: '2026-10-19', grossCents: 30000, source: 'posta'}), // already due
    invoice('d', {dueDate: '2026-10-20', paidDate: '2026-10-15'}),
    invoice('e', {dueDate: '2026-08-01'}), // over 30 days overdue: left to the overdue list
  ];
  const tuesday = paymentBatch(invoices, '2026-10-19')!; // message on Tuesday 20. 10.
  assert.equal(tuesday.payDay, '2026-10-20');
  assert.equal(tuesday.nextPayDay, '2026-10-22');
  assert.deepEqual(tuesday.rows.map(row => row.number), ['c', 'a']);
  assert.equal(tuesday.totalCents, 80000);
  const thursday = paymentBatch(invoices, '2026-10-21')!;
  assert.equal(thursday.nextPayDay, '2026-10-27');
  assert.deepEqual(thursday.rows.map(row => row.number), ['c', 'a', 'b']);
  assert.equal(paymentBatch(invoices, '2026-10-20'), null); // Wednesday is no payment day
  assert.equal(nextPaymentBatch(invoices, '2026-10-17')!.payDay, '2026-10-20');
});

test('the same invoice with another amount is a conflict; a copy with the same amount is not', () => {
  const conflicts = amountConflicts([invoice('x', {number: 'FV 2026/7'}), invoice('y', {number: 'FV2026-7', grossCents: 121000, status: 'cancelled'}), invoice('z', {number: '8'}), invoice('z2', {number: '8'})]);
  assert.deepEqual(conflicts, [{supplier: 'Zelenina Test', number: 'FV 2026/7', amounts: [112000, 121000], dates: ['2026-10-05']}]);
});

test('purchases expected by the end of the month and the month closed', () => {
  const invoices = [invoice('a', {netCents: 300000, businessDate: '2026-10-03'}), invoice('b', {netCents: 100000, kind: 'beverage', businessDate: '2026-10-08', dueDate: '2026-10-25'}),
    invoice('s', {netCents: 200000, businessDate: '2026-09-10', paidDate: '2026-09-20'})];
  const month = supplySummary(invoices, '2026-10-01', '2026-10-10', {revenueCents: 2000000, revenueDays: 10});
  const outlook = costOutlook(invoices, month, '2026-10-10', 3000000)!;
  assert.equal(outlook.purchasesCents, 400000);
  assert.equal(outlook.estimateCents, 1000000); // 20 % of revenue, on 30 000 Kč more revenue
  assert.deepEqual(outlook.byKind.map(row => [row.kind, row.estimateCents]), [['food', 750000], ['beverage', 250000]]);
  assert.deepEqual([outlook.dueRest, outlook.dueRestCents], [1, 112000]);
  assert.equal(costOutlook(invoices, {...month, revenueDays: 5}, '2026-10-10', 3000000), null);
  assert.equal(monthClosing(invoices, '2026-10-30', {revenueCents: 0, revenueDays: 0}), null);
  const closing = monthClosing(invoices, '2026-10-31', {revenueCents: 4000000, revenueDays: 31})!;
  assert.deepEqual([closing.summary.netCents, closing.previousNetCents, closing.unpaid, closing.unpaidCents], [400000, 200000, 2, 224000]);
  const lines = renderSupplies(supplyBrief(invoices, '2026-10-31', {revenueCents: 4000000, revenueDays: 31}));
  assert.ok(lines.some(line => line.startsWith('Uzávěrka říjen: nákupy 4 000 Kč bez DPH (jídlo 3 000 Kč, nápoje 1 000 Kč) · food cost 10 % · proti minulému měsíci +2 000 Kč · nezaplaceno 2× za 2 240 Kč')), lines.join('\n'));
  const mid = renderSupplies(supplyBrief(invoices, '2026-10-10', {revenueCents: 2000000, revenueDays: 10}, {restRevenueCents: 3000000}));
  assert.ok(mid.some(line => line.startsWith('Výhled nákupů za říjen: 10 000 Kč bez DPH (zatím 4 000 Kč')), mid.join('\n'));
});

test('the batch payment and conflicts are in the morning message and the to-do list', () => {
  const invoices = [invoice('a', {dueDate: '2026-10-21'}), invoice('k', {number: 'K1'}), invoice('k2', {number: 'K1', grossCents: 99000, status: 'cancelled'})];
  const supplies = supplyBrief(invoices.filter(row => row.status === 'active'), '2026-10-19', {revenueCents: 0, revenueDays: 0}, {withCancelled: invoices});
  const lines = renderSupplies(supplies);
  assert.ok(lines.some(line => line === 'Hromadná platba úterý 20. 10.: 1 faktura za 1 120 Kč (splatné do 21. 10.): Zelenina Test 1 120 Kč'), lines.join('\n'));
  assert.ok(lines.some(line => line.startsWith('⚠ Stejná faktura s jinou částkou: Zelenina Test č. K1: 1 120 Kč / 990 Kč')), lines.join('\n'));
  const config = {name: 'Testovací podnik', timeZone: 'Europe/Prague', businessDayCutoffHour: 6, sendHours: [7], registers: [], sections: {}, recipients: [], bottleCheck: null,
    reportsLink: null, dashboardPhones: null, web: null, location: null, disabledSources: [], foodCostLimitPermille: null} as unknown as TenantConfig;
  const todo = todoList(buildBriefing({businessDate: '2026-10-19', config, bills: [], closings: [], planHistory: [], incomplete: false, supplies}));
  assert.ok(todo.some(item => item.text === 'Připravit hromadnou platbu na úterý 20. 10.: 1 faktura za 1 120 Kč'));
  assert.ok(todo.some(item => item.level === 'warn' && item.text.startsWith('Stejná faktura s jinou částkou, ověřit u dodavatele: Zelenina Test č. K1')));
});

import {newSuppliersFromMail} from '../src/supplies.ts';
import {unzip, zip} from '../src/zip.ts';

test('an invoice from the mailbox by a supplier never invoiced before is flagged, with who sent it', () => {
  const invoices = [invoice('old', {supplier: 'Maso Test s.r.o.', businessDate: '2026-09-01'}), invoice('posta-1', {source: 'posta', supplier: 'MASO TEST, s. r. o.', supplierId: '12345678', businessDate: '2026-10-15'}),
    invoice('posta-2', {source: 'posta', supplier: 'Neznámá Firma a.s.', supplierId: '87654321', businessDate: '2026-10-16'}),
    invoice('posta-3', {source: 'posta', supplier: 'Neznámá firma', supplierId: '87654321', businessDate: '2026-10-17'})];
  assert.deepEqual(newSuppliersFromMail(invoices, '2026-10-11', '2026-10-17', new Map([['posta-2', 'fakturace@example.cz']])).map(row => [row.id, row.sender]), [['posta-2', 'fakturace@example.cz']]);
  const lines = renderSupplies({...supplyBrief(invoices, '2026-10-17', {revenueCents: 0, revenueDays: 0})!, newFromMail: newSuppliersFromMail(invoices, '2026-10-11', '2026-10-17')});
  assert.ok(lines.some(line => line.startsWith('⚠ Faktura z pošty od dodavatele, kterého ještě neznáme (ověřit, než se zaplatí): Neznámá Firma a.s. (IČO 87654321) č. posta-2, 1 120 Kč')), lines.join('\n'));
});

test('the export ZIP is read back with its file names and contents', async () => {
  const bytes = zip([{name: 'faktury-2026-10.csv', data: new TextEncoder().encode('﻿Dodavatel;S DPH\r\nTest;1,00\r\n')}, {name: 'doklady/2026-10-01_Zelenina_č.pdf', data: new Uint8Array([37, 80, 68, 70])}]);
  const files = await unzip(bytes);
  assert.deepEqual([...files.keys()], ['faktury-2026-10.csv', 'doklady/2026-10-01_Zelenina_č.pdf']);
  assert.deepEqual([...files.get('doklady/2026-10-01_Zelenina_č.pdf')!], [37, 80, 68, 70]);
});

test('the payment list for the office: exact amounts, a note on mail invoices, a CSV for Excel', () => {
  const batch = paymentBatch([invoice('a', {dueDate: '2026-10-21', grossCents: 123450, number: 'F-1'}), invoice('b', {dueDate: '2026-10-19', grossCents: 30000, source: 'posta', supplier: 'Led; Test'})], '2026-10-19')!;
  const mail = paymentMail(batch, 'Test Diner', ['posta']);
  assert.equal(mail.subject, 'Faktury k platbě úterý 20. 10.: 2× 1 535 Kč');
  assert.match(mail.text, /19\. 10\.  Led; Test, č\. b  300,00 Kč  \(z pošty\)/);
  assert.match(mail.text, /21\. 10\.  Zelenina Test, č\. F-1  1 234,50 Kč/);
  assert.match(mail.text, /zaplacené prosím přeskočte/);
  const csv = new TextDecoder('utf-8', {fatal: false, ignoreBOM: true}).decode(mail.csv);
  assert.ok(csv.startsWith('\ufeffSplatnost;Dodavatel;'));
  assert.match(csv, /2026-10-19;"Led; Test";b;300,00;pošta\r\n/);
  assert.doesNotMatch(paymentMail(paymentBatch([invoice('a', {dueDate: '2026-10-21'})], '2026-10-19')!, 'Test Diner', ['posta']).text, /přeskočte/);
});

test('an e-mail for SMTP: encoded subject, attachment, dot-stuffing, replies over several lines', async () => {
  assert.ok(validAddress('ucetni@example.cz'));
  assert.ok(!validAddress('ucetni@example') && !validAddress('a b@example.cz') && !validAddress('x@example.cz>\r\nRCPT'));
  assert.equal(encodedWord('Plain'), 'Plain');
  assert.ok(encodedWord('Faktury k platbě úterý 20. 10.: 2× 1 535 Kč').split('\r\n ').every(word => word.length <= 75 && word.startsWith('=?UTF-8?B?')));
  const message = mailMessage({from: {name: 'OKO1 – Test', address: 'info@example.cz'}, to: ['ucetni@example.cz'], subject: 'Platby', text: 'Ahoj\n.tečka',
    attachments: [{filename: 'platby.csv', contentType: 'text/csv; charset=utf-8', data: new TextEncoder().encode('a;b')}]}, new Date('2026-10-20T05:00:00Z'), 'x1');
  assert.match(message, /^From: =\?UTF-8\?B\?.+\?= <info@example\.cz>\r\nTo: ucetni@example\.cz\r\nSubject: Platby\r\n/);
  assert.match(message, /Auto-Submitted: auto-generated/);
  assert.match(message, /filename="platby\.csv"/);
  assert.ok(message.endsWith('--oko1-x1--\r\n'));
  assert.equal(dotStuffed('a\r\n.b\r\n'), 'a\r\n..b\r\n.\r\n');
  assert.throws(() => mailMessage({from: {name: 'x', address: 'info@example.cz'}, to: ['bad'], subject: 's', text: 't', attachments: []}, new Date(), 'x2'));
  const chunks = ['250-smtp.example.cz\r\n250-AUTH PLAIN', ' LOGIN\r\n250 OK\r\n235 ok\r\n'].map(text => new TextEncoder().encode(text));
  const reader = new SmtpReader(async () => chunks.shift() ?? null);
  assert.equal(await reader.reply(), 250);
  assert.equal(await reader.reply(), 235);
  await assert.rejects(reader.reply());
});

test('a regular supplier whose invoice of the month has not come', () => {
  const monthly = (id: string, supplier: string, dates: string[], extra: Partial<SupplierInvoice> = {}) => dates.map((date, n) => invoice(`${id}${n}`, {supplier, businessDate: date, ...extra}));
  const invoices = [
    ...monthly('m', 'Maso Test', ['2026-07-03', '2026-08-05', '2026-09-04'], {supplierId: '11111111', grossCents: 500000}),
    ...monthly('z', 'Zelenina Test', ['2026-07-02', '2026-08-02', '2026-09-02', '2026-10-02']), // came this month
    ...monthly('l', 'Led Test', ['2026-08-03', '2026-09-03']), // only two months: not regular yet
    ...monthly('p', 'Papír Test', ['2026-07-20', '2026-08-22', '2026-09-21']), // later in the month: not late yet
    invoice('c', {supplier: 'Nápoje Test', businessDate: '2026-07-01'}), invoice('c2', {supplier: 'Nápoje Test', businessDate: '2026-08-01'}),
    invoice('c3', {supplier: 'Nápoje Test', businessDate: '2026-09-01', status: 'cancelled'}),
  ];
  assert.deepEqual(missingInvoices(invoices, '2026-10-10'), []); // 5. + 5 days of grace
  const missing = missingInvoices(invoices, '2026-10-11');
  assert.deepEqual(missing.map(row => [row.supplier, row.usualDay, row.since]), [['Maso Test', 5, '2026-10-11']]);
  assert.equal(missingText(missing[0]), 'Maso Test (IČO 11111111): faktura za tento měsíc nepřišla, obvykle chodí do 5. dne, naposledy 4. 9. 5 000 Kč');
  assert.deepEqual(missingInvoices(invoices, '2026-10-28').map(row => row.supplier), ['Maso Test', 'Papír Test']);
  // The morning message says it on the first day and on Monday; the to-do list every day.
  const brief = (date: string) => renderSupplies(supplyBrief(invoices, date, {revenueCents: 0, revenueDays: 0})).filter(line => line.includes('Nepřišla'));
  assert.equal(brief('2026-10-11').length, 1);
  assert.equal(brief('2026-10-13').length, 0);
  assert.equal(brief('2026-10-18').length, 1); // Sunday: the Monday message
});
