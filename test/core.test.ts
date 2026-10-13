import assert from 'node:assert/strict';
import {test} from 'node:test';
import {bottleLosses, buildBriefing, noShowAlarm, noShowRate, outlook, crowns, renderBriefing, renderCosts, renderReservations, renderReviews, renderWeb, renderWeek, renderMonth, reviewDrop, eventFactor, renderBooking, renderEvents, rainFactor, renderEventReviews, renderGuestOutlook, rankEvents, renderEventRanking, eventTip, renderMenuWeek, sectionThousands, guestOutlookDay, median, weakDays, webDrop, dayPart, forecast, forecastAccuracy, renderForecast, unusualDiscounts, summarizeReservations, summarizeReviews, summarizeWeb, type MonthResult} from '../src/briefing.ts';
import {iuctoKey, parseChart, parseJournalPage, sumCosts} from '../src/iucto.ts';
import {briefingDecision, reportDate, sendersFrom} from '../src/schedule.ts';
import {nextCode, seconds} from '../src/login.ts';
import {todoList} from '../src/todo.ts';
import {counted, overdueInvoices, priceRises, renderSupplies, supplyBrief, supplySummary, unitPrice} from '../src/supplies.ts';
import {weatherDays, weatherText} from '../src/weather.ts';
import {itemProfit, nameKey, pairSale, priceCheck, repricing, volumeOf, type ItemSale} from '../src/menu.ts';
import {businessDate, sameClockDaysBefore} from '../src/time.ts';
import {czechHolidays, easterSunday, holidayName} from '../src/holidays.ts';
import {InputError, validateBatch, validateConfig, withoutGuest, type Bill, type BottleCheck, type Reservation, type Menu, type MenuItem, type SupplierInvoice, type TenantConfig, type WebTraffic} from '../src/validate.ts';

const config: TenantConfig = {
  name: 'Testovací podnik', timeZone: 'Europe/Prague', businessDayCutoffHour: 6, sendHours: [7, 8, 9],
  registers: ['bar', 'klub'], sections: {diner: 'Diner', bar: 'Bar', club: 'Klub'}, recipients: [], bottleCheck: null, reportsLink: null, dashboardPhones: null, web: null, location: null, disabledSources: [],
};
const bill = (id: string, extra: Partial<Bill> = {}): Bill => ({
  type: 'bill', id, version: 1, businessDate: '2026-10-08', closedAt: '2026-10-08T20:00:00.000Z', registerId: 'bar', section: 'bar',
  status: 'closed', tableId: null, guests: 2, waiterId: null, reservationId: null, totalCents: 50000, discountCents: 0,
  items: [{name: 'Burger', productId: null, category: null, quantity: 2, totalCents: 50000, vatRate: null}],
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
    'Nejvíc rezervovaných hostů: 20–21 h 8',
  ]);
  // The busiest two hours in time order (the club after midnight last), groups of 8 and more with time, place and size.
  const at = (id: string, startsAt: string, section: string, partySize: number): Reservation => ({...booking(id, '2026-10-09', section, partySize, 'confirmed'), startsAt});
  const busy = summarizeReservations(config, [], [at('p1', '2026-10-09T16:00:00Z', 'diner', 12), at('p2', '2026-10-09T17:30:00Z', 'diner', 4),
    at('p3', '2026-10-09T22:15:00Z', 'club', 9), at('p4', '2026-10-09T23:00:00Z', 'club', 20), at('p5', '2026-10-09T17:45:00Z', 'diner', 3)]);
  assert.deepEqual(busy?.today.byHour, [{hour: 18, guests: 12}, {hour: 19, guests: 7}, {hour: 0, guests: 9}, {hour: 1, guests: 20}]);
  assert.deepEqual(renderReservations(busy).slice(2), ['Nejvíc rezervovaných hostů: 18–19 h 12, 1–2 h 20', 'Skupiny od 8 osob: 18:00 Diner 12, 0:15 Klub 9, 1:00 Klub 20']);
  const briefing = buildBriefing({businessDate: '2026-10-08', config, bills: [], closings: [], planHistory: [], incomplete: false,
    reservations: [], reservationsToday: [booking('h', '2026-10-09', 'diner', 2, 'pending'), booking('i', '2026-10-09', 'diner', 3, 'pending')]});
  assert.ok(todoList(briefing).some(item => item.level === 'warn' && item.text === 'Rezervace na dnešek čekající na potvrzení: 2'));
  // Bookings for the next 7 days still waiting: one line in the message and a to-do item; nothing when none wait.
  const ahead = buildBriefing({businessDate: '2026-10-08', config, bills: [], closings: [], planHistory: [], incomplete: false,
    pendingAhead: {count: 5, guests: 12, first: {date: '2026-10-15', time: '18:00'}}});
  assert.match(renderBriefing('Test', ahead), /\nNa příštích 7 dní čeká na potvrzení 5 rezervací \(12 hostů\), nejbližší čt 15\. 10\. 18:00(\n|$)/);
  assert.ok(todoList(ahead).some(item => item.level === 'warn' && item.text === 'Na příštích 7 dní čeká na potvrzení 5 rezervací (12 hostů), nejbližší čt 15. 10. 18:00'));
  assert.ok(!renderBriefing('Test', briefing).includes('Na příštích 7 dní'));
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
  assert.match(renderWeek({...week, current: {...part, cancelled: 10}})[0], /· rezervace 30, 120 hostů \(\+20 %\), nedorazilo 6 hostů \(5 %\), zrušeno 10 \(25 % rezervací\) · /);
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
  assert.equal(lines[1], 'Odkud na web za týden: Google 500 (40 s akcí) · Instagram 1 200 · QR kód na stole 30 (3 s akcí)', 'in the order given (the worker sorts by visits), no zero actions');
  assert.equal(lines[2], '⚠ Recenze: průměr recenzí za týden 3,8 ★ z 6 hodnocených (4 týdny předtím 4,4 ★)');
  assert.ok(reviewDrop(week));
  const six = ['a', 'b', 'c', 'd', 'e', 'f'].map((key, i) => ({key, name: key.toUpperCase(), visits: 60 - i, withAction: 0}));
  assert.equal(renderWeek({...week, current: {...part, origins: six}})[1], 'Odkud na web za týden: A 60 · B 59 · C 58 · D 57 · E 56', 'top 5 only');
  assert.ok(!reviewDrop({...week, current: {...part, starsTenths: 42}}), '0,2 ★ under is not a drop');
  assert.ok(reviewDrop({...week, current: {...part, starsTenths: 41}}), '0,3 ★ under is');
  assert.ok(!reviewDrop({...week, current: {...part, rated: 4}}), 'too few rated this week');
  assert.ok(!reviewDrop({...week, reviewsUsual: {reviews: 9, rated: 9, starsTenths: 48}}), 'too few rated before');
  assert.ok(!reviewDrop({...week, reviewsUsual: null}));
  assert.ok(!reviewDrop(null));
  assert.equal(renderWeek({...week, reviewsUsual: undefined}).length, 2);
  const sunday = buildBriefing({businessDate: '2026-10-11', config, bills: [], closings: [], planHistory: [], incomplete: false, week});
  assert.ok(todoList(sunday).some(item => item.level === 'warn' && item.text === 'Recenze klesají: průměr recenzí za týden 3,8 ★ z 6 hodnocených (4 týdny předtím 4,4 ★)'));
  const saturday = buildBriefing({businessDate: '2026-10-10', config, bills: [], closings: [], planHistory: [], incomplete: false, week});
  assert.ok(!todoList(saturday).some(item => item.text.startsWith('Recenze klesají')), 'only from the Sunday summary');
});

