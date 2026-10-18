import assert from 'node:assert/strict';
import {test} from 'node:test';
import {buildBriefing, renderBriefing} from '../src/briefing.ts';
import {kpiRows, renderKpi, type KpiPart} from '../src/kpi.ts';
import {todoList} from '../src/todo.ts';
import type {TenantConfig} from '../src/validate.ts';

const config: TenantConfig = {
  name: 'Testovací podnik', timeZone: 'Europe/Prague', businessDayCutoffHour: 6, sendHours: [7, 8, 9],
  registers: ['bar', 'klub'], sections: {diner: 'Diner', bar: 'Bar', club: 'Klub'}, recipients: [], bottleCheck: null, reportsLink: null, dashboardPhones: null, web: null, location: null, disabledSources: [], foodCostLimitPermille: null,
};
const empty = {config, bills: [], closings: [], planHistory: [], incomplete: false};
/** A synthetic stretch (crowns): revenue, voids, promo, the cash differences, payouts, guests and no-shows. */
const part = (days: number, revenue: number, voids: number, promo: number, diff: number, payouts: number, guests: number, noShows: number, reportDays = days, mail: number | null = null): KpiPart => ({
  days, revenueCents: revenue * 100, reportDays, voidCents: voids * 100, reportRevenueCents: revenue * 100, promoCents: promo * 100, promoRevenueCents: revenue * 100,
  cashDiffAbsCents: diff * 100, payoutsCents: payouts * 100, payoutRevenueCents: revenue * 100, guests, noShowGuests: noShows, mailWithin24Permille: mail});

const input = {from: '2026-10-12', to: '2026-10-18', week: part(7, 1500000, 7500, 30000, 2400, 150000, 400, 40, 6, 700), before: part(28, 6800000, 20400, 120000, 2000, 600000, 1600, 80, 20),
  overdue: {count: 2, grossCents: 4500000}};

test('the KPIs of the week against the average week of the 4 before, with owners', () => {
  const rows = kpiRows(input);
  assert.deepEqual(rows.map(row => [row.key, row.now, row.before, row.worse, row.owner]), [
    ['revenue', '1 500 000 Kč', '1 700 000 Kč', true, 'Matěj'],
    ['voids', '0,5 %', '0,3 %', true, 'Matěj'],
    ['promo', '2 %', '1,8 %', false, 'Matěj'],
    ['payouts', '10 %', '8,8 %', false, 'Matěj'],
    ['noShows', '10 %', '5 %', true, 'Matěj'],
    ['cashDiff', '2 400 Kč', '500 Kč', true, 'Matěj'],
    ['reports', '6/7', null, true, 'Matěj'],
    ['mail', '70 %', null, true, 'Matěj'],
    ['overdue', '2× 45 000 Kč', null, true, 'Nancy'],
  ]);
  assert.ok(!rows.some(row => row.owner === 'Klára'), 'the assistant owns no KPI');
  const early = kpiRows({...input, before: part(28, 6800000, 20400, 0, 2000, 600000, 1600, 80, 2)});
  assert.deepEqual(early.filter(row => row.key === 'voids' || row.key === 'promo').map(row => [row.before, row.worse]), [[null, false], [null, false]], 'under 14 days of daily reports before');
});

test('Monday: the values in one line and what got worse with who and what to do', () => {
  const [values, worse] = renderKpi(input);
  assert.match(values, /^KPI týdne \(v závorce průměrný týden ze 4 předchozích\): tržba 1 500 000 Kč \(1 700 000 Kč\) · storna z tržby 0,5 % \(0,3 %\) · /);
  assert.match(worse, /^⚠ KPI horší: Tržba 1 500 000 Kč – Matěj: projít slabé dny, akce a obsazení · Storna z tržby 0,5 % – Matěj: /);
  assert.match(worse, / · Faktury po splatnosti 2× 45 000 Kč – Nancy: zaplatit, nebo s dodavatelem domluvit odklad$/);
  const briefing = buildBriefing({businessDate: '2026-10-18', ...empty});
  briefing.kpi = input;
  assert.match(renderBriefing('Test', briefing), /\nKPI týdne \(v závorce/);
  assert.ok(todoList(briefing).some(item => item.text === 'KPI horší: Storna z tržby 0,5 % (předtím 0,3 %) – projít storna po dnech a kdo je dělal' && item.owner === 'Matěj'));
  const good = {...input, week: part(7, 1700000, 5000, 30000, 300, 150000, 400, 20, 7, 900), overdue: {count: 0, grossCents: 0}};
  assert.equal(renderKpi(good).length, 1, 'nothing got worse');
  const saturday = buildBriefing({businessDate: '2026-10-17', ...empty});
  saturday.kpi = input;
  assert.doesNotMatch(renderBriefing('Test', saturday), /KPI týdne/, 'only on Monday');
});
