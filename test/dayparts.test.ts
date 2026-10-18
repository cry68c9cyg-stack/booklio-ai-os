import assert from 'node:assert/strict';
import {test} from 'node:test';
import {buildBriefing, renderBriefing} from '../src/briefing.ts';
import {addPartDay, dayNightFigures, emptyParts, renderDayNight, type PartSums} from '../src/dayparts.ts';
import type {DailyReport} from '../src/daily-report.ts';
import type {TenantConfig} from '../src/validate.ts';

const config: TenantConfig = {
  name: 'Testovací podnik', timeZone: 'Europe/Prague', businessDayCutoffHour: 6, sendHours: [7, 8, 9],
  registers: ['bar', 'klub'], sections: {diner: 'Diner', bar: 'Bar', club: 'Klub'}, recipients: [], bottleCheck: null, reportsLink: null, dashboardPhones: null, web: null, location: null, disabledSources: [], foodCostLimitPermille: null,
};
const empty = {config, bills: [], closings: [], planHistory: [], incomplete: false};
const report = (date: string, lines: DailyReport['lines']): DailyReport => ({businessDate: date, source: 'admin', files: [], notes: null, warnings: [], lines});
const line = (kind: DailyReport['lines'][number]['kind'], key: string, label: string, crowns: number) => ({kind, key, label, count: null, amountCents: crowns * 100});

test('a day of the cash book: the day and the night without VAT, and whose wages they are', () => {
  const sums = addPartDay(emptyParts(), report('2026-10-17', [line('revenue_section', 'diner', 'Restaurace den', 112000), line('revenue_section', 'bar', 'Restaurace noc', 60500),
    line('revenue_section', 'club', 'Club celkem', 121000), line('payout', 'security', 'Security', 8000), line('payout', 'kuchyn', 'Kuchyň výplaty', 30000), line('payout', 'zkouska', 'Zkouška Noemi klub', 2000)]));
  assert.deepEqual(sums, {days: 1, dayCents: 11200000, dayNetCents: 10000000, nightCents: 18150000, nightNetCents: 15000000, barNetCents: 5000000, otherWagesCents: 3200000, nightStaffCents: 800000});
  assert.equal(addPartDay(sums, report('2026-10-18', [line('payout', 'security', 'Security', 8000)])), sums, 'no revenue, nothing added');
});

/** Crowns without VAT: the day, the night with the ground floor's part of it, the other wages and the night's staff. */
const parts = (days: number, day: number, night: number, bar: number, other: number, staff: number): PartSums =>
  ({days, dayCents: day * 112, dayNetCents: day * 100, nightCents: night * 121, nightNetCents: night * 100, barNetCents: bar * 100, otherWagesCents: other * 100, nightStaffCents: staff * 100});
// Other wages 200 000 Kč shared 500 000 : 500 000 = 100 000 Kč each; before 640 000 Kč shared 2 000 000 : 2 000 000.
const input = {from: '2026-10-12', to: '2026-10-18', week: parts(7, 500000, 1000000, 500000, 200000, 100000), before: parts(28, 2000000, 4000000, 2000000, 640000, 400000)};

test('Monday: what each part left after its wages, against the average week before', () => {
  const figures = dayNightFigures(input);
  assert.deepEqual([figures.day.leftCents, figures.day.beforeLeftCents, figures.day.sharePermille, figures.day.beforeSharePermille, figures.day.worse], [40000000, 42000000, 200, 160, true]);
  assert.deepEqual([figures.night.leftCents, figures.night.sharePermille, figures.night.worse], [80000000, 200, false]);
  assert.deepEqual(renderDayNight(input), ['Den proti noci 12. 10.–18. 10. (tržba bez DPH − výplaty z kasy; mzdy mimo noční personál podle tržby Restaurace den a noc; bez faktur): ⚠ den 500 000 Kč − výplaty 100 000 Kč = 400 000 Kč (průměrný týden 420 000 Kč), tj. 20 % tržby (předtím 16 %) · ' +
    'noc a Club 1 000 000 Kč − výplaty 200 000 Kč = 800 000 Kč (průměrný týden 820 000 Kč), tj. 20 % tržby (předtím 18 %)']);
  assert.equal(dayNightFigures({...input, before: parts(10, 700000, 1400000, 700000, 170000, 200000)}).day.beforeSharePermille, null, 'under 14 days before');
  assert.deepEqual(renderDayNight({...input, week: parts(4, 500000, 1000000, 500000, 200000, 100000)}), [], 'under 5 days');
  const briefing = buildBriefing({businessDate: '2026-10-18', ...empty});
  briefing.dayNight = input;
  assert.match(renderBriefing('Test', briefing), /\n⚠? ?Den proti noci 12\. 10\./);
  const saturday = buildBriefing({businessDate: '2026-10-17', ...empty});
  saturday.dayNight = input;
  assert.doesNotMatch(renderBriefing('Test', saturday), /Den proti noci/, 'only on Monday');
});