test('revenue forecast: weekday averages × last year\'s season, tomorrow, 7 days, this month in total and the next one', () => {
  const bases = [10000000, 10000000, 10000000, 10000000, 10000000, 10000000, 20000000];
  const result = forecast({today: '2026-10-14', bases, seasonal: {'2026-11': 1.2}, monthActual: {cents: 130000000, days: 12, missing: ['2026-10-05']}});
  assert.deepEqual([result.tomorrow, result.week.cents, result.month.restCents, result.month.totalCents, result.nextMonth],
    [{date: '2026-10-15', cents: 10000000}, 80000000, 220000000, 350000000, {month: '2026-11', cents: 408000000}], 'Saturdays twice, a Monday without data forecast, November × 1,2');
  assert.deepEqual(renderForecast(result), ['Odhad tržby: zítra (čt 15. 10.) 100 000 Kč · 7 dní od dneška 800 000 Kč · říjen celkem 3 500 000 Kč (zatím 1 300 000 Kč, 1 den bez dat odhadnuto) · listopad 4 080 000 Kč']);
  const gap = forecast({today: '2026-10-14', bases: [...bases.slice(0, 1), null, ...bases.slice(2)], seasonal: {}, monthActual: {cents: 0, days: 0}});
  assert.deepEqual([gap.tomorrow.cents, gap.week.cents, gap.month.totalCents, gap.nextMonth.cents], [10000000, null, null, null], 'no Monday base, no sum with a Monday');
  assert.deepEqual(renderForecast(gap), ['Odhad tržby: zítra (čt 15. 10.) 100 000 Kč']);
  const first = forecast({today: '2026-12-01', bases: bases.map(() => 12345678), seasonal: {}, monthActual: {cents: 0, days: 0}});
  assert.equal(first.nextMonth.month, '2027-01');
  assert.match(renderForecast(first)[0], /^Odhad tržby: zítra \(st 2\. 12\.\) 123 000 Kč · 7 dní od dneška 864 000 Kč · prosinec celkem 3 827 000 Kč · leden 3 827 000 Kč$/, 'rounded to thousands, nothing so far on the 1st');
  assert.equal(forecast({today: '2026-12-01', bases: bases.map(() => 12345678), seasonal: {'2027-01': 0.5}, monthActual: {cents: 0, days: 0}}).nextMonth.cents, 31 * 6172839, 'January of the next year with its own season');
  assert.deepEqual(renderForecast(forecast({today: '2026-10-14', bases: Array(7).fill(null), seasonal: {}, monthActual: {cents: 0, days: 0}})), []);
  assert.deepEqual(renderForecast(null), []);
});

test('weather from MET Norway: local days, rain without overlaps, the symbol around noon, Czech words', () => {
  const step = (time: string, temperature: unknown, one: [string, number] | null, six: [string, number] | null) => ({time, data: {instant: {details: {air_temperature: temperature}},
    ...(one ? {next_1_hours: {summary: {symbol_code: one[0]}, details: {precipitation_amount: one[1]}}} : {}),
    ...(six ? {next_6_hours: {summary: {symbol_code: six[0]}, details: {precipitation_amount: six[1]}}} : {})}});
  const answer = {properties: {timeseries: [
    step('2026-10-14T21:00:00Z', 9.6, ['cloudy', 0], ['cloudy', 5]), // 23:00 local on the 14th: no afternoon, left out
    step('2026-10-14T22:00:00Z', 9.4, ['lightrain', 0.4], ['rain', 3]), // midnight local: the 15th
    step('2026-10-15T10:00:00Z', 14.4, ['lightrain_day', 0.6], ['rain', 2]), // noon
    step('2026-10-15T12:00:00Z', 13.8, null, ['heavyrain', 2.25]), // 6-hour steps once the hourly ones end
    step('2026-10-15T18:00:00Z', 'x', null, ['rain', 9]), // no temperature: skipped
  ]}};
  assert.deepEqual(weatherDays(answer, 'Europe/Prague'), [
    {date: '2026-10-15', minC: 9, maxC: 14, rainMm: 3.3, symbol: 'rain'},
  ], 'hourly rain 0,4 + 0,6, then the 6-hour 2,25; the 6-hour summary at noon');
  assert.equal(weatherText({date: '2026-10-15', minC: 9, maxC: 14, rainMm: 3.3, symbol: 'lightrain_day'}), '14 °C, slabý déšť');
  assert.equal(weatherText({date: '2026-10-15', minC: 9, maxC: 21, rainMm: 0, symbol: 'partlycloudy_night'}), '21 °C, polojasno');
  assert.equal(weatherText({date: '2026-10-15', minC: -3, maxC: -1, rainMm: 1, symbol: 'heavysnowshowers_day'}), '-1 °C, sníh');
  assert.equal(weatherText({date: '2026-10-15', minC: 9, maxC: 14, rainMm: 0, symbol: null}), '14 °C');
  assert.deepEqual(weatherDays({}, 'Europe/Prague'), []);
  assert.deepEqual(weatherDays({properties: {timeseries: [{time: 'x'}, null]}}, 'Europe/Prague'), []);
});

