/**
 * Batch „Promo a odpisy“ (MC „jo“ 18. 10. 2026): the promo and write-off rows of the daily report („Promo Club“,
 * „Odpis Restaurace noc“, …) by place against that place's revenue: the week against the 4 weeks before, the month, and a
 * place whose promo or write-off stayed over its usual 3 days in a row (one day over is already „⚠ Neobvyklé slevy“).
 */
import {addDays, weekday} from './time.ts';
import type {DailyReport} from './daily-report.ts';

const kc = (cents: number) => (cents < 0 ? '−' : '') + String(Math.round(Math.abs(cents) / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ') + ' Kč';
const percent = (permille: number) => `${String(Math.round(permille) / 10).replace('.', ',')} %`;
const median = (values: number[]) => { const sorted = [...values].sort((a, b) => a - b), middle = Math.floor(sorted.length / 2); return sorted.length % 2 ? sorted[middle] : Math.round((sorted[middle - 1] + sorted[middle]) / 2); };
const shortDate = (date: string) => `${Number(date.slice(8))}. ${Number(date.slice(5, 7))}.`;

/** Places of the daily report, with where their revenue stands (a section or the Texaco register). */
const PLACES: {place: string; match: RegExp; revenue: {kind: string; key: string}}[] = [
  {place: 'Club', match: /club|klub/, revenue: {kind: 'revenue_section', key: 'club'}},
  {place: 'Restaurace den', match: /(rest|restaurace)-den/, revenue: {kind: 'revenue_section', key: 'diner'}},
  {place: 'Restaurace noc', match: /(rest|restaurace)-noc/, revenue: {kind: 'revenue_section', key: 'bar'}},
  {place: 'Texaco', match: /texaco/, revenue: {kind: 'revenue_register', key: 'texaco'}},
];
export type PromoKind = 'promo' | 'odpis';
const KIND_NAME: Record<PromoKind, string> = {promo: 'Promo', odpis: 'Odpis'};

export type PromoRow = {kind: PromoKind; place: string; cents: number};
export type PromoDay = {date: string; rows: PromoRow[]; revenue: Record<string, number>};
/** The day's promo and write-off rows by place, and the revenue of each place. `null` = no daily report. */
export function promoDay(report: DailyReport | null): PromoDay | null {
  if (!report) return null;
  const rows: PromoRow[] = [];
  for (const entry of report.lines.filter(line => line.kind === 'discount' && line.amountCents > 0)) {
    // „Cosmo promo“ and „Cosmo klub“ are the partner's promo, kept apart: the report has no revenue of its own for them.
    const cosmo = /^cosmo/.test(entry.key);
    const kind = /^promo-/.test(entry.key) || cosmo ? 'promo' : /^odpis-/.test(entry.key) ? 'odpis' : null;
    const place = cosmo ? 'Cosmo' : PLACES.find(row => row.match.test(entry.key))?.place;
    if (!kind || !place) continue;
    const row = rows.find(other => other.kind === kind && other.place === place);
    if (row) row.cents += entry.amountCents; else rows.push({kind, place, cents: entry.amountCents});
  }
  const revenue: Record<string, number> = {};
  for (const {place, revenue: at} of PLACES) {
    const cents = report.lines.filter(line => line.kind === at.kind && line.key === at.key).reduce((sum, line) => sum + line.amountCents, 0);
    if (cents > 0) revenue[place] = cents;
  }
  return {date: report.businessDate, rows, revenue};
}

/** A stretch of days summed by kind and place, with the places' revenue. */
export type PromoSum = {days: number; promoCents: number; odpisCents: number; revenueCents: number; rows: (PromoRow & {revenueCents: number})[]};
export function sumPromo(days: (PromoDay | null)[]): PromoSum {
  const list = days.filter((day): day is PromoDay => day !== null);
  const rows: (PromoRow & {revenueCents: number})[] = [];
  const revenue = new Map<string, number>();
  for (const day of list) {
    for (const [place, cents] of Object.entries(day.revenue)) revenue.set(place, (revenue.get(place) ?? 0) + cents);
    for (const row of day.rows) {
      const sum = rows.find(other => other.kind === row.kind && other.place === row.place);
      if (sum) sum.cents += row.cents; else rows.push({...row, revenueCents: 0});
    }
  }
  for (const row of rows) row.revenueCents = revenue.get(row.place) ?? 0;
  rows.sort((a, b) => b.cents - a.cents);
  const total = (kind: PromoKind) => rows.filter(row => row.kind === kind).reduce((sum, row) => sum + row.cents, 0);
  return {days: list.length, promoCents: total('promo'), odpisCents: total('odpis'), revenueCents: [...revenue.values()].reduce((sum, cents) => sum + cents, 0), rows};
}
const shareOf = (cents: number, revenueCents: number) => revenueCents > 0 ? cents / revenueCents * 1000 : null;
const name = (row: PromoRow) => `${KIND_NAME[row.kind]} ${row.place}`;

/** The 7 days up to the reported one against the 28 before (at least 5 and 14 days with a report). */
export type PromoWeek = {week: PromoSum; before: PromoSum};
/** Monday: "Promo a odpisy za týden: 54 000 Kč (2,1 % tržby, 4 týdny předtím 1,8 %) · Promo Club 24 000 Kč (3,4 % Clubu, předtím 2,0 %), …" */
export function renderPromoWeek(promo: PromoWeek | null | undefined): string[] {
  if (!promo || promo.week.days < 5 || promo.before.days < 14) return [];
  const {week, before} = promo, cents = week.promoCents + week.odpisCents;
  if (!cents) return [];
  const now = shareOf(cents, week.revenueCents), then = shareOf(before.promoCents + before.odpisCents, before.revenueCents);
  const rows = week.rows.slice(0, 3).map(row => {
    const past = before.rows.find(other => other.kind === row.kind && other.place === row.place);
    const share = shareOf(row.cents, row.revenueCents), pastShare = past ? shareOf(past.cents, past.revenueCents) : 0;
    return `${name(row)} ${kc(row.cents)}${share !== null ? ` (${percent(share)} tržby, předtím ${percent(pastShare ?? 0)})` : ''}`;
  });
  return [`Promo a odpisy za týden: ${kc(cents)}${now !== null ? ` (${percent(now)} tržby${then !== null ? `, 4 týdny předtím ${percent(then)}` : ''})` : ''} · ${rows.join(', ')}`];
}

/** Month line: "promo 120 000 Kč, odpisy 40 000 Kč (nejvíc Promo Club 60 000 Kč)" */
export function promoMonthText(sum: PromoSum | null | undefined): string {
  if (!sum || (!sum.promoCents && !sum.odpisCents)) return '';
  return [sum.promoCents ? `promo ${kc(sum.promoCents)}` : '', sum.odpisCents ? `odpisy ${kc(sum.odpisCents)}` : ''].filter(Boolean).join(', ') +
    (sum.rows.length ? ` (nejvíc ${name(sum.rows[0])} ${kc(sum.rows[0].cents)})` : '');
}

/**
 * A kind and place over its usual on each of the last 3 days: at least 1,5× the median of the same weekday of the 4 weeks
 * before (at least 2 of them with a report) and at least 1 000 Kč over it. `days` = the 31 days up to the reported one.
 */
export type PromoStreak = {kind: PromoKind; place: string; days: {date: string; cents: number; usualCents: number}[]};
export function promoStreaks(days: (PromoDay | null)[], to: string): PromoStreak[] {
  const byDate = new Map(days.filter((day): day is PromoDay => day !== null).map(day => [day.date, day]));
  const cents = (day: PromoDay, kind: PromoKind, place: string) => day.rows.find(row => row.kind === kind && row.place === place)?.cents ?? 0;
  const over = (date: string, kind: PromoKind, place: string) => {
    const day = byDate.get(date);
    if (!day) return null;
    const past = [7, 14, 21, 28].map(back => byDate.get(addDays(date, -back))).filter((entry): entry is PromoDay => !!entry);
    if (past.length < 2) return null;
    const usualCents = median(past.map(entry => cents(entry, kind, place))), now = cents(day, kind, place);
    return now >= usualCents * 1.5 && now - usualCents >= 100000 ? {date, cents: now, usualCents} : null;
  };
  const last = byDate.get(to);
  if (!last) return [];
  const found: PromoStreak[] = [];
  for (const row of last.rows) {
    const streak = [addDays(to, -2), addDays(to, -1), to].map(date => over(date, row.kind, row.place));
    if (streak.every(entry => entry !== null)) found.push({kind: row.kind, place: row.place, days: streak as PromoStreak['days']});
  }
  return found;
}
/** "Promo Club 3 dny po sobě nad obvyklým: 15. 10. 4 000 Kč (obvykle 2 000 Kč), …" */
export const promoStreakText = (streak: PromoStreak) =>
  `${KIND_NAME[streak.kind]} ${streak.place} 3 dny po sobě nad obvyklým: ${streak.days.map(day => `${shortDate(day.date)} ${kc(day.cents)} (${['ne', 'po', 'út', 'st', 'čt', 'pá', 'so'][weekday(day.date)]} obvykle ${kc(day.usualCents)})`).join(', ')}`;
