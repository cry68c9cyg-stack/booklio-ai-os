/**
 * Batch „Den proti noci v Kč“ (MC „jo“ 18. 10. 2026): on Monday what the day („Restaurace den“) and the night („Restaurace
 * noc“ and the Club) each took without VAT, less the wages paid out of the till for them. The night's staff (security, DJ,
 * the club's bar) belong to the night; the other cash wages (kitchen, bar, cleaning, help, trial shifts) serve the ground
 * floor by day and by night alike, so they are shared between „Restaurace den“ and „Restaurace noc“ by their revenue over
 * the whole stretch (the kitchen is paid once a week: by day it would land on one part only). Against the 4 weeks before.
 * Supplier invoices are not split: they do not say which part they were for.
 */
import {DEFAULT_VAT, SECTION_VAT, withoutVat} from './weekresult.ts';
import {payoutKind} from './wages.ts';
import type {DailyReport} from './daily-report.ts';

const kc = (cents: number) => (cents < 0 ? '−' : '') + String(Math.round(Math.abs(cents) / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ') + ' Kč';
const percent = (permille: number) => `${String(Math.round(permille) / 10).replace('.', ',')} %`;
const shortDate = (date: string) => `${Number(date.slice(8))}. ${Number(date.slice(5, 7))}.`;

/** Days with revenue by section, the revenue of the day and the night with and without VAT (of the night: the ground floor's), and the cash wages. */
export type PartSums = {days: number; dayCents: number; dayNetCents: number; nightCents: number; nightNetCents: number; barNetCents: number; otherWagesCents: number; nightStaffCents: number};
export type DayNight = {from: string; to: string; week: PartSums; before: PartSums};
export const emptyParts = (): PartSums => ({days: 0, dayCents: 0, dayNetCents: 0, nightCents: 0, nightNetCents: 0, barNetCents: 0, otherWagesCents: 0, nightStaffCents: 0});

/** Adds one day of the cash book or daily report; a day without revenue by section is left out, its wages too. */
export function addPartDay(sums: PartSums, report: DailyReport | null): PartSums {
  const sections = report?.lines.filter(entry => entry.kind === 'revenue_section') ?? [];
  if (!report || !sections.length) return sums;
  const next = {...sums, days: sums.days + 1};
  for (const entry of sections) {
    const net = withoutVat(entry.amountCents, SECTION_VAT[entry.key] ?? DEFAULT_VAT);
    if (entry.key === 'diner') { next.dayCents += entry.amountCents; next.dayNetCents += net; }
    else { next.nightCents += entry.amountCents; next.nightNetCents += net; if (entry.key === 'bar') next.barNetCents += net; }
  }
  for (const entry of report.lines.filter(entry => entry.kind === 'payout' && entry.amountCents > 0)) {
    if (payoutKind(entry.label) === 'night') next.nightStaffCents += entry.amountCents;
    else next.otherWagesCents += entry.amountCents;
  }
  return next;
}

const share = (wages: number, revenue: number) => revenue > 0 ? wages * 1000 / revenue : null;
/** The other wages shared by the ground floor's revenue: the day's part and the night's. */
const dayWages = (sums: PartSums) => { const floor = sums.dayNetCents + sums.barNetCents; return floor > 0 ? Math.round(sums.otherWagesCents * sums.dayNetCents / floor) : 0; };
const nightWages = (sums: PartSums) => sums.nightStaffCents + sums.otherWagesCents - dayWages(sums);
/** The day and the night: what is left after the wages, the wages as a share of the revenue without VAT, the same of the average week before. */
export function dayNightFigures(input: DayNight) {
  const {week, before} = input, enough = before.days >= 14;
  const part = (revenue: (sums: PartSums) => number, wages: (sums: PartSums) => number) => {
    const nowShare = share(wages(week), revenue(week)), beforeShare = enough ? share(wages(before), revenue(before)) : null;
    return {revenueNetCents: revenue(week), wagesCents: wages(week), leftCents: revenue(week) - wages(week),
      beforeLeftCents: enough ? Math.round((revenue(before) - wages(before)) / 4) : null, sharePermille: nowShare, beforeSharePermille: beforeShare,
      // Worse: the wages took at least a fifth more of the revenue than before, and 2 points more.
      worse: nowShare !== null && beforeShare !== null && nowShare >= beforeShare * 1.2 && nowShare - beforeShare >= 20};
  };
  return {day: part(sums => sums.dayNetCents, dayWages), night: part(sums => sums.nightNetCents, nightWages)};
}

/** Monday, once the week has revenue by section on 5 days. */
export function renderDayNight(input: DayNight | null | undefined): string[] {
  if (!input || input.week.days < 5 || (!input.week.dayCents && !input.week.nightCents)) return [];
  const figures = dayNightFigures(input);
  const text = (name: string, wagesName: string, part: ReturnType<typeof dayNightFigures>['day']) =>
    `${part.worse ? '⚠ ' : ''}${name} ${kc(part.revenueNetCents)} − ${wagesName} ${kc(part.wagesCents)} = ${kc(part.leftCents)}${part.beforeLeftCents !== null ? ` (průměrný týden ${kc(part.beforeLeftCents)})` : ''}` +
    (part.sharePermille !== null ? `, tj. ${percent(part.sharePermille)} tržby${part.beforeSharePermille !== null ? ` (předtím ${percent(part.beforeSharePermille)})` : ''}` : '');
  return [`Den proti noci ${shortDate(input.from)}–${shortDate(input.to)} (tržba bez DPH − výplaty z kasy; mzdy mimo noční personál podle tržby Restaurace den a noc; bez faktur): ${text('den', 'výplaty', figures.day)} · ${text('noc a Club', 'výplaty', figures.night)}`];
}