test('events of the venue: contract, the factor from past event days, the forecast and the morning line', () => {
  const event = {type: 'event', id: 'akce-1', version: 1, businessDate: '2026-10-16', startsAt: '2026-10-16T19:00:00Z', endsAt: '2026-10-17T02:00:00Z', section: 'club', title: 'Rock Night', status: 'published'};
  assert.deepEqual(validateBatch({batchId: 'batch-ev01', installationId: 'web', records: [event]}).records[0], {...event, startsAt: '2026-10-16T19:00:00.000Z', endsAt: '2026-10-17T02:00:00.000Z'});
  assert.throws(() => validateBatch({batchId: 'batch-ev02', installationId: 'web', records: [{...event, status: 'draft'}]}), InputError);
  assert.throws(() => validateBatch({batchId: 'batch-ev03', installationId: 'web', records: [{...event, guests: ['Jan']}]}), InputError, 'nothing about guests');
  assert.throws(() => validateBatch({batchId: 'batch-ev04', installationId: 'web', records: [{...event, title: 'x'.repeat(201)}]}), InputError);
  const booking = {type: 'reservation', id: 'r', version: 1, businessDate: '2026-10-16', startsAt: '2026-10-16T18:00:00Z', section: 'club', partySize: 2, status: 'confirmed', arrival: null, source: 'web'};
  assert.equal((validateBatch({batchId: 'batch-ev05', installationId: 'web', records: [{...booking, createdAt: '2026-10-10T08:00:00Z'}]}).records[0] as Reservation).createdAt, '2026-10-10T08:00:00.000Z');
  assert.throws(() => validateBatch({batchId: 'batch-ev06', installationId: 'web', records: [{...booking, createdAt: 'včera'}]}), InputError);
  // The factor: median of the event days against their weekday's average, at least 4 days, 1× to 2×.
  assert.equal(eventFactor([1.5, 1.2, 1.4]), null);
  assert.deepEqual(eventFactor([1.5, 1.2, 1.4, 3]), {factor: 1.45, days: 4});
  assert.deepEqual(eventFactor([0.8, 0.9, 0.7, 0.95]), {factor: 1, days: 4}, 'an event never lowers the day');
  assert.deepEqual(eventFactor([3, 4, 5, 6, 7]), {factor: 2, days: 5});
  // The bigger of the bookings and the event counts, never both.
  const result = forecast({today: '2026-10-14', bases: Array(7).fill(10000000), seasonal: {}, monthActual: {cents: 0, days: 0},
    bookings: {'2026-10-15': {guests: 100, usualGuests: 50}, '2026-10-16': {guests: 130, usualGuests: 100}},
    events: {'2026-10-15': ['Quiz'], '2026-10-16': ['Rock Night', 'DJ Set']}, eventFactor: {factor: 1.3, days: 6}});
  assert.deepEqual(result.days.slice(0, 3).map(day => [day.cents, day.boost, day.eventBoost, day.events]),
    [[10000000, 1, 1, []], [15000000, 1.5, 1.3, ['Quiz']], [13000000, 1.15, 1.3, ['Rock Night', 'DJ Set']]]);
  assert.match(renderForecast(result)[0], /^Odhad tržby: zítra \(čt 15\. 10\.\) 150 000 Kč \(akce Quiz, víc rezervací než obvykle\) · /);
  const later = forecast({today: '2026-10-15', bases: Array(7).fill(10000000), seasonal: {}, monthActual: {cents: 0, days: 0}, events: {'2026-10-16': ['Rock Night']}, eventFactor: {factor: 1.3, days: 6}});
  assert.match(renderForecast(later)[0], /^Odhad tržby: zítra \(pá 16\. 10\.\) 130 000 Kč \(akce Rock Night, bývá o 30 % víc\) · /);
  const unknown = forecast({today: '2026-10-15', bases: Array(7).fill(10000000), seasonal: {}, monthActual: {cents: 0, days: 0}, events: {'2026-10-16': ['Rock Night']}, eventFactor: null});
  assert.match(renderForecast(unknown)[0], /^Odhad tržby: zítra \(pá 16\. 10\.\) 100 000 Kč \(akce Rock Night\) · /, 'without enough past event days the name only');
  // Today's events in the morning message.
  assert.deepEqual(renderEvents([]), []);
  assert.deepEqual(renderEvents([{time: '21:00', label: 'Klub', title: 'Rock Night', guests: 40}, {time: '19:00', label: 'celý podnik', title: 'Halloween', guests: 0}]),
    ['Dnes akce: 21:00 Klub – Rock Night (rezervováno 40 hostů) · 19:00 celý podnik – Halloween']);
  const briefing = buildBriefing({businessDate: '2026-10-15', config, bills: [], closings: [], planHistory: [], incomplete: false, events: [{time: '21:00', label: 'Klub', title: 'Rock Night', guests: 2}]});
  assert.match(renderBriefing('Test', briefing), /\nDnes akce: 21:00 Klub – Rock Night \(rezervováno 2 hosté\)(\n|$)/);
});

test('weekly bookings: how long ahead and where from', () => {
  const part = {revenueCents: 0, revenueDays: 0, reservations: 25, guests: 100, noShows: 1, noShowGuests: 4, visits: null, visitDays: 0, webSent: 0, webConfirmed: 0, reviews: 0, rated: 0, starsTenths: null, origins: [],
    lead: {sameDay: 5, upTo2: 10, upTo7: 8, more: 2}, sources: [{source: 'web', reservations: 15, guests: 50, noShowGuests: 4}, {source: 'obsluha', reservations: 8, guests: 40, noShowGuests: 0}, {source: 'mcp', reservations: 2, guests: 10, noShowGuests: 0}]};
  assert.deepEqual(renderBooking(part), ['Rezervace za týden: týž den 5 · 1–2 dny předem 10 · 3–7 dní 8 · víc než týden 2 · zdroje: web 15 (nedorazilo 8 % hostů) · obsluha 8 · AI asistenti 2']);
  assert.deepEqual(renderBooking({...part, lead: {sameDay: 0, upTo2: 0, upTo7: 0, more: 0}, sources: []}), [], 'nothing without the time of booking or sources');
  assert.equal(renderWeek({from: '2026-10-05', to: '2026-10-11', current: part, previous: part})[1], renderBooking(part)[0]);
});

