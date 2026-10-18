import assert from 'node:assert/strict';
import {test} from 'node:test';
import {buildBriefing, renderBriefing} from '../src/briefing.ts';
import {kindSums, purchaseShares, renderPurchaseShares} from '../src/purchaseshare.ts';
import {todoList} from '../src/todo.ts';
import type {SupplierInvoice, TenantConfig} from '../src/validate.ts';

const config: TenantConfig = {
  name: 'Testovací podnik', timeZone: 'Europe/Prague', businessDayCutoffHour: 6, sendHours: [7, 8, 9],
  registers: ['bar', 'klub'], sections: {diner: 'Diner', bar: 'Bar', club: 'Klub'}, recipients: [], bottleCheck: null, reportsLink: null, dashboardPhones: null, web: null, location: null, disabledSources: [], foodCostLimitPermille: null,
};
const empty = {config, bills: [], closings: [], planHistory: [], incomplete: false};
let next = 0;
/** A synthetic invoice (crowns without VAT); `items` split it by kind. */
const invoice = (date: string, supplier: string, kind: SupplierInvoice['kind'], crowns: number, items: {kind: SupplierInvoice['kind']; crowns: number}[] = []): SupplierInvoice => ({
  type: 'supplier_invoice', id: `f${next++}`, version: 1, businessDate: date, source: 'test', supplier, supplierId: null, number: null, dueDate: null, paidDate: null, status: 'active',
  netCents: crowns * 100, grossCents: crowns * 121, kind, category: null,
  items: items.map(item => ({name: 'x', quantity: 1, unit: null, unitPriceCents: item.crowns * 100, netCents: item.crowns * 100, kind: item.kind, category: null}))});

const invoices = [
  // The week: food 150 000 (Maso 90 000 of it), drinks 120 000 (of them 20 000 on a mixed invoice), other 30 000 left out.
  invoice('2026-10-13', 'Maso', 'food', 90000), invoice('2026-10-14', 'Velkoobchod', 'food', 80000, [{kind: 'food', crowns: 60000}, {kind: 'beverage', crowns: 20000}]),
  invoice('2026-10-15', 'Pivovar', 'beverage', 100000), invoice('2026-10-16', 'Úklid', 'other', 30000),
  // The 4 weeks before: food 400 000 (Maso 120 000), drinks 480 000.
  invoice('2026-09-20', 'Maso', 'food', 120000), invoice('2026-09-27', 'Velkoobchod', 'food', 280000), invoice('2026-10-01', 'Pivovar', 'beverage', 480000),
];
const input = {from: '2026-10-12', to: '2026-10-18', week: kindSums(invoices, '2026-10-12', '2026-10-18'), before: kindSums(invoices, '2026-09-14', '2026-10-11'),
  weekRevenueNetCents: 100000000, weekRevenueDays: 7, beforeRevenueNetCents: 400000000, beforeRevenueDays: 28};

test('food and drinks of the week against the revenue, and the supplier of the rise', () => {
  assert.deepEqual(purchaseShares(input).map(row => [row.kind, row.cents, row.sharePermille, row.beforeSharePermille, row.worse, row.rise]), [
    ['food', 15000000, 150, 100, true, {supplier: 'Maso', overCents: 6000000}],
    ['beverage', 12000000, 120, 120, false, {supplier: 'Velkoobchod', overCents: 2000000}],
  ]);
  assert.deepEqual(renderPurchaseShares(input), ['Nákup jídla a nápojů 12. 10.–18. 10. z tržby bez DPH (faktury bez DPH, proti průměru 4 týdnů): ⚠ jídlo 150 000 Kč = 15 % (předtím 10 %), nejvíc navíc Maso +60 000 Kč · nápoje 120 000 Kč = 12 % (předtím 12 %)']);
  assert.equal(purchaseShares({...input, beforeRevenueDays: 10})[0].beforeSharePermille, null, 'under 21 days before');
  assert.deepEqual(renderPurchaseShares({...input, weekRevenueDays: 4}), [], 'under 5 days');
});

test('Monday line and the to-do list', () => {
  const briefing = buildBriefing({businessDate: '2026-10-18', ...empty});
  briefing.purchaseShares = input;
  assert.match(renderBriefing('Test', briefing), /\nNákup jídla a nápojů 12\. 10\./);
  assert.ok(todoList(briefing).some(item => item.text === 'Nákup jídla za týden 15 % tržby bez DPH (předtím 10 %), nejvíc navíc Maso: projít faktury a ceny' && item.amountCents === 6000000));
  const saturday = buildBriefing({businessDate: '2026-10-17', ...empty});
  saturday.purchaseShares = input;
  assert.doesNotMatch(renderBriefing('Test', saturday), /Nákup jídla a nápojů/, 'only on Monday');
});
