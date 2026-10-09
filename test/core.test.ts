import assert from 'node:assert/strict';
import {test} from 'node:test';
import {buildBriefing, crowns, renderBriefing} from '../src/briefing.ts';
import {briefingDecision, reportDate} from '../src/schedule.ts';
import {businessDate} from '../src/time.ts';
import {InputError, validateBatch, validateConfig, type Bill, type TenantConfig} from '../src/validate.ts';

const config: TenantConfig = {
  name: 'Testovací podnik', timeZone: 'Europe/Prague', businessDayCutoffHour: 6, sendHours: [7, 8, 9, 10],
  registers: ['bar', 'klub'], sections: {diner: 'Diner', bar: 'Bar', club: 'Klub'}, recipients: [],
};
const bill = (id: string, extra: Partial<Bill> = {}): Bill => ({
  type: 'bill', id, version: 1, businessDate: '2026-10-08', closedAt: '2026-10-08T20:00:00.000Z', registerId: 'bar', section: 'bar',
  status: 'closed', tableId: null, guests: 2, waiterId: null, reservationId: null, totalCents: 50000, discountCents: 0,
  items: [{name: 'Burger', productId: null, category: null, quantity: 2, totalCents: 50000}],
  payments: [{method: 'card', amountCents: 50000}], voids: [], ...extra,
});

test('business day ends at 6:00 Prague time, also across daylight saving changes', () => {
  assert.equal(businessDate(new Date('2026-10-09T03:59:00Z'), 'Europe/Prague', 6), '2026-10-08'); // 5:59 CEST
  assert.equal(businessDate(new Date('2026-10-09T04:00:00Z'), 'Europe/Prague', 6), '2026-10-09'); // 6:00 CEST
  assert.equal(businessDate(new Date('2026-12-01T04:59:00Z'), 'Europe/Prague', 6), '2026-11-30'); // 5:59 CET
  assert.equal(reportDate(new Date('2026-10-09T05:00:00Z'), 'Europe/Prague', 6), '2026-10-08'); // 7:00 → yesterday
  assert.equal(reportDate(new Date('2026-10-25T06:00:00Z'), 'Europe/Prague', 6), '2026-10-24'); // DST end day, 7:00 CET
});

test('briefing goes out at 7 when closings are in, retries at 8 and 9, at 10 goes out marked incomplete', () => {
  const decide = (localHour: number, ready: boolean, alreadySent = false) => briefingDecision({localHour, sendHours: [7, 8, 9, 10], ready, alreadySent});
  assert.equal(decide(6, true), 'wait');
  assert.equal(decide(7, true), 'send');
  assert.equal(decide(7, false), 'wait');
  assert.equal(decide(8, false), 'wait');
  assert.equal(decide(9, true), 'send');
  assert.equal(decide(10, false), 'send-incomplete');
  assert.equal(decide(13, false), 'send-incomplete');
  assert.equal(decide(10, false, true), 'skip');
});

test('briefing sums revenue, sections, payments, voids and cash differences', () => {
  const briefing = buildBriefing({
    businessDate: '2026-10-08', config, incomplete: false,
    bills: [
      bill('1'),
      bill('2', {section: 'club', registerId: 'klub', totalCents: 120000, guests: 4, payments: [{method: 'cash', amountCents: 120000}],
        voids: [{name: 'Pivo', amountCents: 6000, reason: 'chyba obsluhy', afterPayment: true, approvedBy: 'm1'}]}),
      bill('3', {status: 'cancelled', totalCents: 9999}),
    ],
    closings: [{type: 'cash_closing', id: 'c1', version: 1, businessDate: '2026-10-08', closedAt: '2026-10-09T03:00:00.000Z', registerId: 'bar', expectedCents: 100000, countedCents: 98000}],
    planHistory: [{revenueCents: 160000}, {revenueCents: 180000}],
  });
  assert.equal(briefing.revenueCents, 170000);
  assert.equal(briefing.bills, 2);
  assert.equal(briefing.cancelledBills, 1);
  assert.equal(briefing.guests, 6);
  assert.deepEqual(briefing.bySection.map(row => row.label), ['Bar', 'Klub']);
  assert.deepEqual(briefing.voids, {count: 1, amountCents: 6000, afterPaymentCount: 1, afterPaymentCents: 6000});
  assert.deepEqual(briefing.missingClosings, ['klub']);
  assert.deepEqual(briefing.plan, {revenueCents: 170000, days: 2});
  const text = renderBriefing('James Dean', briefing);
  assert.match(text, /^James Dean · čtvrtek 8\. 10\. 2026/);
  assert.match(text, /Tržba: 1 700 Kč \(plán 1 700 Kč, \+0 %\)/);
  assert.match(text, /⚠ Storna po zaplacení: 1× 60 Kč/);
  assert.match(text, /⚠ Rozdíl v hotovosti: bar −20 Kč/);
  assert.doesNotMatch(text, /Uzávěrka chybí/);
});

test('incomplete briefing says which closing is missing', () => {
  const briefing = buildBriefing({businessDate: '2026-10-08', config, incomplete: true, bills: [bill('1')], closings: [], planHistory: []});
  assert.match(renderBriefing('X', briefing), /⚠ Uzávěrka chybí: bar, klub\./);
  assert.equal(briefing.plan, null);
});

test('crowns are whole, grouped and signed', () => {
  assert.equal(crowns(8432049), '84 320 Kč');
  assert.equal(crowns(-20000), '−200 Kč');
  assert.equal(crowns(0), '0 Kč');
});

test('ingest contract rejects unknown fields, float money and bad dates', () => {
  const batch = (record: unknown) => ({batchId: 'batch-0001', installationId: 'pos-1', records: [record]});
  assert.equal(validateBatch(batch(bill('1'))).records.length, 1);
  assert.throws(() => validateBatch(batch({...bill('1'), guestName: 'Jan'})), InputError);
  assert.throws(() => validateBatch(batch({...bill('1'), totalCents: 12.5})), InputError);
  assert.throws(() => validateBatch(batch({...bill('1'), businessDate: '2026-02-30'})), InputError);
  assert.throws(() => validateBatch(batch({...bill('1'), businessDate: '2026-13-01'})), InputError);
  assert.throws(() => validateBatch(batch({type: 'order'})), InputError);
  assert.throws(() => validateBatch({...batch(bill('1')), batchId: 'x'}), InputError);
});

test('config accepts the James Dean setup and rejects bad phone numbers', () => {
  assert.deepEqual(validateConfig({...config, sendHours: [10, 7, 8, 9]}).sendHours, [7, 8, 9, 10]);
  assert.throws(() => validateConfig({...config, recipients: ['606979797']}), InputError);
  assert.throws(() => validateConfig({...config, timeZone: 'Mars/Base'}), InputError);
});