test('forecast: clearly more booked guests than usual raise a day by half the extra share (at most 1,5×), weather and how well it hit', () => {
  const bases = Array(7).fill(10000000);
  const bookings = {'2026-10-15': {guests: 120, usualGuests: 100}, '2026-10-16': {guests: 400, usualGuests: 100}, '2026-10-17': {guests: 50, usualGuests: 100}, '2026-10-18': {guests: 80, usualGuests: null},
    '2026-10-19': {guests: 8, usualGuests: 2}, '2026-10-20': {guests: 105, usualGuests: 100}};
  const weather = [{date: '2026-10-15', minC: 9, maxC: 14, rainMm: 3, symbol: 'rain'}];
  const accuracy = forecastAccuracy([{forecastCents: 100, actualCents: 110}, {forecastCents: 100, actualCents: 90}, ...Array(5).fill({forecastCents: 100, actualCents: 100}), {forecastCents: 0, actualCents: 50}]);
  assert.deepEqual(accuracy, {days: 7, errorPermille: 29}, 'a day without a forecast does not count');
  assert.equal(forecastAccuracy(Array(6).fill({forecastCents: 100, actualCents: 100})), null, 'under 7 days');
  const result = forecast({today: '2026-10-14', bases, seasonal: {}, monthActual: {cents: 0, days: 0}, bookings, weather, accuracy});
  assert.deepEqual(result.days.map(day => [day.date, day.cents, day.boost]), [['2026-10-14', 10000000, 1], ['2026-10-15', 11000000, 1.1], ['2026-10-16', 15000000, 1.5],
    ['2026-10-17', 10000000, 1], ['2026-10-18', 10000000, 1], ['2026-10-19', 10000000, 1], ['2026-10-20', 10000000, 1]], 'fewer guests never lower it; under 10 usual or 10 more is no signal');
  assert.equal(result.week.cents, 76000000);
  assert.deepEqual([result.days[1].guests, result.days[1].usualGuests, result.days[1].weatherText, result.days[2].weatherText], [120, 100, '14 °C, déšť', null]);
  assert.equal(renderForecast(result)[0], 'Odhad tržby: zítra (čt 15. 10.) 110 000 Kč (víc rezervací než obvykle), 14 °C, déšť · 7 dní od dneška 760 000 Kč · říjen celkem 1 860 000 Kč (zatím 0 Kč, 13 dní bez dat odhadnuto) · listopad 3 000 000 Kč · odhad se za 7 dní lišil v průměru o 3 %');
  // Today's plan is the forecast for today; the next morning checks the day against the forecast it logged.
  const briefing = buildBriefing({businessDate: '2026-10-13', config, bills: [], closings: [], planHistory: [{revenueCents: 1}, {revenueCents: 1}], incomplete: false, forecast: result, forecastPlanCents: 9000000});
  assert.deepEqual([briefing.plan, briefing.outlook.planCents], [{revenueCents: 9000000, days: 2}, 10000000]);
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
  assert.match(text, /\nDnes rezervováno: 2 \(64 hostů\), čeká na potvrzení 1 · obvykle za celý den 53 hostů · plán tržby 120 000 Kč\nNejvíc rezervovaných hostů: 20–21 h 64\nSkupiny od 8 osob: 20:00 Diner 34, 20:00 Diner 30\n⚠ No-show: nedorazilo 12 hostů z 52 rezervovaných \(23 %, obvykle 5 %\)/);
  assert.ok(todoList(briefing).some(item => item.text === 'No-show: nedorazilo 12 hostů z 52 rezervovaných (23 %, obvykle 5 %)'));
});

test('guests by part of the day: booked now + the usual later bookings, no-shows, the morning line', () => {
  assert.deepEqual([5, 6, 16, 17, 21, 22, 0].map(dayPart), ['night', 'day', 'day', 'evening', 'evening', 'night', 'night']);
  assert.deepEqual([median([3]), median([5, 1, 3]), median([1, 4]), median([4, 1, 2, 10])], [3, 3, 3, 3]);
  const parts = (day: number, evening: number, night: number) => ({day, evening, night});
  const past = [{final: parts(10, 40, 20), early: parts(6, 30, 20)}, {final: parts(8, 50, 30), early: parts(8, 30, 10)}, {final: parts(4, 20, 5), early: parts(6, 18, 5)}];
  assert.deepEqual(guestOutlookDay('2026-10-14', parts(5, 40, 30), past), {date: '2026-10-14', booked: 75, expected: 85, usual: 48, weak: false,
    parts: [{key: 'day', booked: 5, expected: 5}, {key: 'evening', booked: 40, expected: 50}, {key: 'night', booked: 30, expected: 30}]}, 'medians 0, 10, 0; fewer guests later counts as 0');
  assert.deepEqual(guestOutlookDay('2026-10-14', parts(5, 40, 30), past.slice(0, 1)).expected, null, 'one past day is not usual');
  const days = [guestOutlookDay('2026-10-14', parts(5, 40, 30), past), guestOutlookDay('2026-10-15', parts(0, 0, 0), [])];
  const briefing = buildBriefing({businessDate: '2026-10-13', config, bills: [], closings: [], planHistory: [], incomplete: false,
    guestOutlook: {days}, noShowHistory: {confirmedGuests: 400, noShowGuests: 20}});
  assert.equal(briefing.guestOutlook!.noShowGuests, 4, '5 % of 85');
  assert.match(renderBriefing('Test', briefing), /\nHosté dnes: čekej asi 85 \(zatím rezervováno 75\) · přes den 5 · večer 50 · noc 30 · obvykle nedorazí asi 4(\n|$)/);
  const few = buildBriefing({businessDate: '2026-10-13', config, bills: [], closings: [], planHistory: [], incomplete: false,
    guestOutlook: {days: [guestOutlookDay('2026-10-14', parts(0, 6, 0), [])]}, noShowHistory: {confirmedGuests: 40, noShowGuests: 20}});
  assert.deepEqual(renderGuestOutlook(few.guestOutlook), ['Hosté dnes: rezervováno 6 · večer 6'], 'no estimate without history, no no-shows from under 50 guests');
  assert.deepEqual(renderGuestOutlook(buildBriefing({businessDate: '2026-10-13', config, bills: [], closings: [], planHistory: [], incomplete: false}).guestOutlook), []);
  assert.deepEqual(renderGuestOutlook({days: [guestOutlookDay('2026-10-14', parts(0, 0, 0), [])], noShowGuests: null}), [], 'nothing on an empty day');
});

test('weak days ahead: 40 % fewer guests booked than usual by now, from 10 usual guests; late cancellations can take guests away', () => {
  const parts = (day: number, evening: number, night: number) => ({day, evening, night});
  const usual = [{final: parts(0, 30, 0), early: parts(0, 20, 0)}, {final: parts(0, 30, 0), early: parts(0, 20, 0)}];
  const weak = guestOutlookDay('2026-10-17', parts(0, 12, 0), usual), fine = guestOutlookDay('2026-10-18', parts(0, 13, 0), usual);
  assert.deepEqual([weak.usual, weak.weak, fine.weak], [20, true, false], '12 is 60 % of 20, 13 is more');
  assert.equal(guestOutlookDay('2026-10-17', parts(0, 0, 0), [{final: parts(0, 9, 0), early: parts(0, 9, 0)}, {final: parts(0, 9, 0), early: parts(0, 9, 0)}]).weak, false, 'under 10 usual guests');
  // Cancelled after the moment: booked then (early), gone at the end, so the day usually loses guests; never below zero.
  assert.equal(guestOutlookDay('2026-10-17', parts(0, 5, 0), [{final: parts(0, 10, 0), early: parts(0, 20, 0)}, {final: parts(0, 10, 0), early: parts(0, 20, 0)}]).expected, 0);
  const briefing = buildBriefing({businessDate: '2026-10-13', config, bills: [], closings: [], planHistory: [], incomplete: false,
    guestOutlook: {days: [guestOutlookDay('2026-10-14', parts(0, 25, 0), usual), weak]}});
  assert.match(renderBriefing('Test', briefing), /\n⚠ Slabší výhled: so 17\. 10\. zatím 12 hostů \(obvykle touhle dobou 20, −40 %\)(\n|$)/);
  assert.ok(todoList(briefing).some(item => item.text === 'Slabší výhled, zvaž akci nebo kampaň: so 17. 10. zatím 12 hostů (obvykle touhle dobou 20, −40 %)'));
  assert.equal(weakDays(buildBriefing({businessDate: '2026-10-13', config, bills: [], closings: [], planHistory: [], incomplete: false}).guestOutlook).length, 0);
});

