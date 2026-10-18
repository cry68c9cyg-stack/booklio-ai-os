import assert from 'node:assert/strict';
import {test} from 'node:test';
import {buildBriefing, renderBriefing, renderMonth} from '../src/briefing.ts';
import type {DailyReport} from '../src/daily-report.ts';
import {addDays} from '../src/time.ts';
import {todoList} from '../src/todo.ts';
import type {TenantConfig} from '../src/validate.ts';
import {cashDiffRepeat, renderVoidWeek, sumVoids, voidAndDiff, voidDay, voidMonthText} from '../src/voids.ts';

const config: TenantConfig = {
  name: 'Testovací podnik', timeZone: 'Europe/Prague', businessDayCutoffHour: 6, sendHours: [7, 8, 9],
  registers: ['bar', 'klub'], sections: {diner: 'Diner', bar: 'Bar', club: 'Klub'}, recipients: [], bottleCheck: null, reportsLink: null, dashboardPhones: null, web: null, location: null, disabledSources: [], foodCostLimitPermille: null,
};
const empty = {config, bills: [], closings: [], planHistory: [], incomplete: false};
/** A synthetic day (crowns): revenue 400 000 Kč with the daily report, voids, and the cash book's difference; `null` leaves a part out. */
const report = (date: string, voids: number | null, diff: number | null): DailyReport => ({businessDate: date, source: 'admin', files: [], notes: null, warnings: [], lines: [
  ...(voids === null ? [] : [{kind: 'revenue_section' as const, key: 'club', label: 'CLUB Celkem', count: null, amountCents: 40000000},
    {kind: 'void' as const, key: 'void', label: 'Storno:', count: null, amountCents: voids * 100}]),
  ...(diff === null ? [] : [{kind: 'total' as const, key: 'cash-difference', label: 'Rozdíl přepočtu a zůstatku', count: null, amountCents: diff * 100}]),
]});

test('voids against the revenue and cash differences, by day and month', () => {
  assert.deepEqual(voidDay(report('2026-10-17', 1720, 0)), {date: '2026-10-17', voidCents: 172000, revenueCents: 40000000, cashDiffCents: 0});
  assert.deepEqual(voidDay(report('2026-10-15', null, 139)), {date: '2026-10-15', voidCents: null, revenueCents: null, cashDiffCents: 13900}, 'cash book only');
  const journal = report('2026-10-14', null, 53);
  journal.lines.push({kind: 'revenue_section', key: 'club', label: 'Tržba Club', count: null, amountCents: 30000000});
  assert.equal(voidDay(journal)!.voidCents, null, 'revenue from the cash book alone has no voids');
  const sum = sumVoids([voidDay(report('2026-10-15', null, 139)), voidDay(report('2026-10-16', 2000, -250)), voidDay(report('2026-10-17', 1720, 73)), null]);
  assert.deepEqual([sum.reportDays, sum.voidCents, sum.revenueCents, sum.cashDays, sum.cashDiffCents, sum.diffDays.length], [2, 372000, 80000000, 3, -3800, 2]);
  assert.equal(voidMonthText(sum), 'storna 3 720 Kč (0,47 % tržby) · rozdíly v kase celkem −38 Kč (2 dny nad 100 Kč)');
  const part = {revenueCents: 80000000, revenueDays: 2, bySection: null};
  const month = {month: '2026-10', through: '2026-10-17', complete: false, current: part, previous: {...part, revenueDays: 0, revenueCents: 0, month: '2026-09', through: '2026-09-17'},
    payouts: [], payoutsCents: 0, expenses: [], expensesCents: 0, discounts: [], discountsCents: 0, voids: sum};
  assert.match(renderMonth(month)[0], / · storna 3 720 Kč \(0,47 % tržby\) · rozdíly v kase celkem −38 Kč \(2 dny nad 100 Kč\)$/);
});

test('the week of voids on Monday, and a cash difference 3 times in 7 days', () => {
  const days = (to: string, count: number, voids: number) => Array.from({length: count}, (_, i) => voidDay(report(addDays(to, -i), voids, 0)));
  assert.deepEqual(renderVoidWeek({week: sumVoids(days('2026-10-18', 7, 2000)), before: sumVoids(days('2026-10-11', 28, 1000))}),
    ['Storna za týden: 14 000 Kč (0,5 % tržby, 4 týdny předtím 0,25 %)']);
  assert.deepEqual(renderVoidWeek({week: sumVoids(days('2026-10-18', 4, 2000)), before: sumVoids(days('2026-10-11', 28, 1000))}), [], 'too few days');
  const week = [50, -120, 0, 150, null, -300, 20].map((diff, i) => voidDay(report(addDays('2026-10-11', i), 1000, diff)));
  const found = cashDiffRepeat(week)!;
  assert.deepEqual(found.map(day => [day.date, day.cents]), [['2026-10-12', -12000], ['2026-10-14', 15000], ['2026-10-16', -30000]]);
  assert.equal(cashDiffRepeat(week.slice(0, 5)), null, 'twice only');
  const briefing = buildBriefing({businessDate: '2026-10-17', ...empty, cashDiffRepeat: found});
  assert.match(renderBriefing('Test', briefing), /\n⚠ Kasa: rozdíl v kase 3× za 7 dní: 12\. 10\. −120 Kč, 14\. 10\. \+150 Kč, 16\. 10\. −300 Kč/);
  assert.ok(todoList(briefing).some(item => item.level === 'warn' && item.text.startsWith('Kasa: rozdíl v kase 3×')));
});

test('unusual voids and a cash difference on the same day', () => {
  const past = [7, 14, 21, 28].map(back => voidDay(report(addDays('2026-10-17', -back), 1500, 0)));
  const found = voidAndDiff(voidDay(report('2026-10-17', 4000, -250)), past)!;
  assert.deepEqual([found.voidCents, found.usualCents, found.cashDiffCents], [400000, 150000, -25000]);
  assert.equal(voidAndDiff(voidDay(report('2026-10-17', 4000, -50)), past), null, 'a difference under 100 Kč');
  assert.equal(voidAndDiff(voidDay(report('2026-10-17', 2000, -250)), past), null, 'voids within 1,5× of usual');
  assert.equal(voidAndDiff(voidDay(report('2026-10-17', 4000, -250)), past.slice(0, 1)), null, 'one past day');
  const briefing = buildBriefing({businessDate: '2026-10-17', ...empty, voidAndDiff: found});
  assert.match(renderBriefing('Test', briefing), /\n⚠ Storna a rozdíl v kase: 17\. 10\. storna 4 000 Kč \(so obvykle 1 500 Kč\) a zároveň rozdíl v kase −250 Kč; projít storna toho dne/);
  assert.ok(todoList(briefing).some(item => item.level === 'warn' && item.amountCents === 250000));
});
