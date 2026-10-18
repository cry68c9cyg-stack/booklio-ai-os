import assert from 'node:assert/strict';
import {test} from 'node:test';
import {buildBriefing, renderBriefing} from '../src/briefing.ts';
import {tableChecks} from '../src/checks.ts';
import {extractDailyReport, line, type DailyReport, type ReportLine} from '../src/daily-report.ts';
import {djOf, noteThemes, rankDjs, renderThemes, summarizeThemes} from '../src/themes.ts';
import {todoList} from '../src/todo.ts';
import type {TenantConfig} from '../src/validate.ts';
import {readXlsx} from '../src/xlsx.ts';
import {xlsx} from './xlsx-fixture.ts';

const config: TenantConfig = {
  name: 'Testovací podnik', timeZone: 'Europe/Prague', businessDayCutoffHour: 6, sendHours: [7, 8, 9],
  registers: ['diner', 'bar', 'klub'], sections: {diner: 'Diner', bar: 'Bar', club: 'Klub'}, recipients: [], bottleCheck: null, reportsLink: null, dashboardPhones: null, web: null, location: null, disabledSources: [], foodCostLimitPermille: null,
};
const report = (lines: ReportLine[], notes: string | null = null): DailyReport => ({businessDate: '2026-10-16', source: 'admin', files: [], lines, notes, warnings: []});
const entry = (kind: ReportLine['kind'], key: string, label: string, crowns: number, count: number | null = null): ReportLine => ({kind, key, label, count, amountCents: crowns * 100});

test('daily report: the bare "Promo" above the discounts is the promo total, not one more discount', async () => {
  // Synthetic numbers in the layout the managers use (promo and "Celkem bez Promo" above the SLEVY block).
  const sheets = await readXlsx(await xlsx({List1: [
    [null, 'Pá', '16.10.2026', 'suma'],
    [null, 'RESTAURACE DEN', 1000], [null, 'RESTAURACE NOC', 2000], [null, 'CLUB Celkem', 3000],
    [null, 'POKLADNA 1. (Servis)', 2500], [null, 'Texaco', 400],
    [null, 'HOTOVOST', 100], [null, 'KARTY', 5900], [null, 'CELKEM podle výjezdů', 6000],
    [null, 'Promo', 300], [null, 'Celkem bez Promo', 5700], [null, 'Storno:', 10], [null, 'DJ:', 'Tester'],
    [null, 'SLEVY'], [null, 'Promo Club', 1, 200], [null, 'Promo rest. Noc.', 1, 150], [null, 'Personál', 3, 90], [null, 'CELKEM', null, 450],
  ]}));
  const {lines, notes} = extractDailyReport(sheets);
  const day = report(lines, notes.join('\n'));
  assert.deepEqual([line(day, 'total', 'promo')?.amountCents, line(day, 'total', 'without-promo')?.amountCents, line(day, 'discount', 'promo')], [30000, 570000, null]);
  assert.deepEqual(tableChecks(day).map(check => check.text), [
    'Promo v denním reportu 300 Kč nesedí se součtem promo slev 350 Kč',
    'Slevy celkem 450 Kč nesedí se součtem řádků slev 440 Kč',
    'Club celkem 3 000 Kč nesedí se součtem pokladen a Texaca 2 900 Kč',
  ]);
  assert.equal(djOf(day.notes), 'Tester');
});