test('website watch: visits under half of the usual or no booking form sent, against the same weekday of 4 weeks', () => {
  const day = (visits: number, sent: number): WebTraffic => ({type: 'web_traffic', id: 'w', version: 1, businessDate: '2026-10-13', visits, visitsWithAction: 0, origins: [],
    actions: {'rezervace-odeslana': sent}, reviewScans: 0});
  const usual = [{visits: 100, sent: 5}, {visits: 120, sent: 4}, {visits: 90, sent: 6}];
  assert.equal(webDrop(day(60, 2), usual), null, 'half of 100 or more is fine, forms were sent');
  assert.deepEqual(webDrop(day(40, 0), usual), {visits: 40, usualVisits: 100, sent: 0, usualSent: 5, lowVisits: true, noSent: true});
  assert.equal(webDrop(day(40, 0), usual.slice(0, 2)), null, 'needs 3 usual days');
  assert.equal(webDrop(day(10, 0), [{visits: 20, sent: 1}, {visits: 20, sent: 2}, {visits: 25, sent: 1}]), null, 'a quiet website is not watched');
  assert.deepEqual(webDrop(day(95, 0), usual), {visits: 95, usualVisits: 100, sent: 0, usualSent: 5, lowVisits: false, noSent: true});
  const briefing = buildBriefing({businessDate: '2026-10-13', config, bills: [], closings: [], planHistory: [], incomplete: false, web: day(40, 0), webUsual: usual});
  assert.match(renderBriefing('Test', briefing), /\n⚠ Web: 40 návštěv \(obvykle 100\) a žádný odeslaný rezervační formulář \(obvykle 5\), zkontroluj, že web a rezervace běží\.(\n|$)/);
  assert.ok(todoList(briefing).some(item => item.text === 'Web: 40 návštěv (obvykle 100) a žádný odeslaný rezervační formulář (obvykle 5), zkontroluj, že web a rezervace běží'));
});

test('events looked back on in the weekly summary', () => {
  assert.deepEqual(renderEventReviews([]), []);
  assert.deepEqual(renderEventReviews([
    {date: '2026-10-09', title: 'Rock Night', guests: 120, usualGuests: 80, revenueCents: 15000000, usualRevenueCents: 10000000},
    {date: '2026-10-10', title: 'Quiz', guests: 30, usualGuests: 40, revenueCents: null, usualRevenueCents: null},
    {date: '2026-10-11', title: 'Brunch', guests: 1, usualGuests: null, revenueCents: 500000, usualRevenueCents: null},
  ]), ['Akce za týden: pá 9. 10. Rock Night – 120 hostů z rezervací (obvykle 80, +50 %), tržba 150 000 Kč (obvykle 100 000 Kč)'
    + ' · so 10. 10. Quiz – 30 hostů z rezervací (obvykle 40, −25 %) · ne 11. 10. Brunch – 1 host z rezervací, tržba 5 000 Kč']);
});

test('events of half a year ranked by guests drawn, the line at the month end, the tip for a weak day, the menu of the week', () => {
  const review = (date: string, title: string, guests: number, usualGuests: number | null, revenueCents: number | null = null, usualRevenueCents: number | null = null) =>
    ({date, title, guests, usualGuests, revenueCents, usualRevenueCents});
  const ranking = rankEvents([
    review('2026-09-12', 'Rock Night', 90, 60, 15000000, 10000000), review('2026-10-10', 'rock night ', 120, 80, 12000000, 10000000),
    review('2026-10-07', 'Quiz', 30, 40), review('2026-10-01', 'Koncert', 50, 40), review('2026-10-02', 'Brunch', 10, null),
    review('2026-09-05', 'Swing', 20, 40)]);
  assert.deepEqual(ranking.map(rank => [rank.title, rank.count, rank.weekdays, rank.guests, rank.usualGuests, rank.guestLift, rank.revenueLift, rank.last]), [
    ['rock night', 2, [6], 105, 70, 1.5, 1.35, '2026-10-10'], ['Koncert', 1, [4], 50, 40, 1.25, null, '2026-10-01'], ['Quiz', 1, [3], 30, 40, 0.75, null, '2026-10-07'],
    ['Swing', 1, [6], 20, 40, 0.5, null, '2026-09-05'], ['Brunch', 1, [5], 10, null, null, null, '2026-10-02']], 'one name whatever the case, the latest spelling, nothing to compare last');
  assert.deepEqual(renderEventRanking(ranking), ['Akce za půl roku: nejvíc táhne rock night (2×, hosté +50 %, tržba +35 %) · Koncert (1×, hosté +25 %) · nejméně Swing (1×, hosté −50 %)']);
  assert.deepEqual(renderEventRanking(rankEvents([review('2026-10-07', 'Quiz', 30, 40), review('2026-10-08', 'Jam', 40, 40)])),
    ['Akce za půl roku: žádná nepřivedla víc než obvyklý den · nejméně Quiz (1×, hosté −25 %)'], 'no "nejvíc" when nothing drew more; ±0 % is neither');
  assert.match(renderEventRanking(rankEvents([review('2026-10-08', 'Jam', 201, 200), review('2026-10-07', 'Quiz', 30, 20)]))[0], /^Akce za půl roku: nejvíc táhne Quiz \(1×, hosté \+50 %\)$/, 'a lift that rounds to ±0 % is neither');
  // The tip takes the lift on the weak day's weekday only, from at least two events there.
  const mixed = rankEvents([review('2026-10-02', 'Party', 80, 50), review('2026-10-09', 'Party', 80, 50), review('2026-10-03', 'Party', 30, 50), review('2026-10-10', 'Party', 30, 50),
    review('2026-09-26', 'Party', 30, 50)]);
  assert.deepEqual(mixed[0].byWeekday, [{weekday: 5, count: 2, guestLift: 1.6}, {weekday: 6, count: 3, guestLift: 0.6}]);
  assert.equal(eventTip(mixed, '2026-10-17'), '', 'Saturdays drew fewer');
  assert.equal(eventTip(mixed, '2026-10-16'), ', v pátek nejvíc táhla akce Party (hosté +60 %)');
  assert.equal(eventTip(rankEvents([review('2026-10-09', 'Once', 80, 50)]), '2026-10-16'), '', 'one event is not enough for a tip');
  assert.deepEqual(renderEventRanking([]), []);
  assert.equal(eventTip(ranking, '2026-10-17'), ', v sobotu nejvíc táhla akce rock night (hosté +50 %)');
  assert.equal(eventTip(ranking, '2026-10-14'), '', 'Quiz on Wednesdays drew fewer');
  const parts = (day: number, evening: number, night: number) => ({day, evening, night});
  const usual = [{final: parts(0, 30, 0), early: parts(0, 20, 0)}, {final: parts(0, 30, 0), early: parts(0, 20, 0)}];
  const input = {businessDate: '2026-10-31', config, bills: [], closings: [], planHistory: [], incomplete: false, eventRanking: ranking,
    guestOutlook: {days: [guestOutlookDay('2026-11-07', parts(0, 12, 0), usual)]}};
  const text = renderBriefing('Test', buildBriefing(input));
  assert.match(text, /\n⚠ Slabší výhled: so 7\. 11\. zatím 12 hostů \(obvykle touhle dobou 20, −40 %\), v sobotu nejvíc táhla akce rock night \(hosté \+50 %\)(\n|$)/);
  assert.match(text, /\nAkce za půl roku: nejvíc táhne rock night/, 'the last day of the month');
  assert.doesNotMatch(renderBriefing('Test', buildBriefing({...input, businessDate: '2026-10-30'})), /Akce za půl roku/);
  assert.ok(todoList(buildBriefing(input)).some(item => item.text.endsWith('v sobotu nejvíc táhla akce rock night (hosté +50 %)')));
  assert.deepEqual(renderMenuWeek({prices: [{name: 'Burger', oldText: '289 Kč', newText: '309 Kč'}], added: ['Shake', 'Fries', 'Wings', 'Ribs'], removed: []}),
    ['Lístek za týden: nová cena 1× (Burger 289 Kč → 309 Kč) · nově Shake, Fries, Wings a další 1']);
  assert.deepEqual(renderMenuWeek({prices: [], added: [], removed: []}), []);
  assert.deepEqual(renderMenuWeek(null), []);
  const monday = buildBriefing({businessDate: '2026-10-11', config, bills: [], closings: [], planHistory: [], incomplete: false, menuWeek: {prices: [], added: [], removed: ['Quesadilla']}});
  assert.match(renderBriefing('Test', monday), /\nLístek za týden: zrušeno Quesadilla(\n|$)/);
});

