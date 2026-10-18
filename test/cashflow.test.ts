import assert from 'node:assert/strict';
import {test} from 'node:test';
import {buildBriefing, renderBriefing} from '../src/briefing.ts';
import {cashFlowDay, cashForecast, cashShare, renderCashShare, renderDeposits} from '../src/cashflow.ts';
import type {DailyReport} from '../src/daily-report.ts';
import {addDays, weekday} from '../src/time.ts';
import {todoList} from '../src/todo.ts';
import type {TenantConfig} from '../src/validate.ts';

const config: TenantConfig = {
  name: 'Testovací podnik', timeZone: 'Europe/Prague', businessDayCutoffHour: 6, sendHours: [7, 8, 9],
  registers: ['bar', 'klub'], sections: {diner: 'Diner', bar: 'Bar', club: 'Klub'}, recipients: [], bottleCheck: null, reportsLink: null, dashboardPhones: null, web: null, location: null, disabledSources: [], foodCostLimitPermille: null,
};
const empty = {config, bills: [], closings: [], planHistory: [], incomplete: false};
/** A synthetic day of the cash book (crowns): revenue 200 000 Kč, cash from the sales, wages, an expense, the counted cash and safe. */
const book = (date: string, cashIn: number, wages: number, expense = 0, counted = 30000, safe = 10000): DailyReport => ({businessDate: date, source: 'admin', files: [], notes: null, warnings: [], lines: [
  {kind: 'revenue_section', key: 'club', label: 'Deník: Tržba Club', count: null, amountCents: 20000000},
  {kind: 'payment', key: 'cash', label: 'Deník: Hotovost', count: null, amountCents: cashIn * 100},
  {kind: 'payout', key: 'security', label: 'Security', count: null, amountCents: wages * 100},
  ...(expense ? [{kind: 'expense' as const, key: 'roman', label: 'Roman', count: null, amountCents: expense * 100}] : []),
  {kind: 'cash_count', key: 'hotovost', label: 'Hotovost', count: null, amountCents: counted * 100},
  {kind: 'balance', key: 'safe', label: 'Trezor', count: null, amountCents: safe * 100},
]});

test('a day of the till, with a withdrawal paying for an expense', () => {
  assert.deepEqual(cashFlowDay(book('2026-10-17', 5000, 20000, 2000)), {date: '2026-10-17', inCents: 500000, outCents: 2200000, revenueCents: 20000000, cashCents: 4000000});
  const withdrawal = book('2026-10-14', 500, 10000, 110000);
  withdrawal.lines.push({kind: 'movement', key: 'vyber-hotovosti', label: 'Výběr hotovosti', count: null, amountCents: -11000000});
  assert.equal(cashFlowDay(withdrawal)!.outCents, 1000000, 'the withdrawn cash paid for the expense');
  const merged = book('2026-10-16', 3000, 10000);
  merged.lines.push({kind: 'journal_payment', key: 'cash', label: 'Deník: Hotovost', count: null, amountCents: 280000});
  assert.equal(cashFlowDay(merged)!.inCents, 280000, 'the cash book before the daily report');
  assert.equal(cashFlowDay(null), null);
});

test('the 7 days ahead with the deposits it takes', () => {
  // Mondays pay 90 000 Kč of wages, other days 10 000 Kč; every day brings 4 000 Kč in cash.
  const days = Array.from({length: 28}, (_, i) => { const date = addDays('2026-09-21', i); return cashFlowDay(book(date, 4000, weekday(date) === 1 ? 90000 : 10000)); });
  const forecast = cashForecast('2026-10-18', days)!;
  assert.deepEqual(forecast.days.map(day => [day.date, day.outCents / 100, day.depositCents / 100, day.balanceCents / 100]),
    [['2026-10-19', 90000, 46000, 0], ['2026-10-20', 10000, 6000, 0], ['2026-10-21', 10000, 6000, 0], ['2026-10-22', 10000, 6000, 0], ['2026-10-23', 10000, 6000, 0], ['2026-10-24', 10000, 6000, 0], ['2026-10-25', 10000, 6000, 0]]);
  assert.deepEqual([forecast.startCents, forecast.inCents, forecast.outCents, forecast.depositCents, forecast.firstShort], [4000000, 2800000, 15000000, 8200000, '2026-10-19']);
  assert.equal(cashForecast('2026-10-18', days.slice(-10)), null, 'one week of the cash book only');
  const briefing = buildBriefing({businessDate: '2026-10-18', ...empty, cashForecast: forecast});
  const text = renderBriefing('Test', briefing);
  assert.match(text, /\nHotovost na 7 dní: v kase a trezoru 40 000 Kč; do ne 25\. 10\. obvykle odejde asi 150 000 Kč na výplaty a výdaje, z tržeb přijde v hotovosti asi 28 000 Kč; vklad JD bude potřeba asi 82 000 Kč, poprvé po 19\. 10\.(\n|$)/);
  assert.match(text, /\nVklady JD na týden, aby hotovost na výplaty a výdaje stačila: po 19\. 10\. 46 000 Kč, út 20\. 10\. 6 000 Kč, .*ne 25\. 10\. 6 000 Kč \(celkem 82 000 Kč\)(\n|$)/);
  assert.ok(todoList(briefing).some(item => item.level === 'info' && item.amountCents === 8200000));
  const enough = cashForecast('2026-10-18', days.map(day => day && {...day, cashCents: 50000000}))!;
  assert.equal(enough.firstShort, null);
  assert.deepEqual(renderDeposits(enough), ['Vklady JD na týden: nebudou potřeba, hotovost na výplaty a výdaje obvykle vystačí (na konci týdne asi 378 000 Kč)']);
  assert.doesNotMatch(renderBriefing('Test', buildBriefing({businessDate: '2026-10-17', ...empty, cashForecast: forecast})), /Vklady JD na týden/, 'the deposits only on Monday');
});

test('the cash part of the revenue, the week against the 4 weeks before', () => {
  const days = (to: string, count: number, cashIn: number) => Array.from({length: count}, (_, i) => cashFlowDay(book(addDays(to, -i), cashIn, 10000)));
  const share = {week: cashShare(days('2026-10-18', 7, 4000)), before: cashShare(days('2026-10-11', 28, 6000))};
  assert.deepEqual(renderCashShare(share), ['Hotovost z tržeb za týden: 28 000 Kč = 2 % celkové tržby (4 týdny předtím 3 %)']);
  assert.deepEqual(renderCashShare({...share, before: cashShare(days('2026-10-11', 10, 6000))}), [], 'too few days before');
  assert.match(renderBriefing('Test', buildBriefing({businessDate: '2026-10-18', ...empty, cashShare: share})), /\nHotovost z tržeb za týden: 28 000 Kč/);
});
