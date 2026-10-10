import assert from 'node:assert/strict';
import {test} from 'node:test';
import {bottleLosses, buildBriefing, crowns, renderBriefing} from '../src/briefing.ts';
import {briefingDecision, reportDate} from '../src/schedule.ts';
import {businessDate} from '../src/time.ts';
import {InputError, validateBatch, validateConfig, type Bill, type BottleCheck, type TenantConfig} from '../src/validate.ts';

const config: TenantConfig = {
  name: 'Testovací podnik', timeZone: 'Europe/Prague', businessDayCutoffHour: 6, sendHours: [7, 8, 9],
  registers: ['bar', 'klub'], sections: {diner: 'Diner', bar: 'Bar', club: 'Klub'}, recipients: [], bottleCheck: null,
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

test('briefing goes out at 7 when the report is in, retries at 8, at 9 goes out marked incomplete, never later', () => {
  const decide = (localHour: number, ready: boolean, alreadySent = false) => briefingDecision({localHour, sendHours: [7, 8, 9], ready, alreadySent});
  assert.equal(decide(6, true), 'wait');
  assert.equal(decide(7, true), 'send');
  assert.equal(decide(7, false), 'wait');
  assert.equal(decide(8, false), 'wait');
  assert.equal(decide(8, true), 'send');
  assert.equal(decide(9, false), 'send-incomplete');
  assert.equal(decide(10, false), 'skip');
  assert.equal(decide(13, true), 'skip');
  assert.equal(decide(9, false, true), 'skip');
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
  assert.doesNotMatch(text, /Report chybí/);
});

test('incomplete briefing says which closing is missing', () => {
  const briefing = buildBriefing({businessDate: '2026-10-08', config, incomplete: true, bills: [bill('1')], closings: [], planHistory: []});
  assert.match(renderBriefing('X', briefing), /⚠ Report chybí: bar, klub\./);
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
  assert.deepEqual(validateConfig({...config, sendHours: [9, 7, 8]}).sendHours, [7, 8, 9]);
  assert.throws(() => validateConfig({...config, recipients: ['606979797']}), InputError);
  assert.throws(() => validateConfig({...config, timeZone: 'Mars/Base'}), InputError);
});

const bottleCheck = (extra: Partial<BottleCheck> = {}): BottleCheck => ({
  type: 'bottle_check', id: 'px-bottle-1', version: 1, businessDate: '2026-10-08', countedAt: '2026-10-09T07:30:00.000Z',
  items: [
    {itemId: '1', name: 'Jameson', countedMl: 2300, expectedMl: 2450, costPerLitreCents: 52000}, // −150 ml = 78 Kč
    {itemId: '2', name: 'Jägermeister', countedMl: 3650, expectedMl: 4100, costPerLitreCents: 45000}, // −450 ml = 202,50 Kč
    {itemId: '3', name: 'Tequila', countedMl: 880, expectedMl: 900, costPerLitreCents: 55000}, // −20 ml = 11 Kč
    {itemId: '4', name: 'Aperol', countedMl: 3500, expectedMl: 3400, costPerLitreCents: 28000}, // surplus, ignored
    {itemId: '5', name: 'Jack Daniel’s', countedMl: 2500, expectedMl: 2800, costPerLitreCents: 60000}, // −300 ml = 180 Kč
  ], ...extra,
});

test('bottle_check is part of the contract: whole ml, haléře per litre, no unknown fields, unique items', () => {
  const batch = (record: unknown) => ({batchId: 'batch-0001', installationId: 'pos-1', records: [record]});
  assert.deepEqual(validateBatch(batch(bottleCheck())).records[0], bottleCheck());
  assert.throws(() => validateBatch(batch({...bottleCheck(), registerId: 'bar'})), InputError);
  assert.throws(() => validateBatch(batch(bottleCheck({items: [{...bottleCheck().items[0], countedMl: 1.5}]}))), InputError);
  assert.throws(() => validateBatch(batch(bottleCheck({items: [{...bottleCheck().items[0], costPerLitreCents: -1}]}))), InputError);
  assert.throws(() => validateBatch(batch(bottleCheck({items: [{...bottleCheck().items[0], note: 'x'} as never]}))), InputError);
  assert.throws(() => validateBatch(batch(bottleCheck({items: [bottleCheck().items[0], bottleCheck().items[0]]}))), InputError);
  assert.throws(() => validateBatch(batch(bottleCheck({items: Array.from({length: 51}, (_, i) => ({...bottleCheck().items[0], itemId: String(i)}))}))), InputError);
  assert.throws(() => validateBatch(batch({...bottleCheck(), countedAt: 'yesterday'})), InputError);
});

test('bottle losses: expected − counted at purchase price, surpluses ignored, threshold filters small ones', () => {
  const {lossCents, losses} = bottleLosses(bottleCheck(), 10000);
  assert.equal(lossCents, 7800 + 20250 + 1100 + 18000);
  assert.deepEqual(losses.map(row => [row.name, row.lossMl, row.lossCents]), [['Jägermeister', 450, 20250], ['Jack Daniel’s', 300, 18000]]);
  assert.deepEqual(bottleLosses(bottleCheck(), 0).losses.map(row => row.name), ['Jägermeister', 'Jack Daniel’s', 'Jameson', 'Tequila']);
});

test('briefing lists only meaningful bottle losses, sorted by CZK, with ⚠', () => {
  const day = {businessDate: '2026-10-08', incomplete: false, bills: [bill('1')], closings: [], planHistory: []};
  const text = renderBriefing('James Dean', buildBriefing({...day, config, bottleChecks: [bottleCheck()]}));
  assert.match(text, /\nLahve: manko 472 Kč \(5 spočítáno\)\n⚠ Jägermeister −450 ml \(203 Kč\)\n⚠ Jack Daniel’s −300 ml \(180 Kč\)$/);
  assert.doesNotMatch(text, /Jameson|Tequila|Aperol/);
  // The owner's threshold and the latest recount win.
  const strict = buildBriefing({...day, config: {...config, bottleCheck: {minLossCents: 5000}}, bottleChecks: [
    bottleCheck({id: 'early', countedAt: '2026-10-09T06:00:00.000Z', items: [{itemId: '9', name: 'Rum', countedMl: 0, expectedMl: 700, costPerLitreCents: 40000}]}),
    bottleCheck(),
  ]});
  assert.deepEqual(strict.bottles?.losses.map(row => row.name), ['Jägermeister', 'Jack Daniel’s', 'Jameson']);
  // No loss over the threshold, no check at all, and a missing check the venue expects.
  assert.match(renderBriefing('X', buildBriefing({...day, config, bottleChecks: [bottleCheck({items: [bottleCheck().items[2]]})]})), /\nLahve: 1 spočítáno, bez manka nad 100 Kč\.$/);
  assert.doesNotMatch(renderBriefing('X', buildBriefing({...day, config})), /Lahve|lahví/);
  assert.match(renderBriefing('X', buildBriefing({...day, config: {...config, bottleCheck: {minLossCents: 10000}}})), /\n⚠ Ranní kontrola lahví chybí\.$/);
  // At most five lines, then a count of the rest.
  const many = bottleCheck({items: Array.from({length: 7}, (_, i) => ({itemId: String(i), name: `Láhev ${i}`, countedMl: 0, expectedMl: 1000, costPerLitreCents: 20000 + i}))});
  const lines = renderBriefing('X', buildBriefing({...day, config, bottleChecks: [many]})).split('\n');
  assert.equal(lines.filter(line => line.startsWith('⚠ Láhev')).length, 5);
  assert.equal(lines.at(-1), '… a další 2');
});

test('config: bottleCheck is optional and validated', () => {
  const {bottleCheck: _omit, ...legacy} = config;
  assert.equal(validateConfig(legacy).bottleCheck, null, 'configs without the key stay valid');
  assert.deepEqual(validateConfig({...config, bottleCheck: {minLossCents: 20000}}).bottleCheck, {minLossCents: 20000});
  assert.throws(() => validateConfig({...config, bottleCheck: {minLossCents: 1.5}}), InputError);
  assert.throws(() => validateConfig({...config, bottleCheck: {minLossCents: 100, minLossMl: 5}}), InputError);
});
