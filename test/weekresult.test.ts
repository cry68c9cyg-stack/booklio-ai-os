import assert from 'node:assert/strict';
import {test} from 'node:test';
import {buildBriefing, renderBriefing} from '../src/briefing.ts';
import {renderWeekResult, weekResultFigures, type ResultPart} from '../src/weekresult.ts';
import {todoList} from '../src/todo.ts';
import type {TenantConfig} from '../src/validate.ts';

const config: TenantConfig = {
  name: 'Testovací podnik', timeZone: 'Europe/Prague', businessDayCutoffHour: 6, sendHours: [7, 8, 9],
  registers: ['bar', 'klub'], sections: {diner: 'Diner', bar: 'Bar', club: 'Klub'}, recipients: [], bottleCheck: null, reportsLink: null, dashboardPhones: null, web: null, location: null, disabledSources: [], foodCostLimitPermille: null,
};
const empty = {config, bills: [], closings: [], planHistory: [], incomplete: false};
/** A synthetic stretch (crowns): revenue and its days, invoices, purchases, of them food and drink, cash wages and cash spent. */
const part = (revenue: number, days: number, invoices: number, purchases: number, food: number, payouts: number, expenses: number): ResultPart => ({
  revenueCents: revenue * 100, revenueDays: days, invoices, purchasesCents: purchases * 100, foodDrinkCents: food * 100, payoutsCents: payouts * 100, expensesCents: expenses * 100});

const result = {from: '2026-10-12', to: '2026-10-18', week: part(1000000, 7, 12, 400000, 300000, 200000, 50000), before: part(4400000, 28, 40, 1600000, 1320000, 800000, 160000)};

test('the week: revenue − invoices − cash wages, against the average week of the 4 before', () => {
  assert.deepEqual(weekResultFigures(result), {resultCents: 40000000, beforeCents: 50000000, foodCostPermille: 300, beforeFoodCostPermille: 300});
  const early = weekResultFigures({...result, before: part(1100000, 7, 10, 400000, 330000, 200000, 0)});
  assert.equal(early.beforeCents, null, 'under 21 days of revenue before');
  assert.deepEqual(renderWeekResult(result), ['Výsledek týdne 12. 10.–18. 10. (tržba s DPH 1 000 000 Kč − nákup z faktur bez DPH − výplaty z kasy; bez nájmu, energií a mezd z účtu): 400 000 Kč (průměrný týden ze 4 předchozích 500 000 Kč) · ' +
    'nákup z faktur 400 000 Kč, z toho jídlo a nápoje 300 000 Kč = 30 % tržby (předtím 30 %) · výplaty z kasy 200 000 Kč · výdaje z kasy 50 000 Kč navíc neodečtené (část jsou zaplacené faktury)']);
  assert.deepEqual(renderWeekResult({...result, week: part(1000000, 4, 12, 400000, 300000, 200000, 0)}), [], 'under 5 days of revenue');
  assert.deepEqual(renderWeekResult({...result, week: part(1000000, 7, 0, 0, 0, 200000, 0)}), [], 'no invoices');
});

test('Monday line, and the to-do list when the week left a fifth less', () => {
  const briefing = buildBriefing({businessDate: '2026-10-18', ...empty});
  briefing.weekResult = result;
  assert.match(renderBriefing('Test', briefing), /\nVýsledek týdne 12\. 10\.–18\. 10\. /);
  assert.ok(!todoList(briefing).some(item => item.text.startsWith('Výsledek týdne')), '400 000 Kč against 500 000 Kč: not yet a fifth less');
  briefing.weekResult = {...result, week: part(1000000, 7, 12, 450000, 300000, 200000, 0)};
  const todo = todoList(briefing).find(item => item.text.startsWith('Výsledek týdne'));
  assert.equal(todo?.amountCents, 15000000, '150 000 Kč under the average week');
  briefing.weekResult = {...result, week: part(1100000, 7, 12, 400000, 300000, 200000, 0)};
  assert.ok(!todoList(briefing).some(item => item.text.startsWith('Výsledek týdne')), '500 000 Kč, as usual');
  const saturday = buildBriefing({businessDate: '2026-10-17', ...empty});
  saturday.weekResult = result;
  assert.doesNotMatch(renderBriefing('Test', saturday), /Výsledek týdne/, 'only on Monday');
});
