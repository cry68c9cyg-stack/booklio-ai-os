import assert from 'node:assert/strict';
import {test} from 'node:test';
import {bottleLosses, buildBriefing, noShowAlarm, noShowRate, outlook, crowns, renderBriefing, renderCosts, renderReservations, renderReviews, renderWeb, renderWeek, renderMonth, reviewDrop, unusualDiscounts, summarizeReservations, summarizeReviews, summarizeWeb, type MonthResult} from '../src/briefing.ts';
import {iuctoKey, parseChart, parseJournalPage, sumCosts} from '../src/iucto.ts';
import {briefingDecision, reportDate, sendersFrom} from '../src/schedule.ts';
import {nextCode, seconds} from '../src/login.ts';
import {todoList} from '../src/todo.ts';
import {businessDate} from '../src/time.ts';
import {InputError, validateBatch, validateConfig, withoutGuest, type Bill, type BottleCheck, type Reservation, type TenantConfig} from '../src/validate.ts';

const config: TenantConfig = {
  name: 'Testovací podnik', timeZone: 'Europe/Prague', businessDayCutoffHour: 6, sendHours: [7, 8, 9],
  registers: ['bar', 'klub'], sections: {diner: 'Diner', bar: 'Bar', club: 'Klub'}, recipients: [], bottleCheck: null, reportsLink: null, dashboardPhones: null, web: null,
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

test('reservations: the reported day counts confirmed bookings and no-shows, today shows sections and pending ones', () => {
  const booking = (id: string, businessDate: string, section: string, partySize: number, status: Reservation['status'], arrival: Reservation['arrival'] = null): Reservation =>
    ({type: 'reservation', id, version: 1, businessDate, startsAt: `${businessDate}T18:00:00.000Z`, section, partySize, status, arrival, source: null});
  assert.equal(summarizeReservations(config, [], []), null);
  assert.deepEqual(renderReservations(null), []);
  const summary = summarizeReservations(config, [
    booking('a', '2026-10-08', 'diner', 4, 'confirmed', 'arrived'), booking('b', '2026-10-08', 'club', 1, 'confirmed', 'no_show'),
    booking('c', '2026-10-08', 'club', 5, 'cancelled'), booking('d', '2026-10-08', 'bar', 2, 'declined'),
  ], [booking('e', '2026-10-09', 'club', 6, 'confirmed'), booking('f', '2026-10-09', 'diner', 2, 'confirmed'), booking('g', '2026-10-09', 'diner', 2, 'pending')]);
  assert.deepEqual(summary?.day, {confirmed: 2, guests: 5, arrived: 1, noShows: 1, noShowGuests: 1, cancelled: 1});
  assert.deepEqual(renderReservations(summary), [
    'Rezervace: 2 (5 hostů), nedorazilo 1 (1 host), zrušeno 1',
    'Dnes rezervováno: 2 (8 hostů) · Diner 1 · Klub 1, čeká na potvrzení 1',
  ]);
  const briefing = buildBriefing({businessDate: '2026-10-08', config, bills: [], closings: [], planHistory: [], incomplete: false,
    reservations: [], reservationsToday: [booking('h', '2026-10-09', 'diner', 2, 'pending'), booking('i', '2026-10-09', 'diner', 3, 'pending')]});
  assert.ok(todoList(briefing).some(item => item.level === 'warn' && item.text === 'Rezervace na dnešek čekající na potvrzení: 2'));
  assert.throws(() => validateBatch({batchId: 'batch-0001', installationId: 'booklio', records: [{...booking('x', '2026-10-09', 'diner', 2, 'confirmed'), status: 'seated'}]}), InputError);
});

test('reservations: guest details are validated, optional, and stripped for the archive and export', () => {
  const base = {type: 'reservation', id: 'rez-1', version: 1, businessDate: '2026-10-09', startsAt: '2026-10-09T18:00:00Z', section: 'diner', partySize: 2, status: 'confirmed', arrival: null, source: 'web'};
  const guest = {code: 'JD-TEST', name: 'Testovací Host', contactType: 'phone', contact: '+420000000000', milkshake: '', wish: 'Stůl u okna', note: null, reason: null, language: 'cs', origin: 'qr', tables: ['p3', 'p4']};
  const [record] = validateBatch({batchId: 'batch-guest-1', installationId: 'booklio', records: [{...base, guest}]}).records;
  assert.deepEqual((record as Reservation).guest, {...guest, milkshake: null});
  assert.equal('guest' in withoutGuest(record), false);
  assert.equal('guest' in validateBatch({batchId: 'batch-guest-2', installationId: 'booklio', records: [base]}).records[0], false, 'counts only still accepted');
  const anonymised = {code: 'JD-TEST', name: null, contactType: null, contact: null, wish: null, note: null, tables: ['p3']};
  assert.equal((validateBatch({batchId: 'batch-guest-3', installationId: 'booklio', records: [{...base, version: 2, guest: anonymised}]}).records[0] as Reservation).guest?.name, null);
  for (const bad of [{...guest, contactType: 'fax'}, {...guest, email: 'x@example.test'}, {...guest, tables: 'p3'}, {...guest, name: 'x'.repeat(201)}]) {
    assert.throws(() => validateBatch({batchId: 'batch-guest-4', installationId: 'booklio', records: [{...base, guest: bad}]}), InputError);
  }
});

test('website traffic: a short line against last week, top origins only with visits', () => {
  const day = {type: 'web_traffic' as const, id: 'web-2026-10-08', version: 1, businessDate: '2026-10-08', visits: 1250, visitsWithAction: 3,
    origins: [{key: 'a', name: 'A', visits: 5, withAction: 0}, {key: 'b', name: 'B', visits: 900, withAction: 2}, {key: 'c', name: 'C', visits: 0, withAction: 0}],
    actions: {telefon: 3}, reviewScans: 0};
  assert.equal(summarizeWeb(undefined, day), null);
  assert.deepEqual(renderWeb(summarizeWeb(day, {...day, visits: 1500})), [
    'Web: 1 250 návštěv (před týdnem 1 500, −17 %), 3 s rezervací, telefonem nebo navigací, odeslané rezervace 0', 'Odkud: B 900 · A 5']);
  assert.deepEqual(renderWeb(summarizeWeb({...day, visits: 3, origins: []}, undefined)), ['Web: 3 návštěvy, 3 s rezervací, telefonem nebo navigací, odeslané rezervace 0']);
  assert.deepEqual(renderWeb(summarizeWeb({...day, visits: 1, origins: []}, {...day, visits: 0})), ['Web: 1 návštěva (před týdnem 0), 3 s rezervací, telefonem nebo navigací, odeslané rezervace 0']);
});

test('reviews: counts only, one line with the average and weak ones, nothing when all is quiet, weak ones in the to-do list', () => {
  const day = {type: 'review_summary' as const, id: 'reviews-2026-10-08', version: 1, businessDate: '2026-10-08', waiting: 0, forManagement: 0, failed: 0,
    sources: [{key: 'google', name: 'Google', stars: [1, 0, 0, 0, 3] as [number, number, number, number, number], unrated: 1}, {key: 'tripadvisor', name: 'TripAdvisor', stars: [0, 0, 0, 0, 0] as [number, number, number, number, number], unrated: 0}]};
  const batch = (record: unknown) => ({batchId: 'batch-0001', installationId: 'booklio-web', records: [record]});
  assert.equal(validateBatch(batch(day)).records.length, 1);
  assert.throws(() => validateBatch(batch({...day, sources: [{...day.sources[0], stars: [1, 0, 0, 0, 0.5]}]})), InputError);
  assert.throws(() => validateBatch(batch({...day, waiting: -1})), InputError);
  assert.equal(summarizeReviews(undefined), null);
  assert.deepEqual(renderReviews(summarizeReviews(day)), ['Recenze: 5 nových, průměr 4,0 ★ (Google), 1× 3 ★ a méně']);
  assert.deepEqual(renderReviews(summarizeReviews({...day, sources: [], waiting: 2, failed: 1})), ['Recenze: žádná nová; v adminu čeká na odpověď 2, neodeslané odpovědi 1']);
  assert.deepEqual(renderReviews(summarizeReviews({...day, sources: []})), []);
  const config = validateConfig({name: 'Test', timeZone: 'Europe/Prague', businessDayCutoffHour: 6, sendHours: [7, 8, 9], registers: ['bar'], sections: {bar: 'Bar'}, recipients: []});
  const briefing = buildBriefing({businessDate: '2026-10-08', config, bills: [], closings: [], planHistory: [], incomplete: false, reviews: {...day, forManagement: 2}});
  assert.deepEqual(todoList(briefing).filter(item => item.text.includes('ecenz')).map(item => item.text), ['Slabé recenze (3 ★ a méně): 1', 'Recenze čekají na vedení: 2']);
});

test('iÚčto: chart of accounts, journal pages and costs per synthetic account', () => {
  const chart = parseChart({'1': '518100 - Služby ostatní', '2': '221000 - Bankovní účty', '3': '501 - Potraviny', '4': '549000 - Manka', x: '500 - špatné id', '5': 'bez čísla'});
  assert.deepEqual([...chart!.keys()], [1, 2, 3, 4]);
  assert.equal(parseChart([]), null);
  const page = parseJournalPage({pageCount: 2, _embedded: {journal: [
    {chartaccount_md: 1, chartaccount_dal: 2, price: '1210.50', supplier: {name: 'Dodavatel s.r.o.'}},
    {chartaccount_md: '3', chartaccount_dal: '2', price: 300},
    {chartaccount_md: 2, chartaccount_dal: 3, price: 100}, // a correction (dobropis) on the credit side
    {chartaccount_md: 4, chartaccount_dal: 2, price: 50}, {chartaccount_md: 2, chartaccount_dal: 4, price: 50},
    {chartaccount_md: 2, chartaccount_dal: 99, price: 1e6}, // an account outside the chart and a non-cost one are ignored
  ]}});
  assert.equal(page!.pageCount, 2);
  assert.deepEqual(Object.keys(page!.entries[0]), ['md', 'dal', 'price'], 'nothing but accounts and the amount is kept');
  assert.deepEqual(sumCosts(page!.entries, chart!), [{account: '518', name: 'Služby', amountCents: 121050}, {account: '501', name: 'Spotřeba materiálu', amountCents: 20000}]);
  assert.equal(parseJournalPage({_embedded: {journal: [{chartaccount_md: 1, chartaccount_dal: 2, price: 'x'}]}}), null);
  assert.equal(parseJournalPage({}), null);
  assert.equal(iuctoKey({IUCTO_KEY_JAMES_DEAN: ' abcdef123456 '}, 'james-dean'), 'abcdef123456');
  assert.equal(iuctoKey({IUCTO_KEY_JAMES_DEAN: 'kratký'}, 'james-dean'), null);
  assert.equal(iuctoKey({}, 'james-dean'), null);
});

test('costs in the briefing: the month so far with revenue − costs, the month before, a failed read', () => {
  const month: MonthResult = {month: '2026-10', through: '2026-10-11', revenueCents: 50_000_00, revenueDays: 11, error: null, rows: [
    {account: '504', name: 'Prodané zboží', amountCents: 20_000_00}, {account: '521', name: 'Mzdy', amountCents: 15_000_00},
    {account: '518', name: 'Služby', amountCents: 5_000_00}, {account: '501', name: 'Spotřeba materiálu', amountCents: 1_000_00}]};
  const previous: MonthResult = {...month, month: '2026-09', through: '2026-09-30', revenueCents: 120_000_00, rows: [{account: '504', name: 'Prodané zboží', amountCents: 130_000_00}]};
  assert.deepEqual(renderCosts(null, previous), []);
  assert.deepEqual(renderCosts(month, previous), [
    'Náklady říjen do 11. 10. (zaúčtované): 41 000 Kč · Prodané zboží 20 000 Kč · Mzdy 15 000 Kč · Služby 5 000 Kč',
    'Říjen zatím: tržby 50 000 Kč − náklady 41 000 Kč = 9 000 Kč',
    'Září celkem: tržby 120 000 Kč − náklady 130 000 Kč = −10 000 Kč',
  ]);
  assert.deepEqual(renderCosts({...month, rows: []}, null), ['Náklady říjen: zatím nic zaúčtováno.']);
  assert.deepEqual(renderCosts({...month, rows: [], error: 'iÚčto: HTTP 402 (vyčerpaný denní limit nebo tarif bez API)'}, null), [
    '⚠ Náklady z iÚčta se dnes nepodařilo načíst (iÚčto: HTTP 402 (vyčerpaný denní limit nebo tarif bez API)).',
  ]);
});

test('login clock: the next code 60 s after the last, at most 5 an hour and 10 a day, with the moment it frees up', () => {
  const t = 1_000_000_000_000, s = 1000, min = 60 * s, h = 60 * min;
  assert.equal(nextCode([], t), null);
  assert.deepEqual(nextCode([t - 18 * s], t), {error: 'TOO_SOON', until: t + 42 * s});
  assert.equal(nextCode([t - 60 * s], t), null);
  const hour = [t - 50 * min, t - 40 * min, t - 30 * min, t - 20 * min, t - 10 * min];
  assert.deepEqual(nextCode(hour, t), {error: 'TOO_MANY', until: t + 10 * min});
  assert.equal(nextCode(hour.slice(1), t), null);
  const day = [...Array.from({length: 5}, (_, i) => t - 20 * h + i * 2 * min), ...Array.from({length: 5}, (_, i) => t - 5 * h + i * 2 * min)];
  assert.deepEqual(nextCode(day, t), {error: 'TOO_MANY', until: t + 4 * h});
  assert.deepEqual(nextCode([...hour.slice(1), t - 30 * s], t), {error: 'TOO_MANY', until: t + 20 * min}, 'a limit wins over the 60 seconds');
  assert.equal(seconds(1), 1);
  assert.equal(seconds(-5000), 0);
});

test('BulkGate: rows from every answer shape', async () => {
  const {bulkGateRows} = await import('../src/delivery.ts');
  assert.deepEqual(bulkGateRows({response: [{status: 'accepted', number: 'x'}]}), [{status: 'accepted'}]);
  assert.deepEqual(bulkGateRows([{status: 'scheduled'}]), [{status: 'scheduled'}]);
  assert.deepEqual(bulkGateRows({status: 'accepted', sms_id: 'x'}), [{status: 'accepted'}]);
  assert.deepEqual(bulkGateRows({response: {status: 'sent'}}), [{status: 'sent'}]);
  assert.deepEqual(bulkGateRows({total: {status: {sent: 0, accepted: 1, scheduled: 0, error: 0}}}), [{status: 'accepted'}]);
  assert.deepEqual(bulkGateRows({total: {status: {accepted: 0, error: 1}}}), [{status: 'error'}]);
  assert.deepEqual(bulkGateRows(null), []);
});

test('weekly summary only in the Monday message (Sunday\'s report), silent senders in the message and the to-do list', () => {
  const part = {revenueCents: 140000000, revenueDays: 7, reservations: 30, guests: 120, noShows: 2, noShowGuests: 6, visits: 2100, visitDays: 7, webSent: 40, webConfirmed: 32, reviews: 9, rated: 9, starsTenths: 46, origins: []};
  const week = {from: '2026-10-05', to: '2026-10-11', current: part, previous: {...part, revenueCents: 100000000, guests: 100, visits: null, reviews: 0, rated: 0, starsTenths: null}};
  assert.deepEqual(renderWeek(week), ['Týden 5. 10.–11. 10.: tržba 1 400 000 Kč (+40 %) · rezervace 30, 120 hostů (+20 %), nedorazilo 6 hostů (5 %) · web 2 100 návštěv · rezervační formulář odeslán 40× · potvrzené rezervace z webu na tyto dny 32 · recenze 9, průměr 4,6 ★']);
  assert.deepEqual(renderWeek({...week, current: {...part, revenueDays: 5}}), ['Týden 5. 10.–11. 10.: tržba 1 400 000 Kč (5 dní s daty) · rezervace 30, 120 hostů (+20 %), nedorazilo 6 hostů (5 %) · web 2 100 návštěv · rezervační formulář odeslán 40× · potvrzené rezervace z webu na tyto dny 32 · recenze 9, průměr 4,6 ★'],
    'no change against a week with a different number of days');
  assert.match(renderWeek({...week, current: {...part, revenueDays: 3}, previous: {...part, revenueDays: 3, revenueCents: 100000000, visits: 1000, visitDays: 2}})[0],
    /^Týden 5\. 10\.–11\. 10\.: tržba 1 400 000 Kč \(\+40 %, 3 dny s daty\) · .* · web 2 100 návštěv · /, 'one bracket; visits compared only over as many days');
  assert.deepEqual(renderWeek(null), []);
  const silent = [{name: 'Web', since: '12. 10. 18:01'}];
  const sunday = buildBriefing({businessDate: '2026-10-11', config, bills: [], closings: [], planHistory: [], incomplete: false, week, silent});
  const text = renderBriefing('Testovací podnik', sunday);
  assert.match(text, /\nTýden 5\. 10\.–11\. 10\.: tržba 1 400 000 Kč/);
  assert.match(text, /^Testovací podnik · [^\n]+\n⚠ Web neposílá data od 12\. 10\. 18:01\.\n/, 'right under the heading');
  assert.ok(todoList(sunday).some(item => item.text === 'Web neposílá data od 12. 10. 18:01'));
  const saturday = buildBriefing({businessDate: '2026-10-10', config, bills: [], closings: [], planHistory: [], incomplete: false, week});
  assert.doesNotMatch(renderBriefing('Testovací podnik', saturday), /Týden/, 'the week only on Mondays');
});

test('weekly summary: where the website visits came from, and a warning when the reviews fall behind', () => {
  const part = {revenueCents: 0, revenueDays: 0, reservations: 0, guests: 0, noShows: 0, noShowGuests: 0, visits: 900, visitDays: 7, webSent: 0, webConfirmed: 0, reviews: 6, rated: 6, starsTenths: 38,
    origins: [{key: 'google', name: 'Google', visits: 500, withAction: 40}, {key: 'instagram', name: 'Instagram', visits: 1200, withAction: 0}, {key: 'qr', name: 'QR kód na stole', visits: 30, withAction: 3}]};
  const week = {from: '2026-10-05', to: '2026-10-11', current: part, previous: {...part, visits: null, reviews: 0, rated: 0, starsTenths: null, origins: []},
    reviewsUsual: {reviews: 40, rated: 38, starsTenths: 44}};
  const lines = renderWeek(week);
  assert.equal(lines[1], 'Odkud na web za týden: Google 500 (40 s akcí) · Instagram 1 200 · QR kód na stole 30 (3 s akcí)', 'in the order the website sent, no zero actions');
  assert.equal(lines[2], '⚠ Recenze: průměr recenzí za týden 3,8 ★ (obvykle 4,4 ★, hodnocených 6)');
  assert.ok(reviewDrop(week));
  assert.ok(!reviewDrop({...week, current: {...part, starsTenths: 42}}), '0,2 ★ under is not a drop');
  assert.ok(reviewDrop({...week, current: {...part, starsTenths: 41}}), '0,3 ★ under is');
  assert.ok(!reviewDrop({...week, current: {...part, rated: 4}}), 'too few rated this week');
  assert.ok(!reviewDrop({...week, reviewsUsual: {reviews: 9, rated: 9, starsTenths: 48}}), 'too few rated before');
  assert.ok(!reviewDrop({...week, reviewsUsual: null}));
  assert.ok(!reviewDrop(null));
  assert.equal(renderWeek({...week, reviewsUsual: undefined}).length, 2);
  const sunday = buildBriefing({businessDate: '2026-10-11', config, bills: [], closings: [], planHistory: [], incomplete: false, week});
  assert.ok(todoList(sunday).some(item => item.level === 'warn' && item.text === 'Recenze klesají: průměr recenzí za týden 3,8 ★ (obvykle 4,4 ★, hodnocených 6)'));
  const saturday = buildBriefing({businessDate: '2026-10-10', config, bills: [], closings: [], planHistory: [], incomplete: false, week});
  assert.ok(!todoList(saturday).some(item => item.text.startsWith('Recenze klesají')), 'only from the Sunday summary');
});

test('silent senders: the newest installation of each kind counts, the web after 3 h, a POS after 26 h', () => {
  const now = new Date('2026-10-13T07:00:00Z');
  const rows = [
    {installation_id: 'booklio-web-1', last_seen_at: '2026-10-10T10:00:00Z'},
    {installation_id: 'booklio-web-2', last_seen_at: '2026-10-13T05:00:00Z'},
    {installation_id: 'pos-installation-1', last_seen_at: '2026-10-12T04:00:00Z'},
    {installation_id: 'pos-never', last_seen_at: null},
  ];
  assert.deepEqual(sendersFrom(rows, now).map(row => [row.name, row.silent]), [['Pokladna', true], ['Web', false]], 'a re-paired website is not silent');
  assert.deepEqual(sendersFrom(rows.slice(0, 1), now).map(row => [row.name, row.silent]), [['Web', true]]);
  assert.deepEqual(sendersFrom([{installation_id: 'pos-installation-1', last_seen_at: '2026-10-12T06:00:00Z'}], now).map(row => row.silent), [false]);
  assert.deepEqual(sendersFrom([], now), []);
});

test('month line: so far against the same days before, the whole month on its last day; revenue against a week before', () => {
  const part = {revenueCents: 300000000, revenueDays: 11, bySection: [{section: 'diner', label: 'Diner', revenueCents: 100000000}, {section: 'club', label: 'Klub', revenueCents: 200000000}]};
  const month = {month: '2026-10', through: '2026-10-11', complete: false, current: part, previous: {...part, revenueCents: 250000000, month: '2026-09', through: '2026-09-11'},
    payouts: [{label: 'Security', amountCents: 8800000}], payoutsCents: 8800000, expenses: [], expensesCents: 1200000, discounts: [], discountsCents: 2500000};
  assert.deepEqual(renderMonth(month), ['Říjen do 11. 10.: tržba 3 000 000 Kč (+20 % proti 1. 9.–11. 9.) · Diner 1 000 000 Kč · Klub 2 000 000 Kč · výplaty v hotovosti 88 000 Kč (2,9 % tržby) · výdaje z kasy 12 000 Kč · slevy 25 000 Kč']);
  assert.deepEqual(renderMonth({...month, through: '2026-10-31', complete: true, current: {...part, revenueDays: 9, bySection: null}, previous: {...month.previous, revenueDays: 0, revenueCents: 0}, payoutsCents: 0, expensesCents: 0, discountsCents: 0}),
    ['Říjen celkem: tržba 3 000 000 Kč (9 dní s daty)'], 'no change against a month without data, no sections when some days have none');
  assert.deepEqual(renderMonth({...month, through: '2026-10-31', complete: true, current: {...part, revenueDays: 31}, previous: {...month.previous, revenueDays: 30, through: '2026-09-30'}})[0].slice(0, 56),
    'Říjen celkem: tržba 3 000 000 Kč (+20 % proti září) · Di', 'a whole month against the whole month before, 31 days against 30');
  assert.match(renderMonth({...month, reviews: {reviews: 31, rated: 29, starsTenths: 45}})[0], / · slevy 25 000 Kč · recenze 31, průměr 4,5 ★$/);
  assert.doesNotMatch(renderMonth({...month, reviews: {reviews: 0, rated: 0, starsTenths: null}})[0], /recenze/);
  assert.deepEqual(renderMonth(null), []);
  const briefing = buildBriefing({businessDate: '2026-10-10', config, bills: [], closings: [], planHistory: [], incomplete: false, month, lastWeekRevenueCents: 50000, report: {
    businessDate: '2026-10-10', source: 'admin', files: [], notes: null, warnings: [], lines: [{kind: 'revenue_section', key: 'bar', label: 'Bar', count: null, amountCents: 60000}]}});
  const text = renderBriefing('Testovací podnik', briefing);
  assert.match(text, /\nTržba: 600 Kč · před týdnem 500 Kč \(\+20 %\)\n/);
  assert.match(text, /\nŘíjen do 11\. 10\.: tržba 3 000 000 Kč/);
});

test('unusual discounts: twice the usual amount on this weekday and 1 000 Kč above it, only with two weeks to compare', () => {
  const report = {businessDate: '2026-10-09', source: 'admin' as const, files: [], notes: null, warnings: [], lines: [
    {kind: 'discount' as const, key: 'personal', label: 'Personál', count: 15, amountCents: 365200},
    {kind: 'discount' as const, key: 'promo-club', label: 'Promo Club', count: 1, amountCents: 268900},
    {kind: 'discount' as const, key: 'odpis-club', label: 'Odpis Club', count: 1, amountCents: 53100},
    {kind: 'discount' as const, key: 'ig', label: 'IG', count: 1, amountCents: 120000}]};
  const history = {days: 3, totals: {personal: 300000, 'promo-club': 750000, 'odpis-club': 0}};
  assert.deepEqual(unusualDiscounts(report, history).map(row => [row.label, row.amountCents, row.usualCents]), [['Personál', 365200, 100000], ['IG', 120000, 0]],
    'promo is usual, a write-off of 531 Kč is under 1 000 Kč, a new type counts against zero');
  assert.deepEqual(unusualDiscounts(report, {days: 1, totals: {}}), []);
  const briefing = buildBriefing({businessDate: '2026-10-09', config, bills: [], closings: [], planHistory: [], incomplete: false, report, discountHistory: history});
  assert.match(renderBriefing('Testovací podnik', briefing), /\n⚠ Neobvyklé slevy: Personál 3 652 Kč \(obvykle 1 000 Kč\), IG 1 200 Kč \(obvykle 0 Kč\)/);
  assert.ok(todoList(briefing).some(item => item.text === 'Neobvyklá sleva: Personál 3 652 Kč (obvykle 1 000 Kč)'));
});

test('outlook for the starting day and no-shows against the usual share', () => {
  const booking = (id: string, partySize: number, arrival: 'arrived' | 'no_show' | null = null, status: Reservation['status'] = 'confirmed'): Reservation =>
    ({type: 'reservation', id, version: 1, businessDate: '2026-10-10', startsAt: '2026-10-10T18:00:00Z', section: 'diner', partySize, status, arrival, source: 'web'});
  const today = [booking('t1', 30), booking('t2', 34), booking('t3', 5, null, 'pending')];
  assert.deepEqual(outlook(today, [{revenueCents: 10000000}, {revenueCents: 14000000}], [50, 56]), {planCents: 12000000, guests: 64, usualGuests: 53});
  assert.deepEqual(outlook(today, [{revenueCents: 10000000}], [50]), {planCents: null, guests: 64, usualGuests: null}, 'one week is not usual');
  const day = [booking('d1', 40, 'arrived'), booking('d2', 8, 'no_show'), booking('d3', 4, 'no_show')];
  const rate = noShowRate(day, {confirmedGuests: 400, noShowGuests: 20})!;
  assert.deepEqual(rate, {guests: 12, confirmedGuests: 52, ratePermille: 231, usualPermille: 50});
  assert.equal(noShowAlarm(rate), true);
  assert.equal(noShowAlarm(noShowRate(day, {confirmedGuests: 400, noShowGuests: 120})), false, '23 % against usual 30 % is not unusual');
  assert.equal(noShowAlarm(noShowRate([booking('d1', 40), booking('d2', 4, 'no_show')], null)), false, 'under 6 guests');
  const briefing = buildBriefing({businessDate: '2026-10-09', config, bills: [], closings: [], planHistory: [], incomplete: false, reservations: day, reservationsToday: today,
    todayPlanHistory: [{revenueCents: 10000000}, {revenueCents: 14000000}], todayGuestHistory: [50, 56], noShowHistory: {confirmedGuests: 400, noShowGuests: 20}});
  const text = renderBriefing('Testovací podnik', briefing);
  assert.match(text, /\nDnes rezervováno: 2 \(64 hostů\), čeká na potvrzení 1 · obvykle za celý den 53 hostů · plán tržby 120 000 Kč\n⚠ No-show: nedorazilo 12 hostů z 52 rezervovaných \(23 %, obvykle 5 %\)/);
  assert.ok(todoList(briefing).some(item => item.text === 'No-show: nedorazilo 12 hostů z 52 rezervovaných (23 %, obvykle 5 %)'));
});
