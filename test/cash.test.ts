import assert from 'node:assert/strict';
import {test} from 'node:test';
import {buildBriefing, renderBriefing} from '../src/briefing.ts';
import {cashDay, cashNeed, nightSummary, payoutAlarm, renderNights, type CashDay, type Night} from '../src/cash.ts';
import {extractCashBook, type DailyReport, type ReportLine} from '../src/daily-report.ts';
import {todoList} from '../src/todo.ts';
import type {TenantConfig} from '../src/validate.ts';
import {readXlsx} from '../src/xlsx.ts';
import {journalSheets, xlsx} from './xlsx-fixture.ts';

const config: TenantConfig = {
  name: 'Testovací podnik', timeZone: 'Europe/Prague', businessDayCutoffHour: 6, sendHours: [7, 8, 9],
  registers: ['bar', 'klub'], sections: {diner: 'Diner', bar: 'Bar', club: 'Klub'}, recipients: [], bottleCheck: null, reportsLink: null, dashboardPhones: null, web: null, location: null, disabledSources: [], foodCostLimitPermille: null,
};
const empty = {config, bills: [], closings: [], planHistory: [], incomplete: false};
const report = (date: string, lines: ReportLine[]): DailyReport => ({businessDate: date, source: 'admin', files: [], lines, notes: null, warnings: []});
const day = (date: string, payouts: number, expenses: number, cash: number | null = null): CashDay => ({date, payoutsCents: payouts * 100, staffCents: payouts * 100, expensesCents: expenses * 100, cashCents: cash === null ? null : cash * 100});

test('cash book day: payouts, the night staff among them, expenses, and the loose cash with the safe from the evening count', async () => {
  const lines = extractCashBook(await readXlsx(await xlsx(journalSheets())), '2026-10-09')!;
  assert.deepEqual(cashDay(report('2026-10-09', lines)), {date: '2026-10-09', payoutsCents: 1070000, staffCents: 1000000, expensesCents: 350000, cashCents: 13000000},
    'Security + DJ are the night staff, the try-out barman is a payout too; euros are not counted, the safe is');
  assert.equal(cashDay(null), null);
  assert.equal(cashDay(report('2026-10-09', [])), null);
  const hostess = (label: string) => ({kind: 'payout' as const, key: 'x', label, count: null, amountCents: 100000});
  assert.equal(cashDay(report('2026-10-09', [hostess('Hosteska den+noc'), hostess('animátorky'), hostess('Aleš výplata')]))!.staffCents, 200000);
});

test('cash for today: the counted cash against the usual payouts and expenses of the weekday', () => {
  const past = [day('2026-10-10', 40000, 5000), day('2026-10-03', 50000, 7000), day('2026-09-26', 30000, 2000), null];
  const need = cashNeed('2026-10-17', day('2026-10-16', 0, 0, 40000), past)!;
  assert.deepEqual([need.usualOutCents, need.shortCents, need.days], [4500000, 500000, 3], 'median of 45 000, 57 000 and 32 000');
  assert.equal(cashNeed('2026-10-17', day('2026-10-16', 0, 0, 40000), past.slice(0, 1)), null, 'one past day is not usual');
  assert.equal(cashNeed('2026-10-17', day('2026-10-16', 0, 0, 44500), past), null, 'under 1 000 Kč short is rounding of the guess');
  assert.equal(cashNeed('2026-10-17', day('2026-10-16', 0, 0, null), past), null, 'no evening count');
  const short = cashNeed('2026-10-17', day('2026-10-16', 0, 0, 20000), past)!;
  const briefing = buildBriefing({businessDate: '2026-10-16', ...empty, cashNeed: short});
  assert.match(renderBriefing('Test', briefing), /\n⚠ Hotovost na dnešek: v kase a trezoru 20 000 Kč, v sobotu obvykle odejde na výplaty a výdaje 45 000 Kč, chybí asi 25 000 Kč; doplň hotovost nebo rozlož výplaty\.(\n|$)/);
  assert.ok(todoList(briefing).some(item => item.level === 'warn' && item.text.startsWith('Hotovost na dnešek nestačí: v kase a trezoru 20 000 Kč')));
});

test('payouts over the usual: 1,5× the usual share of the revenue and 5 000 Kč over the usual amount', () => {
  const past = [{payoutsCents: 3000000, revenueCents: 40000000}, {payoutsCents: 2800000, revenueCents: 40000000}, {payoutsCents: 3200000, revenueCents: 45000000}];
  const alarm = payoutAlarm({date: '2026-10-17', payoutsCents: 6000000, revenueCents: 45000000}, past)!;
  assert.deepEqual([alarm.sharePermille, alarm.usualSharePermille, alarm.usualCents], [133, 71, 3000000]);
  assert.equal(payoutAlarm({date: '2026-10-17', payoutsCents: 3400000, revenueCents: 30000000}, past), null, 'share up, but only 4 000 Kč over the usual');
  assert.equal(payoutAlarm({date: '2026-10-17', payoutsCents: 6000000, revenueCents: 90000000}, past), null, 'a strong night pays more, the share stays');
  assert.equal(payoutAlarm({date: '2026-10-17', payoutsCents: 6000000, revenueCents: 45000000}, past.slice(0, 1)), null);
  const briefing = buildBriefing({businessDate: '2026-10-17', ...empty, payoutAlarm: alarm});
  assert.match(renderBriefing('Test', briefing), /\n⚠ Výplaty v hotovosti: 60 000 Kč, 13,3 % tržby \(v sobotu obvykle 7,1 %, 30 000 Kč\)(\n|$)/);
  assert.ok(todoList(briefing).some(item => item.text === 'Výplaty v hotovosti nad obvyklým: 60 000 Kč, 13,3 % tržby (v sobotu obvykle 7,1 %, 30 000 Kč)'));
});

test('nights: the club revenue minus the night staff, averages by weekday and DJ from 2 nights', () => {
  const night = (date: string, dj: string | null, club: number | null, staff: number): Night => ({date, dj, clubCents: club === null ? null : club * 100, revenueCents: null,
    staffCents: staff * 100, payoutsCents: staff * 100, expensesCents: 0, resultCents: club === null ? null : (club - staff) * 100});
  const summary = nightSummary('2026-09-21', '2026-10-18', [night('2026-10-02', 'Alfa', 100000, 20000), night('2026-10-09', 'Beta', 80000, 20000),
    night('2026-10-16', 'Alfa', 120000, 20000), night('2026-10-08', 'Beta', 30000, 10000), night('2026-10-15', 'Gama', 40000, 10000), night('2026-10-14', null, null, 5000)]);
  assert.deepEqual(summary.byWeekday.map(row => [row.weekday, row.nights, row.resultCents]), [[5, 3, 8000000], [4, 2, 2500000]], 'Friday 80 000 on average, Thursday 25 000; Wednesday has no club revenue');
  assert.deepEqual(summary.byDj.map(row => [row.dj, row.nights, row.resultCents]), [['Alfa', 2, 9000000], ['Beta', 2, 4000000]], 'Gama has one night');
  assert.deepEqual(renderNights(summary), ['Výsledek noci za 4 týdny (tržba klubu − výplaty noci, průměr): nejlepší pá 80 000 Kč, nejslabší čt 25 000 Kč · DJ: Alfa 90 000 Kč (2 noci), Beta 40 000 Kč (2 noci)']);
  assert.deepEqual(renderNights(nightSummary('2026-09-21', '2026-10-18', [])), []);
});
