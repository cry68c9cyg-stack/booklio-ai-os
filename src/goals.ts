/**
 * Goals and comparisons (batch „Cíle a srovnání“, MC „jo“ 18. 10. 2026): the month's revenue target and how it goes,
 * shifts to strengthen or thin over the 7 days ahead from the guests to expect, and days without data.
 */
import {addDays, weekday} from './time.ts';
import {DAY_PARTS, type DayPart, type GuestOutlookDay} from './briefing.ts';

/** The target is the base month (last year's same month, else the month before) plus 5 %. */
export const TARGET_GROWTH_PERMILLE = 50;
export type TargetBase = {basis: 'last_year' | 'previous_month'; month: string; cents: number};
export type MonthTarget = {month: string; targetCents: number; base: TargetBase; actualCents: number; actualDays: number; elapsedDays: number;
  forecastCents: number | null; daysLeft: number; perDayCents: number | null};

const nextMonth = (month: string) => { const [year, number] = month.split('-').map(Number); return number === 12 ? `${year + 1}-01` : `${year}-${String(number + 1).padStart(2, '0')}`; };
export const monthDays = (month: string) => Number(addDays(nextMonth(month) + '-01', -1).slice(8));

/** A whole month's revenue from its days with data; at most 2 days may be missing (they are filled with the month's daily average). */
export function monthBase(month: string, revenue: (date: string) => number | null): {cents: number; days: number} | null {
  let cents = 0, days = 0;
  const all = monthDays(month);
  for (let day = 1; day <= all; day++) {
    const value = revenue(`${month}-${String(day).padStart(2, '0')}`);
    if (value !== null) { cents += value; days++; }
  }
  return days && days >= all - 2 ? {cents: Math.round(cents / days * all), days} : null;
}

/**
 * The target of the month the starting day (`today`) is in, against the revenue so far (days with data up to yesterday) and the
 * forecast for the whole month; what each remaining day (today to the month's end) would need to reach it.
 */
export function monthTarget(today: string, base: TargetBase | null, month: {actualCents: number; actualDays: number; elapsedDays: number; totalCents: number | null}): MonthTarget | null {
  if (!base || base.cents <= 0) return null;
  const targetCents = Math.round(base.cents * (1000 + TARGET_GROWTH_PERMILLE) / 1000);
  const daysLeft = monthDays(today.slice(0, 7)) - Number(today.slice(8)) + 1;
  return {month: today.slice(0, 7), targetCents, base, actualCents: month.actualCents, actualDays: month.actualDays, elapsedDays: month.elapsedDays,
    forecastCents: month.totalCents, daysLeft, perDayCents: Math.max(0, Math.ceil((targetCents - month.actualCents) / daysLeft))};
}

/** A part of a day ahead needs more staff when 30 % and 15 guests over its usual, fewer when 30 % and 15 guests under it. */
export const SHIFT_SHARE = 0.3, SHIFT_MIN_GUESTS = 15;
export type ShiftSignal = {date: string; part: DayPart; expected: number; usual: number; direction: 'up' | 'down'};
export function shiftSignals(days: GuestOutlookDay[] | undefined): ShiftSignal[] {
  const signals: ShiftSignal[] = [];
  for (const day of days ?? []) {
    for (const part of day.parts) {
      if (part.expected === null || part.usual === null || part.usual === undefined) continue;
      const difference = part.expected - part.usual;
      if (difference >= SHIFT_MIN_GUESTS && part.expected >= part.usual * (1 + SHIFT_SHARE)) signals.push({date: day.date, part: part.key, expected: part.expected, usual: part.usual, direction: 'up'});
      else if (-difference >= SHIFT_MIN_GUESTS && part.expected <= part.usual * (1 - SHIFT_SHARE)) signals.push({date: day.date, part: part.key, expected: part.expected, usual: part.usual, direction: 'down'});
    }
  }
  return signals;
}

/** Days of the 14 before the reported one: with no revenue at all (the weekday was open), or known only from the cash book. */
export type DataGaps = {from: string; to: string; noRevenue: string[]; journalOnly: string[]};
export const GAP_DAYS = 14;
export const hasGaps = (gaps: DataGaps | null | undefined) => !!gaps && (gaps.noRevenue.length > 0 || gaps.journalOnly.length > 0);

const weekdayShort = ['ne', 'po', 'út', 'st', 'čt', 'pá', 'so'];
const short = (date: string) => `${Number(date.slice(8))}. ${Number(date.slice(5, 7))}.`;
export const partName = (key: DayPart) => DAY_PARTS.find(part => part.key === key)!.name;

/** "pá 24. 10. večer posílit (čekej asi 180 hostů z rezervací, obvykle 120)" */
export const shiftText = (signal: ShiftSignal) => `${weekdayShort[weekday(signal.date)]} ${short(signal.date)} ${partName(signal.part)} ${signal.direction === 'up' ? 'posílit' : 'ubrat'} ` +
  `(čekej asi ${signal.expected} ${signal.expected === 1 ? 'hosta' : 'hostů'} z rezervací, obvykle ${signal.usual})`;

/** "bez tržby 3. 10. · jen z peněžního deníku (chybí denní report) 15. 10." */
export const gapsText = (gaps: DataGaps) => [gaps.noRevenue.length ? `bez tržby ${gaps.noRevenue.map(short).join(', ')}` : '',
  gaps.journalOnly.length ? `jen z peněžního deníku, chybí denní report ${gaps.journalOnly.map(short).join(', ')}` : ''].filter(Boolean).join(' · ');
