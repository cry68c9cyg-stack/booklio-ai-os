import assert from 'node:assert/strict';
import {test} from 'node:test';
import {buildBriefing, renderBriefing, renderMonth} from '../src/briefing.ts';
import type {DailyReport} from '../src/daily-report.ts';
import {promoDay, promoMonthText, promoStreaks, renderPromoWeek, sumPromo} from '../src/promo.ts';
import {addDays} from '../src/time.ts';
import {todoList} from '../src/todo.ts';
import type {TenantConfig} from '../src/validate.ts';

const config: TenantConfig = {
  name: 'Testovací podnik', timeZone: 'Europe/Prague', businessDayCutoffHour: 6, sendHours: [7, 8, 9],
  registers: ['bar', 'klub'], sections: {diner: 'Diner', bar: 'Bar', club: 'Klub'}, recipients: [], bottleCheck: null, reportsLink: null, dashboardPhones: null, web: null, location: null, disabledSources: [], foodCostLimitPermille: null,
};
const empty = {config, bills: [], closings: [], planHistory: [], incomplete: false};
/** A synthetic daily report: club 200 000 Kč, Texaco 50 000 Kč, Promo Club and Odpis Texaco as given (crowns). */
const report = (date: string, promoClub: number, odpisTexaco = 200): DailyReport => ({businessDate: date, source: 'admin', files: [], notes: null, warnings: [], lines: [
  {kind: 'revenue_section', key: 'club', label: 'CLUB Celkem', count: null, amountCents: 20000000},
  {kind: 'revenue_register', key: 'texaco', label: 'Texaco', count: null, amountCents: 5000000},
  {kind: 'discount', key: 'promo-club', label: 'Promo Club', count: 1, amountCents: promoClub * 100},
  {kind: 'discount', key: 'odpis-texaco', label: 'Odpis Texaco', count: 1, amountCents: odpisTexaco * 100},
  {kind: 'discount', key: 'personal', label: 'Personál', count: 3, amountCents: 50000},
  {kind: 'discount', key: 'cosmo-promo', label: 'Cosmo promo', count: 0, amountCents: 0},
]});

test('promo and write-offs by place, with the place revenue', () => {
  const day = promoDay(report('2026-10-17', 2400))!;
  assert.deepEqual(day.rows, [{kind: 'promo', place: 'Club', cents: 240000}, {kind: 'odpis', place: 'Texaco', cents: 20000}], 'staff meals are not promo');
  assert.deepEqual(day.revenue, {Club: 20000000, Texaco: 5000000});
  assert.equal(promoDay(null), null);
  const cosmo = report('2026-10-17', 0, 0);
  cosmo.lines.find(line => line.key === 'cosmo-promo')!.amountCents = 154700;
  assert.deepEqual(promoDay(cosmo)!.rows, [{kind: 'promo', place: 'Cosmo', cents: 154700}], 'the partner promo counts as promo, apart');
  const sum = sumPromo([day, null, promoDay(report('2026-10-16', 1600))]);
  assert.deepEqual([sum.days, sum.promoCents, sum.odpisCents, sum.revenueCents], [2, 400000, 40000, 50000000]);
  assert.equal(promoMonthText(sum), 'promo 4 000 Kč, odpisy 400 Kč (nejvíc Promo Club 4 000 Kč)');
  const part = {revenueCents: 50000000, revenueDays: 2, bySection: null};
  const month = {month: '2026-10', through: '2026-10-17', complete: false, current: part, previous: {...part, revenueDays: 0, revenueCents: 0, month: '2026-09', through: '2026-09-17'},
    payouts: [], payoutsCents: 0, expenses: [], expensesCents: 0, discounts: [], discountsCents: 0, promo: sum};
  assert.match(renderMonth(month)[0], / · promo 4 000 Kč, odpisy 400 Kč \(nejvíc Promo Club 4 000 Kč\)$/);
});

test('the week against the 4 weeks before, on Monday', () => {
  const days = (to: string, count: number, promoClub: number) => Array.from({length: count}, (_, i) => promoDay(report(addDays(to, -i), promoClub)));
  const promo = {week: sumPromo(days('2026-10-18', 7, 6000)), before: sumPromo(days('2026-10-11', 28, 3000))};
  assert.deepEqual(renderPromoWeek(promo), ['Promo a odpisy za týden: 43 400 Kč (2,5 % tržby, 4 týdny předtím 1,3 %) · Promo Club 42 000 Kč (3 % tržby, předtím 1,5 %), Odpis Texaco 1 400 Kč (0,4 % tržby, předtím 0,4 %)']);
  assert.deepEqual(renderPromoWeek({...promo, before: sumPromo(days('2026-10-11', 10, 3000))}), [], 'too few days before');
  const briefing = buildBriefing({businessDate: '2026-10-18', ...empty, promoWeek: promo});
  assert.match(renderBriefing('Test', briefing), /\nPromo a odpisy za týden: 43 400 Kč/);
});

test('a place over its usual 3 days in a row', () => {
  const days = Array.from({length: 31}, (_, i) => {
    const date = addDays('2026-09-17', i);
    return promoDay(report(date, date >= '2026-10-15' ? 5000 : 2000));
  });
  const streaks = promoStreaks(days, '2026-10-17');
  assert.deepEqual(streaks.map(streak => [streak.kind, streak.place, streak.days.map(day => day.date)]), [['promo', 'Club', ['2026-10-15', '2026-10-16', '2026-10-17']]]);
  assert.deepEqual(promoStreaks(days.slice(0, 30), '2026-10-16'), [], 'two days only');
  assert.deepEqual(promoStreaks(days.map(day => day?.date === '2026-10-16' ? null : day), '2026-10-17'), [], 'a day without a report breaks the streak');
  const briefing = buildBriefing({businessDate: '2026-10-17', ...empty, promoStreaks: streaks});
  assert.match(renderBriefing('Test', briefing), /\n⚠ Promo Club 3 dny po sobě nad obvyklým: 15\. 10\. 5 000 Kč \(čt obvykle 2 000 Kč\), 16\. 10\. 5 000 Kč \(pá obvykle 2 000 Kč\), 17\. 10\. 5 000 Kč \(so obvykle 2 000 Kč\)/);
  assert.ok(todoList(briefing).some(item => item.level === 'warn' && item.text.startsWith('Promo Club 3 dny po sobě') && item.amountCents === 900000));
});