test('forecast by section: tomorrow\'s amount split in the morning line', () => {
  const result = forecast({today: '2026-10-14', bases: Array(7).fill(10000000), seasonal: {}, monthActual: {cents: 0, days: 0}});
  result.days![1].bySection = [{section: 'diner', label: 'Diner', cents: 3333333}, {section: 'bar', label: 'Bar', cents: 3333333}, {section: 'club', label: 'Klub', cents: 3333334}];
  assert.match(renderForecast(result)[0], /^Odhad tržby: zítra \(čt 15\. 10\.\) 100 000 Kč \(Diner 34 000 Kč, Bar 33 000 Kč, Klub 33 000 Kč\) · 7 dní/, 'the parts add up to the rounded day');
  assert.deepEqual(sectionThousands(10000000, [{label: 'Diner', cents: 9960000}, {label: 'Bar', cents: 40000}]), [{label: 'Diner', cents: 10000000}], 'under 1 000 Kč left out');
});

test('the same local clock time days before, across the end of summer time', () => {
  // 30. 10. 2026 9:00 CET = 8:00 UTC; a week before (23. 10.) 9:00 CEST = 7:00 UTC.
  assert.equal(new Date(sameClockDaysBefore(new Date('2026-10-30T08:00:00Z'), 7, 'Europe/Prague')).toISOString(), '2026-10-23T07:00:00.000Z');
  assert.equal(new Date(sameClockDaysBefore(new Date('2026-10-14T07:00:00Z'), 14, 'Europe/Prague')).toISOString(), '2026-09-30T07:00:00.000Z');
});

test('public holidays: Easter by year, fixed days, the forecast and the morning note', () => {
  assert.deepEqual([2025, 2026, 2027, 2038].map(easterSunday), ['2025-04-20', '2026-04-05', '2027-03-28', '2038-04-25']);
  assert.equal(Object.keys(czechHolidays(2026)).length, 13);
  assert.deepEqual([holidayName('2026-04-03'), holidayName('2026-04-06'), holidayName('2026-10-28'), holidayName('2026-10-29')], ['Velký pátek', 'Velikonoční pondělí', 'Den vzniku státu', null]);
  const base = {bases: Array(7).fill(10000000), seasonal: {}, monthActual: {cents: 0, days: 0}};
  const plain = forecast({...base, today: '2026-10-27'});
  const holiday = forecast({...base, today: '2026-10-27', holidays: {'2026-10-28': {name: 'Den vzniku státu', factor: 0.8}, '2026-11-17': {name: 'Den boje za svobodu', factor: 1.2}}});
  assert.deepEqual([holiday.days[1].cents, holiday.days[1].holiday, holiday.days[1].holidayFactor], [8000000, 'Den vzniku státu', 0.8]);
  assert.equal(holiday.nextMonth.cents! - plain.nextMonth.cents!, 2000000, 'the month totals take the holidays too');
  assert.match(renderForecast(holiday)[0], /^Odhad tržby: zítra \(st 28\. 10\.\) 80 000 Kč \(svátek Den vzniku státu, bývá o 20 % méně\) · /);
  const closed = forecast({...base, today: '2026-12-23', holidays: {'2026-12-24': {name: 'Štědrý den', factor: 0}}});
  assert.match(renderForecast(closed)[0], /zítra \(čt 24\. 12\.\) 0 Kč \(svátek Štědrý den, loni zavřeno\)/);
  const unknown = forecast({...base, today: '2026-10-27', holidays: {'2026-10-28': {name: 'Den vzniku státu', factor: null}}});
  assert.match(renderForecast(unknown)[0], /zítra \(st 28\. 10\.\) 100 000 Kč \(svátek Den vzniku státu\) · /);
});

test('rain: the factor from past rainy days and the forecast of a rainy day', () => {
  assert.equal(rainFactor([0.8, 0.9, 0.7, 0.85, 0.9]), null, 'under 6 rainy days');
  assert.deepEqual(rainFactor([0.8, 0.9, 0.7, 0.85, 0.9, 0.75]), {factor: 0.83, days: 6});
  assert.deepEqual(rainFactor([0.2, 0.3, 0.1, 0.2, 0.3, 0.4]), {factor: 0.5, days: 6}, 'never under half');
  const weather = [{date: '2026-10-28', minC: 8, maxC: 12, rainMm: 7, symbol: 'rain'}, {date: '2026-10-29', minC: 8, maxC: 12, rainMm: 1, symbol: 'cloudy'}];
  const wet = forecast({today: '2026-10-27', bases: Array(7).fill(10000000), seasonal: {}, monthActual: {cents: 0, days: 0}, weather, rainFactor: {factor: 0.8, days: 9}});
  assert.deepEqual([wet.days[1].cents, wet.days[1].rainFactor, wet.days[2].cents], [8000000, 0.8, 10000000], 'only from 5 mm');
  assert.match(renderForecast(wet)[0], /zítra \(st 28\. 10\.\) 80 000 Kč \(déšť, bývá o 20 % méně\), 12 °C, déšť /);
});

