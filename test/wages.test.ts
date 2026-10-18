import assert from 'node:assert/strict';
import {test} from 'node:test';
import {buildBriefing, renderBriefing, renderMonth} from '../src/briefing.ts';
import type {Night} from '../src/cash.ts';
import type {DailyReport} from '../src/daily-report.ts';
import {todoList} from '../src/todo.ts';
import type {TenantConfig} from '../src/validate.ts';
import {nightShare, payoutKind, renderNightShares, renderStaffGaps, staffGapToday, staffGaps, sumWages, wageDay} from '../src/wages.ts';

const config: TenantConfig = {
  name: 'Testovací podnik', timeZone: 'Europe/Prague', businessDayCutoffHour: 6, sendHours: [7, 8, 9],
  registers: ['bar', 'klub'], sections: {diner: 'Diner', bar: 'Bar', club: 'Klub'}, recipients: [], bottleCheck: null, reportsLink: null, dashboardPhones: null, web: null, location: null, disabledSources: [], foodCostLimitPermille: null,
};
const empty = {config, bills: [], closings: [], planHistory: [], incomplete: false};
const payout = (label: string, crowns: number) => ({kind: 'payout' as const, key: label.toLowerCase(), label, count: null, amountCents: crowns * 100});
const report = (date: string, lines: DailyReport['lines']): DailyReport => ({businessDate: date, source: 'admin', files: [], notes: null, warnings: [], lines});
const night = (date: string, staff: number, club: number | null): Night =>
  ({date, dj: null, clubCents: club === null ? null : club * 100, revenueCents: null, staffCents: staff * 100, payoutsCents: staff * 100, expensesCents: 0, resultCents: club === null ? null : (club - staff) * 100});

test('cash payouts by kind: the night, wages beyond the night and trial shifts', () => {
  assert.deepEqual(['Security', 'Tanečnice', 'Hosteska den+noc', 'Animátorky', 'Zkouška Testerka klub', 'Kuchyň výplaty Test', 'Výpomoc kuchyně', 'Uklízečka výplata'].map(payoutKind),
    ['night', 'night', 'night', 'night', 'trial', 'wage', 'wage', 'wage']);
  const day = wageDay(report('2026-10-17', [payout('Security', 5000), payout('DJ', 4000), payout('Zkouška Testerka klub', 1000), payout('Kuchyň výplaty Test', 110000),
    {kind: 'expense', key: 'led', label: 'Led', count: null, amountCents: 50000}]))!;
  assert.deepEqual([day.nightCents, day.wageCents, day.trialCents, day.trials.length], [900000, 11000000, 100000, 1]);
  assert.equal(wageDay(report('2026-10-17', [])), null);
  const briefing = buildBriefing({businessDate: '2026-10-17', ...empty, wageDay: day});
  assert.match(renderBriefing('Test', briefing), /\nZ kasy: mzdy mimo noc 110 000 Kč \(Kuchyň výplaty Test 110 000 Kč\) · zkušební směny 1× 1 000 Kč(\n|$)/);
  const sum = sumWages([day, null, {...day, date: '2026-10-16'}]);
  assert.deepEqual(sum, {nightCents: 1800000, trialCents: 200000, trials: 2, wageCents: 22000000});
  const part = {revenueCents: 300000000, revenueDays: 17, bySection: null};
  const month = {month: '2026-10', through: '2026-10-17', complete: false, current: part, previous: {...part, revenueDays: 0, revenueCents: 0, month: '2026-09', through: '2026-09-17'},
    payouts: [], payoutsCents: 24000000, expenses: [], expensesCents: 0, discounts: [], discountsCents: 0, wages: sum};
  assert.match(renderMonth(month)[0], /výplaty v hotovosti 240 000 Kč \(8,0 % tržby; noc 18 000 Kč, mzdy mimo noc 220 000 Kč, zkušební směny 2× 2 000 Kč\)/);
});

test('the night staff against the club: an unusual share of the same weekday, and the Monday line', () => {
  const past = [night('2026-09-25', 15000, 250000), night('2026-10-02', 15000, 300000), night('2026-10-09', 15000, 200000), night('2026-10-08', 30000, 100000)];
  const alarm = nightShare(night('2026-10-16', 18000, 120000), past)!;
  assert.deepEqual([alarm.sharePermille, alarm.usualSharePermille, alarm.overCents], [150, 60, 1080000], 'Friday usual 6 % (median of 5, 6, 7,5 %), 120 000 × 6 % = 7 200, 10 800 over');
  assert.equal(nightShare(night('2026-10-16', 16000, 250000), past), null, '6,4 % is usual');
  assert.equal(nightShare(night('2026-10-16', 4000, 20000), past), null, '20 % but only 2 800 Kč over');
  const briefing = buildBriefing({businessDate: '2026-10-16', ...empty, nightShare: alarm});
  assert.match(renderBriefing('Test', briefing), /\n⚠ Výplaty noci nad obvyklým podílem: 16\. 10\. výplaty noci 18 000 Kč = 15 % tržby klubu \(pá obvykle 6 %\), o 10 800 Kč víc(\n|$)/);
  assert.ok(todoList(briefing).some(item => item.level === 'warn' && item.text.startsWith('Výplaty noci nad obvyklým podílem: 16. 10.')));
  assert.deepEqual(renderNightShares([...past, night('2026-10-16', 18000, 120000), night('2026-10-17', 1000, null)]),
    ['Výplaty noci za 4 týdny: 9,6 % tržby klubu'], '93 000 of 970 000; a weekday needs 2 nights, so with Fridays only there is no spread');
  assert.deepEqual(renderNightShares([...past, night('2026-10-16', 18000, 120000), night('2026-10-15', 20000, 100000)]),
    ['Výplaty noci za 4 týdny: 10,6 % tržby klubu (nejvíc čt 25 %, nejmíň pá 7,2 %)']);
  assert.deepEqual(renderNightShares(past.slice(0, 3)), []);
});

test('missing staff by weekday from the report texts, and the morning of such a weekday', () => {
  const gaps = staffGaps('2026-08-23', '2026-10-17', [{date: '2026-10-09', themes: ['staff']}, {date: '2026-10-16', themes: ['staff', 'slow']}, {date: '2026-10-11', themes: ['staff']}, {date: '2026-10-12', themes: ['busy']}]);
  assert.deepEqual(gaps.byWeekday.map(row => [row.weekday, row.dates.length]), [[5, 2], [0, 1]]);
  assert.equal(staffGapToday('2026-10-23', gaps), 'dnes pá: za 8 týdnů 2× chyběl personál (9. 10., 16. 10.), domluv náhradníka');
  assert.equal(staffGapToday('2026-10-18', gaps), null, 'once is not a pattern');
  assert.deepEqual(renderStaffGaps(gaps), ['Chybí personál za 8 týdnů: pá 2×, ne 1×']);
  const briefing = buildBriefing({businessDate: '2026-10-22', ...empty, staffGaps: gaps});
  assert.match(renderBriefing('Test', briefing), /\nPersonál: dnes pá: za 8 týdnů 2× chyběl personál/);
  assert.ok(todoList(briefing).some(item => item.level === 'info' && item.text.startsWith('Personál: dnes pá')));
});
