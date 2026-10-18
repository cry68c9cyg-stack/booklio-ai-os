import assert from 'node:assert/strict';
import {test} from 'node:test';
import {foreignWeek, incidents, isMonthEnd, renderForeignWeek, renderIncidents, staffMealsText, type ForeignCash} from '../src/incidents.ts';
import {renderMonth} from '../src/briefing.ts';

test('incident log: health and security sentences of the text, with the place, not the ones said not to have happened', () => {
  const text = 'DJ: Tester\nPomalý začátek, po půlnoci plno. Na Texacu paní omdlela, první pomoc a sanitka. Bez konfliktů. U vchodu security vyvedli dva agresivní hosty!';
  assert.deepEqual(incidents('2026-10-17', text), [
    {date: '2026-10-17', kind: 'health', name: 'zdravotní', place: 'Texaco', text: 'Na Texacu paní omdlela, první pomoc a sanitka.'},
    {date: '2026-10-17', kind: 'security', name: 'bezpečnost', place: 'Vstup', text: 'U vchodu security vyvedli dva agresivní hosty!'},
  ]);
  assert.deepEqual(incidents('2026-10-17', 'Klidný večer, žádný konflikt ani zranění.'), []);
  assert.deepEqual(incidents('2026-10-17', null), []);
  const month = [...incidents('2026-10-03', 'V klubu rvačka, přijela policie.'), ...incidents('2026-10-17', text), ...incidents('2026-10-20', 'Na Texacu se host zranil o sklo.')];
  assert.deepEqual(renderIncidents('2026-10', month), ['Incidenty v říjnu: 4 (zdravotní 2, bezpečnost 2), nejčastěji Texaco']);
  assert.deepEqual(renderIncidents('2026-10', []), []);
  assert.deepEqual([isMonthEnd('2026-10-31'), isMonthEnd('2026-10-30'), isMonthEnd('2028-02-29')], [true, false, true]);
});

test('staff meals in the month line: bills, amount and share of the revenue', () => {
  assert.equal(staffMealsText({bills: 420, cents: 12000000, revenueCents: 1000000000}), 'jídla personálu 420 účtů, 120 000 Kč (1,2 % tržby)');
  const part = {revenueCents: 1000000000, revenueDays: 11, bySection: null};
  const month = {month: '2026-10', through: '2026-10-11', complete: false, current: part, previous: {...part, revenueDays: 0, revenueCents: 0, month: '2026-09', through: '2026-09-11'},
    payouts: [], payoutsCents: 0, expenses: [], expensesCents: 0, discounts: [], discountsCents: 0, staffMeals: {bills: 420, cents: 12000000, revenueCents: 1000000000}};
  assert.deepEqual(renderMonth(month), ['Říjen do 11. 10.: tržba 10 000 000 Kč · jídla personálu 420 účtů, 120 000 Kč (1,2 % tržby)']);
});

test('foreign cash: rises of euros, dollars and pounds from one evening count to the next over 7 days against the 7 before', () => {
  const day = (n: number, euro: number, dolar = 1000000): ForeignCash => ({date: `2026-10-${String(n).padStart(2, '0')}`, byCurrency: {euro, dolar, libra: 360000}});
  // 4. 10. to 18. 10.: euros rise by 1 000 Kč a day in the first week and 2 000 Kč in the second; one exchange (a fall) in between; dollars rise once.
  const days = [day(4, 5000000), day(5, 5100000), day(6, 5200000), day(7, 5300000), day(8, 5400000), day(9, 5500000), day(10, 5600000), day(11, 5700000),
    day(12, 5900000), day(13, 6100000), null, day(15, 3000000), day(16, 3200000), day(17, 3400000), day(18, 3600000, 1240000)];
  const week = foreignWeek('2026-10-18', days)!;
  assert.deepEqual([week.from, week.cents, week.previousCents], ['2026-10-12', 1240000, 700000], 'euros 2 000 × 5 (no pair over the gap, the fall is not counted) + dollars 2 400; before 7 × 1 000');
  assert.deepEqual(renderForeignWeek(week), ['Cizí měny v kase za týden: přibylo 12 400 Kč (eura 10 000 Kč, dolary 2 400 Kč), týden předtím 7 000 Kč (+77 %)']);
  assert.equal(foreignWeek('2026-10-18', days.map((entry, i) => i > 9 ? null : entry)), null, 'fewer than 4 pairs in the week');
});
