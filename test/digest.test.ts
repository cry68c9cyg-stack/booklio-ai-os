import assert from 'node:assert/strict';
import {test} from 'node:test';
import {buildBriefing} from '../src/briefing.ts';
import {DIGEST_CHARS, renderDigest, weekMoneyLine} from '../src/digest.ts';
import {smsText} from '../src/delivery.ts';
import type {TenantConfig} from '../src/validate.ts';

const config: TenantConfig = {
  name: 'Testovací podnik', timeZone: 'Europe/Prague', businessDayCutoffHour: 6, sendHours: [7, 8, 9],
  registers: ['bar', 'klub'], sections: {diner: 'Diner', bar: 'Bar', club: 'Klub'}, recipients: [], bottleCheck: null, reportsLink: null, dashboardPhones: null, web: null, location: null, disabledSources: [], foodCostLimitPermille: null,
};
const empty = {config, bills: [], closings: [], planHistory: [], incomplete: false};
const link = 'https://oko1.example/d/test';
const part = (revenue: number, days: number, purchases: number, payouts: number) => ({revenueCents: revenue * 121, revenueNetCents: revenue * 100, revenueDays: days, invoices: 5,
  purchasesCents: purchases * 100, foodDrinkCents: purchases * 100, payoutsCents: payouts * 100, expensesCents: 0});

test('a long message goes out as a digest under the SMS limit, with the link', () => {
  const warnings = Array.from({length: 12}, (_, i) => `⚠ Upozornění číslo ${i + 1}: ${'něco se stalo a je potřeba to projít '.repeat(3)}`);
  const text = ['Test · ne 18. 10. 2026', 'Tržba: 250 000 Kč (plán 240 000 Kč, +4 %)', 'Rezervace: 40', ...warnings, 'Lístek: beze změn'].join('\n');
  const briefing = buildBriefing({businessDate: '2026-10-17', ...empty});
  const digest = renderDigest(text, briefing, link);
  const lines = digest.split('\n');
  assert.equal(lines[0], 'Test · ne 18. 10. 2026');
  assert.equal(lines[1], 'Tržba: 250 000 Kč (plán 240 000 Kč, +4 %)');
  assert.ok(lines[2].startsWith('⚠ Upozornění číslo 1: '), 'the first warning first');
  assert.match(digest, /\n\+ \d+ dalších upozornění\nCelá zpráva a K vyřízení: https:\/\/oko1\.example\/d\/test$/);
  assert.ok(digest.length <= DIGEST_CHARS && !smsText(digest).endsWith('...'), 'fits an SMS uncut');
  const short = ['Test · ne 18. 10. 2026', 'Tržba: 250 000 Kč', 'Rezervace: 40'].join('\n');
  assert.equal(renderDigest(short, briefing, link), short, 'a message that fits goes out whole');
  const quiet = renderDigest(['Test · ne 18. 10. 2026', 'Tržba: 250 000 Kč', ...Array.from({length: 12}, () => 'Rezervace: ' + 'x'.repeat(60))].join('\n'), briefing, null);
  assert.equal(quiet, 'Test · ne 18. 10. 2026\nTržba: 250 000 Kč\nBez upozornění.');
});

test('Monday: the week\'s money in one line', () => {
  const monday = buildBriefing({businessDate: '2026-10-18', ...empty});
  assert.equal(weekMoneyLine(monday), null, 'nothing to say yet');
  monday.weekResult = {from: '2026-10-12', to: '2026-10-18', week: part(1000000, 7, 400000, 200000), before: part(4400000, 28, 1600000, 800000)};
  monday.purchaseShares = {from: '2026-10-12', to: '2026-10-18', week: {food: new Map([['Maso', 12000000]]), beverage: new Map([['Pivovar', 15000000]])}, before: {food: new Map(), beverage: new Map()},
    weekRevenueNetCents: 100000000, weekRevenueDays: 7, beforeRevenueNetCents: 400000000, beforeRevenueDays: 28};
  assert.equal(weekMoneyLine(monday), 'Týden: výsledek 400 000 Kč (obvykle 500 000 Kč) · jídlo 12 %, nápoje 15 % tržby');
  assert.equal(renderDigest('Test · po\nTržba: 1 Kč\n' + 'x'.repeat(700), monday, null).split('\n')[2], 'Týden: výsledek 400 000 Kč (obvykle 500 000 Kč) · jídlo 12 %, nápoje 15 % tržby');
  assert.equal(weekMoneyLine(buildBriefing({businessDate: '2026-10-17', ...empty})), null, 'only on Monday');
});

test('Priorita podle peněz: warnings by money at stake, the first three with who handles them, as in K vyřízení', () => {
  const text = ['Test · ne 18. 10. 2026', 'Tržba: 250 000 Kč', ...Array.from({length: 12}, (_, i) => `⚠ Řádek zprávy ${i} ${'x'.repeat(60)}`)].join('\n');
  const briefing = buildBriefing({businessDate: '2026-10-17', ...empty});
  const todos = [
    {level: 'warn' as const, text: 'Report za den chybí.', amountCents: null, owner: 'Matěj'},
    {level: 'warn' as const, text: 'Faktura po splatnosti: Maso 40 000 Kč', amountCents: 4000000, owner: 'Nancy'},
    {level: 'warn' as const, text: 'Rozdíl v hotovosti bar: −2 000 Kč', amountCents: -200000, owner: 'Matěj'},
    {level: 'warn' as const, text: 'Odpovědět na e-mail: Novák', amountCents: null, owner: 'Matěj'},
    {level: 'info' as const, text: 'Zaplatit: Pivovar 90 000 Kč', amountCents: 9000000, owner: 'Nancy'},
  ];
  const lines = renderDigest(text, briefing, link, todos).split('\n');
  assert.deepEqual(lines.slice(2, 6), ['1. Report za den chybí. – Matěj', '2. Faktura po splatnosti: Maso 40 000 Kč – Nancy', '3. Rozdíl v hotovosti bar: −2 000 Kč – Matěj', '⚠ Odpovědět na e-mail: Novák']);
  assert.ok(!lines.some(line => line.includes('Řádek zprávy') || line.includes('Pivovar')), 'only the warnings of K vyřízení, not the message lines or info items');
});