test('table checks: cash count, opening balance and a purchase written as income', () => {
  const today = report([
    entry('balance', 'register-start', 'Počáteční stav', 1000), entry('balance', 'register', 'Zůstatek', 1200),
    entry('cash_count', 'hotovost', 'Hotovost', -44), entry('cash_count', 'celkem', 'Celkem', 1339), entry('total', 'cash-difference', 'Rozdíl přepočtu a zůstatku', 139),
    entry('movement', 'vklad-do-jd', 'Vklad do JD', -700), entry('movement', 'olej', 'Olej', -12),
  ]);
  const yesterday = report([entry('balance', 'register', 'Zůstatek', 990)]);
  const checks = tableChecks(today, yesterday);
  assert.deepEqual(checks.map(check => [check.level, check.text]), [
    ['warn', 'Ve výčetce hotovosti je záporná částka: Hotovost −44 Kč'],
    ['info', 'Výčetka hotovosti se liší od zůstatku v deníku o +139 Kč'],
    ['warn', 'Počáteční stav deníku 1 000 Kč nesedí se včerejším zůstatkem 990 Kč'],
    ['info', 'V deníku je „Olej“ −12 Kč jako příjem do kasy; jestli to byl nákup, má být kladně'],
  ]);
  assert.deepEqual(tableChecks(report([entry('balance', 'register-start', 'Počáteční stav', 990)]), yesterday), [], 'matching days say nothing');
  const briefing = buildBriefing({businessDate: '2026-10-16', config, bills: [], closings: [], planHistory: [], incomplete: false, report: today, tableChecks: checks});
  const text = renderBriefing(config.name, briefing);
  assert.match(text, /\n⚠ Tabulky: Ve výčetce hotovosti je záporná částka: Hotovost −44 Kč\.\n⚠ Tabulky: Počáteční stav deníku/);
  assert.match(text, /\nTabulky: V deníku je „Olej“ −12 Kč jako příjem do kasy/);
  const todo = todoList(briefing);
  assert.ok(todo.some(item => item.level === 'warn' && item.text === 'Tabulky: Počáteční stav deníku 1 000 Kč nesedí se včerejším zůstatkem 990 Kč'));
  assert.ok(todo.some(item => item.level === 'info' && item.text.startsWith('Tabulky: Výčetka hotovosti se liší')));
});

test('report texts: topics, negations, the DJ line, summary over weeks and the DJ ranking', () => {
  const text = 'DJ: Tester\nZačátek směny byl pomalý, lidé přišli až kvůli akci po celé Praze. Po půlnoci bylo úplně plno.\n' +
    'Na baru omdlela hostka, dostala první pomoc a odvezla ji sanitka. Jinak bez problémů a konfliktů.\nTousty dnes nešly.\n' +
    'Na účtu už bylo jen 5K, zbytek výplat počká.';
  assert.deepEqual(noteThemes(text), ['health', 'cash', 'menu', 'slow', 'busy', 'city']);
  assert.deepEqual(noteThemes('DJ: Konflikt'), [], 'the DJ line is not the text');
  assert.deepEqual(noteThemes('Rvačka u vstupu, security zasáhla.'), ['security']);
  const summary = summarizeThemes('2026-09-21', '2026-10-18', [{date: '2026-10-10', themes: ['slow']}, {date: '2026-10-17', themes: ['slow', 'health']}, {date: '2026-10-18', themes: []}]);
  assert.deepEqual(summary.themes.map(theme => [theme.key, theme.days, theme.last]), [['slow', 2, '2026-10-17'], ['health', 1, '2026-10-17']]);
  assert.deepEqual(renderThemes(summary), ['Report dne za 4 týdny (3 dny s textem): slabý provoz 2×, zdravotní incident 1×',
    'Co řešit: slabý provoz – na slabé dny chystat akci nebo kampaň (OKO1 je hlásí dopředu) · zdravotní incident – zapsat, co se stalo a kdo pomáhal, a zkontrolovat lékárničku']);
  const ranking = rankDjs([
    {date: '2026-10-03', dj: 'A', clubCents: 12000000, usualCents: 10000000}, {date: '2026-10-10', dj: 'A', clubCents: 11000000, usualCents: 10000000},
    {date: '2026-10-09', dj: 'B', clubCents: 9000000, usualCents: 10000000}, {date: '2026-10-16', dj: 'B', clubCents: 9500000, usualCents: 10000000},
    {date: '2026-10-17', dj: 'C', clubCents: 30000000, usualCents: 10000000},
  ]);
  assert.deepEqual(ranking.map(row => [row.dj, row.nights, row.averageCents, row.changePermille]), [['A', 2, 11500000, 150], ['B', 2, 9250000, -75]], 'a DJ with one night is left out');
  const briefing = buildBriefing({businessDate: '2026-10-18', config, bills: [], closings: [], planHistory: [], incomplete: false, themes: summary, djRanking: ranking, noteThemes: ['health', 'slow']});
  const message = renderBriefing(config.name, briefing);
  assert.match(message, /\nReport dne za 4 týdny \(3 dny s textem\): slabý provoz 2×/);
  assert.match(message, /\nDJ za 12 týdnů \(tržba klubu\): A 2 noci, průměr 115 000 Kč, \+15 % proti obvyklému dni · B 2 noci, průměr 92 500 Kč, −8 % proti obvyklému dni/);
  assert.deepEqual(todoList(briefing).map(item => item.text), ['Report dne: zdravotní incident – zapsat, co se stalo a kdo pomáhal, a zkontrolovat lékárničku']);
});
