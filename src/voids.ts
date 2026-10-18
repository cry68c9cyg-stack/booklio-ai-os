/**
 * Batch „Storna a rozdíly v kase“ (MC „jo“ 18. 10. 2026): the voids of the daily report against the revenue (the week
 * against the 4 weeks before, the month), the cash count against the cash book's balance („Rozdíl přepočtu a zůstatku“)
 * over the month and when it keeps coming back, and a day with both unusual voids and a cash difference: the first
 * signal of the shrinkage module of the master document (void, cash variance).
 */
import {addDays, weekday} from './time.ts';
import {line, type DailyReport} from './daily-report.ts';

const kc = (cents: number) => (cents < 0 ? '−' : '') + String(Math.round(Math.abs(cents) / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ') + ' Kč';
const signed = (cents: number) => (cents > 0 ? '+' : '') + kc(cents);
/** Basis points (hundredths of a percent) as "0,47 %". */
const percent = (basisPoints: number) => `${String(basisPoints / 100).replace('.', ',')} %`;
const median = (values: number[]) => { const sorted = [...values].sort((a, b) => a - b), middle = Math.floor(sorted.length / 2); return sorted.length % 2 ? sorted[middle] : Math.round((sorted[middle - 1] + sorted[middle]) / 2); };
const shortDate = (date: string) => `${Number(date.slice(8))}. ${Number(date.slice(5, 7))}.`;
const WEEKDAYS_SHORT = ['ne', 'po', 'út', 'st', 'čt', 'pá', 'so'];

/** A cash difference from this amount counts (smaller ones are coins and rounding). */
export const CASH_DIFF_CENTS = 10000;

/** One day: the voids and revenue of the daily report (`null` without one), the cash difference of the cash book (`null` without one). */
export type VoidDay = {date: string; voidCents: number | null; revenueCents: number | null; cashDiffCents: number | null};
export function voidDay(report: DailyReport | null): VoidDay | null {
  if (!report) return null;
  const sections = report.lines.filter(entry => entry.kind === 'revenue_section');
  const voids = report.lines.filter(entry => entry.kind === 'void');
  const revenueCents = sections.length ? sections.reduce((sum, entry) => sum + entry.amountCents, 0) : null;
  // Only the daily report has the „Storno“ row; a day from the cash book alone has revenue but no voids to compare.
  return {date: report.businessDate, voidCents: voids.length ? voids.reduce((sum, entry) => sum + Math.max(0, entry.amountCents), 0) : null, revenueCents,
    cashDiffCents: line(report, 'total', 'cash-difference')?.amountCents ?? null};
}

/** A stretch of days: voids against the revenue of the days with a daily report, and the cash differences of the cash book. */
export type VoidSum = {reportDays: number; voidCents: number; revenueCents: number; cashDays: number; cashDiffCents: number; cashDiffAbsCents: number; diffDays: {date: string; cents: number}[]};
export function sumVoids(days: (VoidDay | null)[]): VoidSum {
  const reported = days.filter((day): day is VoidDay => day !== null && day.voidCents !== null);
  const counted = days.filter((day): day is VoidDay => day !== null && day.cashDiffCents !== null);
  return {reportDays: reported.length, voidCents: reported.reduce((sum, day) => sum + day.voidCents!, 0), revenueCents: reported.reduce((sum, day) => sum + (day.revenueCents ?? 0), 0),
    cashDays: counted.length, cashDiffCents: counted.reduce((sum, day) => sum + day.cashDiffCents!, 0), cashDiffAbsCents: counted.reduce((sum, day) => sum + Math.abs(day.cashDiffCents!), 0),
    diffDays: counted.filter(day => Math.abs(day.cashDiffCents!) >= CASH_DIFF_CENTS).map(day => ({date: day.date, cents: day.cashDiffCents!}))};
}
const shareOf = (sum: VoidSum) => sum.revenueCents > 0 ? Math.round(sum.voidCents * 10000 / sum.revenueCents) : null;

/** Month line: "storna 24 000 Kč (0,52 % tržby) · rozdíly v kase celkem +180 Kč (3 dny nad 100 Kč)" */
export function voidMonthText(sum: VoidSum | null | undefined): string {
  if (!sum) return '';
  const parts: string[] = [];
  const share = shareOf(sum);
  if (sum.reportDays && sum.voidCents) parts.push(`storna ${kc(sum.voidCents)}${share !== null ? ` (${percent(share)} tržby)` : ''}`);
  if (sum.cashDays && sum.cashDiffAbsCents) parts.push(`rozdíly v kase celkem ${signed(sum.cashDiffCents)}${sum.diffDays.length ? ` (${sum.diffDays.length} ${sum.diffDays.length === 1 ? 'den' : sum.diffDays.length <= 4 ? 'dny' : 'dní'} nad ${kc(CASH_DIFF_CENTS)})` : ''}`);
  return parts.join(' · ');
}

/** Monday: "Storna za týden: 12 000 Kč (0,4 % tržby, 4 týdny předtím 0,3 %)", with at least 5 and 14 days of daily reports. */
export function renderVoidWeek(week: {week: VoidSum; before: VoidSum} | null | undefined): string[] {
  if (!week || week.week.reportDays < 5 || week.before.reportDays < 14 || !week.week.voidCents) return [];
  const now = shareOf(week.week), then = shareOf(week.before);
  return [`Storna za týden: ${kc(week.week.voidCents)}${now !== null ? ` (${percent(now)} tržby${then !== null ? `, 4 týdny předtím ${percent(then)}` : ''})` : ''}`];
}

/** At least 3 days of the 7 up to the reported one with a cash difference of 100 Kč or more. `days` = those 7 days. */
export function cashDiffRepeat(days: (VoidDay | null)[]): {date: string; cents: number}[] | null {
  const found = sumVoids(days).diffDays;
  return found.length >= 3 ? found : null;
}
export const cashDiffRepeatText = (found: {date: string; cents: number}[]) =>
  `rozdíl v kase ${found.length}× za 7 dní: ${found.map(day => `${shortDate(day.date)} ${signed(day.cents)}`).join(', ')}`;

/**
 * The reported day with voids at least 1,5× the median of the same weekday of the 4 weeks before (at least 2 of them) and
 * 1 000 Kč over it, and a cash difference of 100 Kč or more on the same day.
 */
export type VoidAndDiff = {date: string; voidCents: number; usualCents: number; cashDiffCents: number};
export function voidAndDiff(day: VoidDay | null, past: (VoidDay | null)[]): VoidAndDiff | null {
  const usable = past.filter((entry): entry is VoidDay => entry !== null && entry.voidCents !== null && weekday(entry.date) === weekday(day?.date ?? ''));
  if (!day || day.voidCents === null || day.cashDiffCents === null || usable.length < 2 || Math.abs(day.cashDiffCents) < CASH_DIFF_CENTS) return null;
  const usualCents = median(usable.map(entry => entry.voidCents!));
  return day.voidCents >= usualCents * 1.5 && day.voidCents - usualCents >= 100000 ? {date: day.date, voidCents: day.voidCents, usualCents, cashDiffCents: day.cashDiffCents} : null;
}
export const voidAndDiffText = (found: VoidAndDiff) =>
  `${shortDate(found.date)} storna ${kc(found.voidCents)} (${WEEKDAYS_SHORT[weekday(found.date)]} obvykle ${kc(found.usualCents)}) a zároveň rozdíl v kase ${signed(found.cashDiffCents)}; projít storna toho dne`;

/** The days a check needs: the reported one and the same weekday of the 4 weeks before. */
export const voidPastDates = (date: string) => [7, 14, 21, 28].map(back => addDays(date, -back));
