import assert from 'node:assert/strict';
import {test} from 'node:test';
import {buildBriefing, renderBriefing} from '../src/briefing.ts';
import type {DailyReport} from '../src/daily-report.ts';
import {renderRiskWeek, riskScore} from '../src/risk.ts';
import {todoList} from '../src/todo.ts';
import type {TenantConfig} from '../src/validate.ts';

const config: TenantConfig = {
  name: 'Testovací podnik', timeZone: 'Europe/Prague', businessDayCutoffHour: 6, sendHours: [7, 8, 9],
  registers: ['bar', 'klub'], sections: {diner: 'Diner', bar: 'Bar', club: 'Klub'}, recipients: [], bottleCheck: null, reportsLink: null, dashboardPhones: null, web: null, location: null, disabledSources: [], foodCostLimitPermille: null,
};
const empty = {config, bills: [], closings: [], planHistory: [], incomplete: false};
/** A synthetic cash book day with a cash count against the journal (crowns). */
const report = (date: string, difference: number): DailyReport => ({businessDate: date, source: 'admin', files: [], notes: null, warnings: [], lines: [
  {kind: 'revenue_section', key: 'club', label: 'CLUB Celkem', count: null, amountCents: 20000000},
  {kind: 'total', key: 'cash-difference', label: 'Rozdíl přepočtu a zůstatku', count: null, amountCents: difference * 100},
]});

test('a quiet day scores nothing and says nothing', () => {
  const briefing = buildBriefing({businessDate: '2026-10-17', ...empty, report: report('2026-10-17', 20)});
  assert.deepEqual(riskScore(briefing), {date: '2026-10-17', score: 0, reasons: []});
  assert.doesNotMatch(renderBriefing('Test', briefing), /Riziko mank/);
});

test('signals add up to a score with what to check, a warning from 50', () => {
  const voidAndDiff = {date: '2026-10-17', voidCents: 400000, usualCents: 150000, cashDiffCents: -60000};
  const cashDiffRepeat = [{date: '2026-10-12', cents: -12000}, {date: '2026-10-14', cents: 15000}, {date: '2026-10-17', cents: -60000}];
  const briefing = buildBriefing({businessDate: '2026-10-17', ...empty, report: report('2026-10-17', -600), voidAndDiff, cashDiffRepeat});
  const risk = riskScore(briefing);
  assert.deepEqual([risk.score, risk.reasons.map(reason => reason.points)], [65, [30, 20, 15]]);
  const text = renderBriefing('Test', briefing);
  assert.match(text, /\n⚠ Riziko mank: 65 ze 100 · storna 4 000 Kč nad obvyklým a zároveň rozdíl v kase −600 Kč \(30\): projít storna toho dne · rozdíl v kase 3× za 7 dní \(20\): kdo měl kasu ve dnech s rozdílem · přepočet kasy proti deníku −600 Kč \(15\): přepočítat kasu a doklady toho dne(\n|$)/);
  assert.ok(todoList(briefing).some(item => item.level === 'warn' && item.text.startsWith('Riziko mank: 65 ze 100')));
  const lower = buildBriefing({businessDate: '2026-10-17', ...empty, report: report('2026-10-17', 2500)});
  assert.equal(riskScore(lower).score, 25, 'from 2 000 Kč the difference weighs more');
  assert.match(renderBriefing('Test', lower), /\nRiziko mank: 25 ze 100 · přepočet kasy proti deníku \+2 500 Kč/);
  assert.ok(!todoList(lower).some(item => item.text.startsWith('Riziko mank')), 'under 50 only in the message');
  const small = buildBriefing({businessDate: '2026-10-17', ...empty, report: report('2026-10-17', 600)});
  assert.equal(riskScore(small).score, 15);
  assert.doesNotMatch(renderBriefing('Test', small), /Riziko mank/, 'under 20 not every morning');
});

test('the week on Monday, the riskiest days first', () => {
  const day = (date: string, score: number) => ({date, score, reasons: score ? [{points: score, text: `signál ${score}`, check: 'projít'}] : []});
  const week = [day('2026-10-12', 0), day('2026-10-13', 15), day('2026-10-14', 0), day('2026-10-15', 0), day('2026-10-16', 30), day('2026-10-17', 65), day('2026-10-18', 0)];
  assert.deepEqual(renderRiskWeek(week), ['Riziko mank za týden: so 17. 10. 65 (signál 65), pá 16. 10. 30 (signál 30), út 13. 10. 15 (signál 15); ostatní dny 0']);
  assert.deepEqual(renderRiskWeek(week.map(entry => day(entry.date, 0))), ['Riziko mank za týden: všech 7 dní 0 ze 100']);
  assert.match(renderBriefing('Test', buildBriefing({businessDate: '2026-10-18', ...empty, riskWeek: week})), /\nRiziko mank za týden: so 17\. 10\. 65/);
  assert.doesNotMatch(renderBriefing('Test', buildBriefing({businessDate: '2026-10-17', ...empty, riskWeek: week})), /Riziko mank za týden/, 'only on Monday');
});
