import assert from 'node:assert/strict';
import {test} from 'node:test';
import {amountConflicts, costOutlook, monthClosing, nextPaymentBatch, paymentBatch, renderSupplies, supplyBrief, supplySummary} from '../src/supplies.ts';
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
