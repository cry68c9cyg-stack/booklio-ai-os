/**
 * Batch „Mzdy a výkon směn“ (MC „jo“ 18. 10. 2026). What OKO1 has of wages today is the cash book: the night's staff paid
 * in cash, wages paid out of the till beyond the night (kitchen, barman, cleaner, help), and trial shifts. The whole
 * payroll and the hours worked come with the attendance of Pexeso; until then this is the cash part only.
 * Also the weekdays on which the managers' texts keep saying that staff was missing.
 */
import {weekday} from './time.ts';
import {NIGHT_STAFF, type Night} from './cash.ts';
import type {DailyReport} from './daily-report.ts';

const kc = (cents: number) => (cents < 0 ? '−' : '') + String(Math.round(Math.abs(cents) / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ') + ' Kč';
const plain = (value: string) => value.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
const median = (values: number[]) => { const sorted = [...values].sort((a, b) => a - b), middle = Math.floor(sorted.length / 2); return sorted.length % 2 ? sorted[middle] : Math.round((sorted[middle - 1] + sorted[middle]) / 2); };
const percent = (permille: number) => `${String(Math.round(permille) / 10).replace('.', ',')} %`;
const shortDate = (date: string) => `${Number(date.slice(8))}. ${Number(date.slice(5, 7))}.`;
const WEEKDAYS_SHORT = ['ne', 'po', 'út', 'st', 'čt', 'pá', 'so'];

/** A cash payout of the cash book: the night's staff, a trial shift ("Zkouška Noemi klub"), or other wages paid from the till. */
export type PayoutKind = 'night' | 'trial' | 'wage';
export function payoutKind(label: string): PayoutKind {
  const text = plain(label);
  return NIGHT_STAFF.test(text) ? 'night' : /^zkousk/.test(text) ? 'trial' : 'wage';
}

export type WageDay = {date: string; nightCents: number; trialCents: number; wageCents: number;
  trials: {label: string; amountCents: number}[]; wages: {label: string; amountCents: number}[]};
/** The day's cash payouts split by kind. `null` = no payouts. */
export function wageDay(report: DailyReport | null): WageDay | null {
  const payouts = report?.lines.filter(entry => entry.kind === 'payout' && entry.amountCents > 0) ?? [];
  if (!report || !payouts.length) return null;
  const pick = (kind: PayoutKind) => payouts.filter(entry => payoutKind(entry.label) === kind).map(entry => ({label: entry.label.slice(0, 60), amountCents: entry.amountCents}));
  const sum = (rows: {amountCents: number}[]) => rows.reduce((total, row) => total + row.amountCents, 0);
  const trials = pick('trial'), wages = pick('wage');
  return {date: report.businessDate, nightCents: sum(pick('night')), trialCents: sum(trials), wageCents: sum(wages), trials, wages};
}

/** "Mzdy z kasy mimo noc: Kuchyň výplaty 110 000 Kč · zkušební směny 2× 2 000 Kč (Zkouška Noemi klub, …)" */
export function renderWageDay(day: WageDay | null | undefined): string[] {
  if (!day || (!day.wageCents && !day.trialCents)) return [];
  const parts: string[] = [];
  if (day.wageCents) parts.push(`mzdy mimo noc ${kc(day.wageCents)} (${day.wages.slice(0, 3).map(row => `${row.label} ${kc(row.amountCents)}`).join(', ')}${day.wages.length > 3 ? ', …' : ''})`);
  if (day.trialCents) parts.push(`zkušební směny ${day.trials.length}× ${kc(day.trialCents)}`);
  return [`Z kasy: ${parts.join(' · ')}`];
}

/** Payouts of a stretch of days by kind (month line, dashboard). */
export type WageSum = {nightCents: number; trialCents: number; trials: number; wageCents: number};
export function sumWages(days: (WageDay | null)[]): WageSum {
  const list = days.filter((day): day is WageDay => day !== null);
  return {nightCents: list.reduce((sum, day) => sum + day.nightCents, 0), trialCents: list.reduce((sum, day) => sum + day.trialCents, 0),
    trials: list.reduce((sum, day) => sum + day.trials.length, 0), wageCents: list.reduce((sum, day) => sum + day.wageCents, 0)};
}
/** "noc 280 000 Kč, mzdy mimo noc 150 000 Kč, zkušební směny 4× 4 000 Kč" */
export const wageSumText = (sum: WageSum) => [sum.nightCents ? `noc ${kc(sum.nightCents)}` : '', sum.wageCents ? `mzdy mimo noc ${kc(sum.wageCents)}` : '',
  sum.trials ? `zkušební směny ${sum.trials}× ${kc(sum.trialCents)}` : ''].filter(Boolean).join(', ');

/**
 * The night's staff (paid in cash) against the club's revenue. A night whose staff took at least 1,5× the usual share of the
 * same weekday (median of the 4 weeks before, at least 2 nights) and at least 3 000 Kč more than that share of its revenue
 * would have cost: too many people for the night it was, or a weak night with the usual staff.
 */
export type NightShare = {date: string; staffCents: number; clubCents: number; sharePermille: number; usualSharePermille: number; overCents: number};
const shareOf = (night: Night) => night.clubCents && night.clubCents > 0 && night.staffCents > 0 ? night.staffCents / night.clubCents * 1000 : null;
export function nightShare(night: Night | null | undefined, past: Night[]): NightShare | null {
  const share = night ? shareOf(night) : null;
  const usual = past.filter(entry => weekday(entry.date) === weekday(night?.date ?? '')).map(shareOf).filter((value): value is number => value !== null);
  if (!night || share === null || usual.length < 2) return null;
  const usualSharePermille = median(usual), overCents = Math.round(night.staffCents - night.clubCents! * usualSharePermille / 1000);
  return share >= usualSharePermille * 1.5 && overCents >= 300000
    ? {date: night.date, staffCents: night.staffCents, clubCents: night.clubCents!, sharePermille: Math.round(share), usualSharePermille: Math.round(usualSharePermille), overCents} : null;
}
/** "výplaty noci 18 000 Kč = 15 % tržby klubu (pá obvykle 6 %), o 10 800 Kč víc" */
export const nightShareText = (alarm: NightShare) =>
  `${shortDate(alarm.date)} výplaty noci ${kc(alarm.staffCents)} = ${percent(alarm.sharePermille)} tržby klubu (${WEEKDAYS_SHORT[weekday(alarm.date)]} obvykle ${percent(alarm.usualSharePermille)}), o ${kc(alarm.overCents)} víc`;

/** Monday: "Výplaty noci za 4 týdny: 7,2 % tržby klubu (nejvíc st 15 %, nejmíň pá 4,1 %)" */
export function renderNightShares(nights: Night[] | null | undefined): string[] {
  const counted = (nights ?? []).filter(night => shareOf(night) !== null);
  if (counted.length < 4) return [];
  const total = counted.reduce((sum, night) => sum + night.staffCents, 0) / counted.reduce((sum, night) => sum + night.clubCents!, 0) * 1000;
  const by = new Map<number, Night[]>();
  for (const night of counted) by.set(weekday(night.date), [...(by.get(weekday(night.date)) ?? []), night]);
  const days = [...by].filter(([, list]) => list.length >= 2).map(([day, list]) => ({day, permille: list.reduce((sum, night) => sum + night.staffCents, 0) / list.reduce((sum, night) => sum + night.clubCents!, 0) * 1000}))
    .sort((a, b) => b.permille - a.permille);
  const spread = days.length >= 2 ? ` (nejvíc ${WEEKDAYS_SHORT[days[0].day]} ${percent(days[0].permille)}, nejmíň ${WEEKDAYS_SHORT[days.at(-1)!.day]} ${percent(days.at(-1)!.permille)})` : '';
  return [`Výplaty noci za 4 týdny: ${percent(total)} tržby klubu${spread}`];
}

/** Days of the managers' texts saying staff was missing (topic `staff` of src/themes.ts), by weekday, over 8 weeks. */
export type StaffGaps = {from: string; to: string; byWeekday: {weekday: number; dates: string[]}[]};
export function staffGaps(from: string, to: string, days: {date: string; themes: string[]}[]): StaffGaps {
  const by = new Map<number, string[]>();
  for (const day of days) if (day.themes.includes('staff')) by.set(weekday(day.date), [...(by.get(weekday(day.date)) ?? []), day.date]);
  return {from, to, byWeekday: [...by].map(([day, dates]) => ({weekday: day, dates: dates.sort()})).sort((a, b) => b.dates.length - a.dates.length || a.weekday - b.weekday)};
}
/** The morning of a weekday on which staff was missing at least twice in 8 weeks: "dnes pá: za 8 týdnů 2× chyběl personál (10. 10., 17. 10.), domluv náhradníka" */
export function staffGapToday(today: string, gaps: StaffGaps | null | undefined): string | null {
  const row = gaps?.byWeekday.find(entry => entry.weekday === weekday(today));
  return row && row.dates.length >= 2 ? `dnes ${WEEKDAYS_SHORT[row.weekday]}: za 8 týdnů ${row.dates.length}× chyběl personál (${row.dates.slice(-3).map(shortDate).join(', ')}), domluv náhradníka` : null;
}
/** Monday: "Chybí personál za 8 týdnů: pá 3×, so 1×" */
export function renderStaffGaps(gaps: StaffGaps | null | undefined): string[] {
  if (!gaps?.byWeekday.length) return [];
  return [`Chybí personál za 8 týdnů: ${gaps.byWeekday.map(row => `${WEEKDAYS_SHORT[row.weekday]} ${row.dates.length}×`).join(', ')}`];
}