test('supplier invoices: costs by kind, food cost, price rises, overdue invoices, the switch and the morning lines', () => {
  const invoice = (id: string, businessDate: string, items: SupplierInvoice['items'], extra: Partial<SupplierInvoice> = {}): SupplierInvoice => ({type: 'supplier_invoice', id, version: 1,
    businessDate, source: 'dishboard', supplier: 'Makro', supplierId: null, number: null, dueDate: null, paidDate: null, status: 'active',
    netCents: items.reduce((sum, item) => sum + item.netCents, 0), grossCents: 0, kind: 'food', category: null, items, ...extra});
  const item = (name: string, unitPriceCents: number, quantity = 1, extra: Partial<SupplierInvoice['items'][number]> = {}) => ({name, quantity, unit: 'ks', unitPriceCents,
    netCents: unitPriceCents * quantity, kind: null, category: null, ...extra});
  const invoices = [
    invoice('a', '2026-09-20', [item('Limety', 10000, 2), item('Borůvky', 4070, 10)]),
    invoice('b', '2026-10-02', [item('limety ', 11000, 2), item('Rum', 30000, 1, {kind: 'beverage', category: 'Destiláty'})], {netCents: 82000, grossCents: 99000, dueDate: '2026-10-05'}),
    invoice('c', '2026-10-03', [item('Borůvky', 5159, 10), item('Limety', 10200, 1)], {supplier: 'Jiný', grossCents: 60000, dueDate: '2026-10-10', paidDate: '2026-10-09'}),
    invoice('d', '2026-10-03', [], {netCents: 50000, kind: 'other', category: 'Úklid', status: 'cancelled'}),
  ];
  // The rest of an invoice not covered by its items falls to the invoice's kind and category.
  const summary = supplySummary(counted(invoices, []), '2026-10-01', '2026-10-31', {revenueCents: 1000000, revenueDays: 3});
  assert.deepEqual([summary.invoices, summary.netCents, summary.byKind.map(row => [row.kind, row.netCents]), summary.foodCostPermille],
    [2, 82000 + 61790, [['food', 113790], ['beverage', 30000]], 144]);
  assert.deepEqual(summary.byCategory.map(row => row.name), ['jídlo', 'Destiláty']);
  assert.deepEqual(summary.bySupplier.map(row => [row.name, row.invoices]), [['Makro', 1], ['Jiný', 1]]);
  assert.equal(supplySummary([], '2026-10-01', '2026-10-31', {revenueCents: 0, revenueDays: 0}).foodCostPermille, null);
  // Same item = same supplier, name (case, spaces) and unit; a cheaper next purchase ends the rise; another supplier is another item.
  const rises = priceRises(invoices, '2026-10-01', '2026-10-03');
  assert.deepEqual(rises.map(rise => [rise.supplier, rise.name, rise.oldCents, rise.newCents, rise.permille, rise.extraCents]), [['Makro', 'limety ', 10000, 11000, 100, 2000]]);
  assert.deepEqual(priceRises(invoices, '2026-10-01', '2026-10-03', 50).length, 1);
  assert.deepEqual(priceRises([...invoices, invoice('e', '2026-10-04', [item('Limety', 10500, 2)])], '2026-10-01', '2026-10-04').length, 0, 'a cheaper purchase after the rise clears it');
  assert.deepEqual(overdueInvoices(invoices, '2026-10-05'), [], 'the due day itself is not late');
  assert.deepEqual(overdueInvoices(invoices, '2026-10-08').map(row => [row.supplier, row.days, row.grossCents]), [['Makro', 3, 99000]]);
  assert.equal(counted(invoices, ['dishboard']).length, 0, 'a switched-off sender counts nowhere');
  assert.equal(unitPrice(5159), '51,59 Kč');
  const brief = supplyBrief(counted(invoices, []), '2026-10-07', {revenueCents: 1000000, revenueDays: 7})!;
  assert.deepEqual(renderSupplies(brief), [
    'Nákupy od 1. 10. do 7. 10. (faktury, bez DPH): 1 438 Kč · jídlo 1 138 Kč · nápoje 300 Kč · food cost 14,4 % z tržeb s DPH',
    '⚠ Zdražení za 7 dní: limety / ks (Makro) 100,00 → 110,00 Kč (+10 %)',
    '⚠ Faktury po splatnosti: 1 za 990 Kč (nejstarší Makro, 990 Kč, splatná 5. 10. (3 dny))',
  ]);
  assert.equal(supplyBrief([], '2026-10-07', {revenueCents: 0, revenueDays: 0}), null);
  const todo = todoList({...buildBriefing({businessDate: '2026-10-07', config, bills: [], closings: [], planHistory: [], incomplete: false}), supplies: brief});
  assert.deepEqual(todo.filter(row => /Zdražení|splatnosti/.test(row.text)).map(row => [row.text.slice(0, 30), row.amountCents]),
    [['Faktura po splatnosti: Makro, ', 99000], ['Zdražení: limety / ks (Makro) ', 2000]]);
});

const menuOf = (items: MenuItem[]): Menu => ({type: 'menu', id: 'menu-web', version: 1, businessDate: '2026-10-08', source: 'web', items, notes: []});
const dish = (id: string, category: string, name: string, pricesCents: number[], extra: Partial<MenuItem> = {}): MenuItem =>
  ({id, part: 'food', category, group: null, name, description: null, volume: null, volumeMl: null, pricesCents, tip: false, ...extra});
const drink = (id: string, name: string, volumeMl: number, cents: number): MenuItem =>
  dish(id, 'Pivo', name, [cents], {part: 'drinks', volume: `${volumeMl / 1000} l`, volumeMl});

