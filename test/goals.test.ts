import assert from 'node:assert/strict';
import {test} from 'node:test';
import {buildBriefing, guestOutlookDay, renderBriefing, renderMonth, renderTarget} from '../src/briefing.ts';
import {gapsText, hasGaps, monthBase, monthDays, monthTarget, shiftSignals, shiftText} from '../src/goals.ts';
import {todoList} from '../src/todo.ts';
import type {TenantConfig} from '../src/validate.ts';

const config: TenantConfig = {
  name: 'Testovací podnik', timeZone: 'Europe/Prague', businessDayCutoffHour: 6, sendHours: [7, 8, 9],
  registers: ['bar', 'klub'], sections: {diner: 'Diner', bar: 'Bar', club: 'Klub'}, recipients: [], bottleCheck: null, reportsLink: null, dashboardPhones: null, web: null, location: null, disabledSources: [],
};
const empty = {config, bills: [], closings: [], planHistory: [], incomplete: false};
const parts = (day: number, evening: number, night: number) => ({day, evening, night});

test('month base: the whole month from its days with data, at most 2 days missing', () => {
  assert.deepEqual([monthDays('2026-10'), monthDays('2026-02'), monthDays('2028-02'), monthDays('2026-12')], [31, 28, 29, 31]);
  const revenue = (missing: number) => (date: string) => Number(date.slice(8)) <= missing ? null : 10000000;
  assert.deepEqual(monthBase('2025-10', revenue(2)), {cents: 310000000, days: 29}, '2 missing days filled with the daily average');
  assert.equal(monthBase('2025-10', revenue(3)), null, '3 missing days: no base');
  assert.equal(monthBase('2025-10', () => null), null);
});