test('POS products are paired to the menu by name, size by volume or price, and only clear look-alikes', () => {
  const menu = menuOf([dish('b1', 'Burgery', 'Classic Burger', [22500, 25500]), dish('b2', 'Burgery', 'Texas Burger', [24500]),
    drink('p3', 'Plzeň', 300, 6500), drink('p5', 'Plzeň', 500, 8900), dish('s1', 'Saláty', 'Caesar salát', [19500])]);
  assert.equal(nameKey('Coca-Cola 0,33 l'), 'coca cola');
  assert.equal(volumeOf('Finlandia 4cl'), 40);
  assert.deepEqual(pairSale(menu, {name: 'CLASSIC BURGER', quantity: 2, grossCents: 45000}), {itemId: 'b1', how: 'name'});
  assert.deepEqual(pairSale(menu, {name: 'Plzeň 0,5 l', quantity: 3, grossCents: 26700}), {itemId: 'p5', how: 'name'});
  assert.deepEqual(pairSale(menu, {name: 'Plzen', quantity: 2, grossCents: 13000}), {itemId: 'p3', how: 'name'}, 'no volume: the closest price');
  assert.deepEqual(pairSale(menu, {name: 'Caesar salát s kuřetem', quantity: 1, grossCents: 21500}), {itemId: 's1', how: 'similar'});
  assert.equal(pairSale(menu, {name: 'Burger', quantity: 1, grossCents: 22500}), null, 'two burgers share the word: unpaired');
  assert.equal(pairSale(menu, {name: 'Tonic', quantity: 1, grossCents: 6000}), null);
  assert.deepEqual([volumeOf('Víno 1/8 l'), volumeOf('Pivo 1/2 l'), nameKey('Víno 1/8 l')], [125, 500, 'vino']);
  const burgers = menuOf([dish('c', 'Burgery', 'Cheeseburger', [21500]), dish('d', 'Burgery', 'Double bacon cheeseburger', [29500]),
    dish('k', 'Hlavní', 'Kuře na grilu', [26500]), dish('h', 'Přílohy', 'Batátové hranolky', [8900])]);
  assert.equal(pairSale(burgers, {name: 'Double cheeseburger', quantity: 1, grossCents: 26500}), null, 'two burgers close: unpaired');
  assert.equal(pairSale(burgers, {name: 'Kuře na pepři', quantity: 1, grossCents: 26500}), null, 'filler words do not pair');
  assert.equal(pairSale(burgers, {name: 'Hranolky', quantity: 1, grossCents: 6900}), null, 'half the words are not enough');
});

test('profit by item: revenue without VAT, food cost per piece and what is missing', () => {
  const menu = menuOf([dish('b1', 'Burgery', 'Classic Burger', [22500]), dish('b2', 'Burgery', 'Texas Burger', [24500])]);
  const sales: ItemSale[] = [{key: 'p1', productId: 'p1', name: 'Classic Burger', quantity: 4, grossCents: 89600, netCents: 80000},
    {key: 'p2', productId: 'p2', name: 'Texas Burger', quantity: 1, grossCents: 22400, netCents: 20000}, {key: 'name:Tonic', productId: null, name: 'Tonic', quantity: 2, grossCents: 11200, netCents: 10000}];
  const profit = itemProfit(menu, sales, new Map([['b1', 7000]]));
  assert.deepEqual(profit.items.map(row => [row.itemId, row.quantity, row.netCents, row.costCents, row.profitCents]), [['b1', 4, 80000, 28000, 52000], ['b2', 1, 20000, null, null]]);
  assert.deepEqual(profit.unpaired.map(row => row.name), ['Tonic']);
  assert.deepEqual([profit.totals.pairedPermille, profit.totals.profitCents, profit.missing], [909, null, ['food cost za kus (nákupní ceny a receptury)']]);
  const noVat = itemProfit(menu, [{...sales[0], netCents: null}], new Map([['b1', 7000]]));
  assert.deepEqual([noVat.items[0].profitCents, noVat.missing], [null, ['sazba DPH u položek pokladny']]);
});

test('virtual repricing rounds to 5 Kč, filters by part, category and name, and keeps pieces sold', () => {
  const menu = menuOf([dish('b1', 'Burgery', 'Classic Burger', [22500, 25500]), dish('b2', 'Burgery', 'Texas Burger', [24500]), drink('p5', 'Plzeň', 500, 8900)]);
  const up = repricing(menu, {category: 'burgery', percent: 10}, new Map([['b1', {quantity: 10, grossCents: 225000}]]));
  assert.deepEqual(up.items.map(item => [item.itemId, item.newPricesCents, item.newText]), [['b1', [25000, 28000], '250 / 280 Kč'], ['b2', [27000], '270 Kč']]);
  assert.deepEqual(up.sales, {items: 1, grossCents: 225000, newGrossCents: 250000, differenceCents: 25000});
  assert.deepEqual(repricing(menu, {part: 'drinks', deltaCents: 1000, stepCents: 100}, new Map()).items.map(item => item.newPricesCents), [[9900]]);
  assert.deepEqual(repricing(menu, {query: 'texas', percent: -50}, new Map()).items.map(item => item.newPricesCents), [[12500]]);
  assert.equal(repricing(menu, {query: 'pizza', percent: 5}, new Map()).count, 0);
  const free = repricing(menuOf([dish('w', 'Voda', 'Voda z kohoutku', [0]), dish('e', 'Voda', 'Espresso', [6200])]), {deltaCents: -10000}, new Map());
  assert.deepEqual(free.items.map(item => [item.newPricesCents, item.atMinimum ?? false]), [[[0], false], [[500], true]], 'free stays free, a price stays at one step');
});

test('price check: too cheap and too expensive in a category (per litre for sizes) and gaps in the price ladder', () => {
  const findings = priceCheck(menuOf([dish('b1', 'Burgery', 'A', [22500]), dish('b2', 'Burgery', 'B', [24500]), dish('b3', 'Burgery', 'C', [25500]),
    dish('b4', 'Burgery', 'D', [9900]), dish('b5', 'Burgery', 'E', [59900]), dish('x1', 'Malé', 'Jen tři', [100]),
    drink('p1', 'Pivo 1', 300, 6500), drink('p2', 'Pivo 2', 500, 8900), drink('p3', 'Pivo 3', 500, 9500), drink('p4', 'Pivo 4', 300, 2500)]));
  assert.deepEqual(findings.map(f => [f.kind, f.itemId, f.suggestedCents]), [['cheap', 'b4', 22500], ['expensive', 'b5', 25500], ['gap', null, 16000], ['gap', null, 42500], ['cheap', 'p4', 4500]]);
  assert.match(findings[4].text, /za litr/);
  const wine = priceCheck(menuOf([drink('v1', 'Víno 1', 100, 6000), drink('v2', 'Víno 2', 100, 7000), drink('v3', 'Víno 1 láhev', 750, 45000),
    drink('v4', 'Víno 2 láhev', 750, 52000), drink('v5', 'Víno 3', 100, 6500), dish('t', 'Pivo', 'Voda', [0], {part: 'drinks'})]));
  assert.deepEqual(wine, [], 'sizes are no gap and no outlier, a free item is left out');
  const zeros = priceCheck(menuOf([0, 0, 0, 0, 0, 3000, 3500, 4000, 4500].map((cents, index) => dish(`z${index}`, 'Nealko', `N${index}`, [cents]))));
  assert.ok(zeros.every(finding => finding.kind !== 'expensive'), 'free items do not make every price look expensive');
});