test('month target: base + 5 %, so far, the forecast and what each remaining day needs', () => {
  const target = monthTarget('2026-10-19', {basis: 'last_year', month: '2025-10', cents: 300000000}, {actualCents: 180000000, actualDays: 18, elapsedDays: 18, totalCents: 310000000})!;
  assert.deepEqual([target.targetCents, target.daysLeft, target.perDayCents], [315000000, 13, 10384616], '13 days from 19. 10. to 31. 10., rounded up');
  assert.deepEqual(renderTarget(target), ['Cíl na říjen 3 150 000 Kč (loni 3 000 000 Kč +5 %): zatím 1 800 000 Kč (57 %) · odhad za měsíc 3 100 000 Kč (−2 % pod cílem) · potřeba 103 846 Kč denně (13 dní do konce měsíce)']);
  const reached = monthTarget('2026-10-19', {basis: 'previous_month', month: '2026-09', cents: 100000000}, {actualCents: 180000000, actualDays: 18, elapsedDays: 18, totalCents: null});
  assert.deepEqual(renderTarget(reached), ['Cíl na říjen 1 050 000 Kč (září 1 000 000 Kč +5 %): zatím 1 800 000 Kč (171 %) · cíl je splněný']);
  assert.equal(monthTarget('2026-10-19', null, {actualCents: 0, actualDays: 0, elapsedDays: 0, totalCents: null}), null);
  assert.deepEqual(renderTarget(null), []);
  const briefing = buildBriefing({businessDate: '2026-10-18', ...empty, target});
  assert.match(renderBriefing('Test', briefing), /\nCíl na říjen 3 150 000 Kč \(loni/);
});

test('shifts: a part of the day 30 % and 15 guests over or under its usual', () => {
  const past = [{final: parts(10, 100, 60), early: parts(10, 100, 60)}, {final: parts(10, 100, 60), early: parts(10, 100, 60)}];
  const busy = guestOutlookDay('2026-10-24', parts(20, 140, 40), past), calm = guestOutlookDay('2026-10-25', parts(10, 85, 60), past);
  assert.deepEqual(busy.parts.map(part => part.usual), [10, 100, 60]);
  const signals = shiftSignals([busy, calm]);
  assert.deepEqual(signals.map(signal => [signal.date, signal.part, signal.direction]), [['2026-10-24', 'evening', 'up'], ['2026-10-24', 'night', 'down']],
    'day +10 guests is under 15, evening 140 of 100 is up, night 40 of 60 is down, 85 of 100 is within 30 %');
  assert.equal(shiftText(signals[0]), 'so 24. 10. večer posílit (čekej asi 140 hostů z rezervací, obvykle 100)');
  assert.deepEqual(shiftSignals([guestOutlookDay('2026-10-24', parts(0, 140, 0), past.slice(0, 1))]), [], 'no usual from one past day');
  const briefing = buildBriefing({businessDate: '2026-10-23', ...empty, guestOutlook: {days: [busy, calm]}});
  assert.match(renderBriefing('Test', briefing), /\nSměny na 7 dní: so 24\. 10\. večer posílit \(čekej asi 140 hostů z rezervací, obvykle 100\) · so 24\. 10\. noc ubrat \(čekej asi 40 hostů z rezervací, obvykle 60\)(\n|$)/);
  assert.ok(todoList(briefing).some(item => item.level === 'info' && item.text === 'Směna: so 24. 10. večer posílit (čekej asi 140 hostů z rezervací, obvykle 100)'));
});

test('data gaps: days without revenue and days from the cash book only, in the message and the to-do list', () => {
  const gaps = {from: '2026-10-04', to: '2026-10-17', noRevenue: ['2026-10-05'], journalOnly: ['2026-10-15']};
  assert.equal(gapsText(gaps), 'bez tržby 5. 10. · jen z peněžního deníku, chybí denní report 15. 10.');
  assert.deepEqual([hasGaps(gaps), hasGaps({...gaps, noRevenue: [], journalOnly: []}), hasGaps(null)], [true, false, false]);
  const briefing = buildBriefing({businessDate: '2026-10-17', ...empty, dataGaps: gaps});
  assert.match(renderBriefing('Test', briefing), /\n⚠ Chybí data za 14 dní: bez tržby 5\. 10\. · jen z peněžního deníku, chybí denní report 15\. 10\.\n/);
  assert.ok(todoList(briefing).some(item => item.level === 'warn' && item.text.startsWith('Doplnit chybějící data za 14 dní: bez tržby 5. 10.')));
  assert.doesNotMatch(renderBriefing('Test', buildBriefing({businessDate: '2026-10-17', ...empty, dataGaps: {...gaps, noRevenue: [], journalOnly: []}})), /Chybí data/);
});

test('last year: the day against 364 days before, the month against the same days a year before', () => {
  const briefing = buildBriefing({businessDate: '2026-10-17', ...empty, lastYearRevenueCents: 40000000, report: {
    businessDate: '2026-10-17', source: 'admin', files: [], notes: null, warnings: [],
    lines: [{kind: 'revenue_section', key: 'club', label: 'Club', count: null, amountCents: 50000000}]}});
  assert.match(renderBriefing('Test', briefing), /\nTržba: 500 000 Kč[^\n]* · loni 400 000 Kč \(\+25 %\)/);
  const part = {revenueCents: 300000000, revenueDays: 11, bySection: null};
  const month = {month: '2026-10', through: '2026-10-11', complete: false, current: part, previous: {...part, revenueDays: 0, revenueCents: 0, month: '2026-09', through: '2026-09-11'},
    lastYear: {...part, revenueCents: 200000000, month: '2025-10', through: '2025-10-11'},
    payouts: [], payoutsCents: 0, expenses: [], expensesCents: 0, discounts: [], discountsCents: 0};
  assert.deepEqual(renderMonth(month), ['Říjen do 11. 10.: tržba 3 000 000 Kč (+50 % proti loňsku)']);
  assert.deepEqual(renderMonth({...month, lastYear: {...month.lastYear, revenueDays: 10}}), ['Říjen do 11. 10.: tržba 3 000 000 Kč'], 'only with as many days of data');
});
