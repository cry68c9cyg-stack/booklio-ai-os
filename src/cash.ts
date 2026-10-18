/**
 * Cash and the night's result (batch „Hotovost a výsledek noci“, MC „jo“ 18. 10. 2026; from the „Report dne“ of 17. 10.,
 * when the cash in the till did not cover the kitchen's wages): whether this morning's cash covers what the day usually pays
 * out of the till, what each night leaves after its staff is paid, by DJ and by weekday, and a day whose cash payouts took
 * an unusual share of the revenue. Only the managers' cash book; nothing is corrected.
 */
import {weekday} from './time.ts';
import {line, type DailyReport} from './daily-report.ts';

const kc = (cents: number) => (cents < 0 ? '−' : '') + String(Math.round(Math.abs(cents) / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ') + ' Kč';
const plain = (value: string) => value.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
const median = (values: number[]) => { const sorted = [...values].sort((a, b) => a - b), middle = Math.floor(sorted.length / 2); return sorted.length % 2 ? sorted[middle] : Math.round((sorted[middle - 1] + sorted[middle]) / 2); };
const WEEKDAYS = ['neděle', 'pondělí', 'úterý', 'středa', 'čtvrtek', 'pátek', 'sobota'];
const WEEKDAYS_IN = ['v neděli', 'v pondělí', 'v úterý', 've středu', 've čtvrtek', 'v pátek', 'v sobotu'];
const WEEKDAYS_SHORT = ['ne', 'po', 'út', 'st', 'čt', 'pá', 'so'];

/** The people paid in cash for the night (the club's staff), as the cash book names them. */
export const NIGHT_STAFF = /^(security|tanecnice|dj|popelar|barback|satnar\w*|vyhazovac\w*)$|^hosteska\b|^animator/;

/** What one day of the cash book says about money: cash paid to people, other cash spent, and the CZK cash counted in the evening. */
export type CashDay = {date: string; payoutsCents: number; staffCents: number; expensesCents: number; cashCents: number | null};
export function cashDay(report: DailyReport | null): CashDay | null {
  if (!report) return null;
  const positive = (kind: 'payout' | 'expense') => report.lines.filter(entry => entry.kind === kind && entry.amountCents > 0);
  const payouts = positive('payout'), expenses = positive('expense');
  // The evening count lists euros, dollars, coins, IOUs and the change box apart; only the loose cash and the safe pay wages.
  const counted = [line(report, 'cash_count', 'hotovost'), line(report, 'balance', 'safe')].filter(entry => entry !== null);
  if (!payouts.length && !expenses.length && !counted.length) return null;
  return {date: report.businessDate, payoutsCents: payouts.reduce((sum, entry) => sum + entry.amountCents, 0),
    staffCents: payouts.filter(entry => NIGHT_STAFF.test(plain(entry.label))).reduce((sum, entry) => sum + entry.amountCents, 0),
    expensesCents: expenses.reduce((sum, entry) => sum + entry.amountCents, 0),
    cashCents: counted.length ? counted.reduce((sum, entry) => sum + Math.max(0, entry!.amountCents), 0) : null};
}

/**
 * Whether the cash counted last night (loose cash and safe, in CZK) covers what today's weekday usually pays out of the till
 * (payouts and expenses, median of the same weekday of the 4 weeks before, at least 2 of them). `null` = enough, or not known.
 */
export type CashNeed = {date: string; cashCents: number; usualOutCents: number; days: number; shortCents: number};
export function cashNeed(today: string, last: CashDay | null, past: (CashDay | null)[]): CashNeed | null {
  const days = past.filter((day): day is CashDay => day !== null && (day.payoutsCents > 0 || day.expensesCents > 0));
  if (!last || last.cashCents === null || days.length < 2) return null;
  const usualOutCents = median(days.map(day => day.payoutsCents + day.expensesCents));
  const shortCents = usualOutCents - last.cashCents;
  return shortCents >= 100000 ? {date: today, cashCents: last.cashCents, usualOutCents, days: days.length, shortCents} : null;
}
/** "v kase a trezoru 44 500 Kč, v sobotu obvykle odejde na výplaty a výdaje 52 000 Kč, chybí asi 7 500 Kč" */
export const cashNeedText = (need: CashNeed) =>
  `v kase a trezoru ${kc(need.cashCents)}, ${WEEKDAYS_IN[weekday(need.date)]} obvykle odejde na výplaty a výdaje ${kc(need.usualOutCents)}, chybí asi ${kc(need.shortCents)}`;

/**
 * A day whose cash payouts took an unusual share of the revenue: at least 1,5× the share of the same weekday of the 4 weeks
 * before (median, at least 2 days) and at least 5 000 Kč over their usual amount.
 */
export type PayoutAlarm = {date: string; payoutsCents: number; sharePermille: number; usualSharePermille: number; usualCents: number};
export function payoutAlarm(day: {date: string; payoutsCents: number; revenueCents: number | null} | null, past: {payoutsCents: number; revenueCents: number | null}[]): PayoutAlarm | null {
  const usable = past.filter(entry => entry.revenueCents && entry.revenueCents > 0);
  if (!day || !day.revenueCents || day.revenueCents <= 0 || !day.payoutsCents || usable.length < 2) return null;
  const sharePermille = Math.round(day.payoutsCents / day.revenueCents * 1000);
  const usualSharePermille = median(usable.map(entry => Math.round(entry.payoutsCents / entry.revenueCents! * 1000)));
  const usualCents = median(usable.map(entry => entry.payoutsCents));
  return sharePermille >= usualSharePermille * 1.5 && day.payoutsCents - usualCents >= 500000
    ? {date: day.date, payoutsCents: day.payoutsCents, sharePermille, usualSharePermille, usualCents} : null;
}
const percent = (permille: number) => `${String(Math.round(permille) / 10).replace('.', ',')} %`;
/** "52 000 Kč, 12 % tržby (v sobotu obvykle 7 %, 30 000 Kč)" */
export const payoutAlarmText = (alarm: PayoutAlarm) =>
  `${kc(alarm.payoutsCents)}, ${percent(alarm.sharePermille)} tržby (${WEEKDAYS_IN[weekday(alarm.date)]} obvykle ${percent(alarm.usualSharePermille)}, ${kc(alarm.usualCents)})`;

/** One night: the club's revenue against the staff paid in cash for it (security, dancers, DJ, …). */
export type Night = {date: string; dj: string | null; clubCents: number | null; revenueCents: number | null; staffCents: number; payoutsCents: number; expensesCents: number; resultCents: number | null};
export type NightSummary = {from: string; to: string; nights: Night[];
  byWeekday: {weekday: number; nights: number; resultCents: number; staffCents: number}[];
  byDj: {dj: string; nights: number; resultCents: number}[]};
/** The nights with a club revenue and the cash book, the averages of the club's result by weekday and by DJ (at least 2 nights each). */
export function nightSummary(from: string, to: string, nights: Night[]): NightSummary {
  const counted = nights.filter(night => night.resultCents !== null);
  const average = (list: Night[], pick: (night: Night) => number) => Math.round(list.reduce((sum, night) => sum + pick(night), 0) / list.length);
  const group = <K>(key: (night: Night) => K | null) => {
    const by = new Map<K, Night[]>();
    for (const night of counted) { const value = key(night); if (value !== null) by.set(value, [...(by.get(value) ?? []), night]); }
    return [...by].filter(([, list]) => list.length >= 2);
  };
  return {from, to, nights,
    byWeekday: group(night => weekday(night.date)).map(([day, list]) => ({weekday: day, nights: list.length, resultCents: average(list, night => night.resultCents!), staffCents: average(list, night => night.staffCents)}))
      .sort((a, b) => b.resultCents - a.resultCents),
    byDj: group(night => night.dj).map(([dj, list]) => ({dj, nights: list.length, resultCents: average(list, night => night.resultCents!)})).sort((a, b) => b.resultCents - a.resultCents)};
}

/** Monday: "Výsledek noci za 4 týdny (klub − výplaty noci, průměr): nejlepší pá 85 000 Kč, nejslabší st 12 000 Kč · DJ: Tester 90 000 Kč (3 noci), …" */
export function renderNights(summary: NightSummary | null | undefined): string[] {
  if (!summary || !summary.byWeekday.length) return [];
  const best = summary.byWeekday[0], worst = summary.byWeekday[summary.byWeekday.length - 1];
  const nights = (count: number) => `${count} ${count >= 2 && count <= 4 ? 'noci' : 'nocí'}`;
  const days = summary.byWeekday.length > 1 ? `nejlepší ${WEEKDAYS_SHORT[best.weekday]} ${kc(best.resultCents)}, nejslabší ${WEEKDAYS_SHORT[worst.weekday]} ${kc(worst.resultCents)}`
    : `${WEEKDAYS[best.weekday]} ${kc(best.resultCents)}`;
  const djs = summary.byDj.slice(0, 3).map(row => `${row.dj} ${kc(row.resultCents)} (${nights(row.nights)})`).join(', ');
  return [`Výsledek noci za 4 týdny (tržba klubu − výplaty noci, průměr): ${days}${djs ? ` · DJ: ${djs}` : ''}`];
}

/**
 * The till beyond the day's sales (batch „Kasa pod kontrolou“, MC „jo“ 18. 10. 2026): the IOUs in the evening count („Dluhy“),
 * the "Vklad JD" rows of the cash book, and revenue rows whose cash part is negative (more on cards than sold: most likely
 * card tips paid out in cash).
 */
export type TillDay = {date: string; debtsCents: number | null; depositsCents: number; tips: {label: string; amountCents: number}[]; tipsCents: number};
export function tillDay(report: DailyReport | null): TillDay | null {
  if (!report) return null;
  const debts = line(report, 'cash_count', 'dluhy');
  const deposits = report.lines.filter(entry => entry.kind === 'movement' && /^vklad/.test(plain(entry.label)));
  // The cash part of each revenue row of the journal ("Tržba Club" …), not the row of the whole day.
  const tips = report.lines.filter(entry => entry.kind === 'total' && entry.amountCents < 0 && /^trzba\b/.test(plain(entry.label)) && !/hotovost|celkem/.test(plain(entry.label)))
    .map(entry => ({label: entry.label.replace(/^tržba\s+/i, '').trim(), amountCents: -entry.amountCents}));
  if (!debts && !deposits.length && !tips.length) return null;
  return {date: report.businessDate, debtsCents: debts ? debts.amountCents : null, depositsCents: deposits.reduce((sum, entry) => sum + Math.abs(entry.amountCents), 0),
    tips, tipsCents: tips.reduce((sum, entry) => sum + entry.amountCents, 0)};
}

/** The day with the IOUs a week before and the month's deposits and negative cash so far. */
export type Till = {day: TillDay; debtsWeekAgoCents: number | null; month: string; monthDepositsCents: number; monthTipsCents: number};
/** IOUs worth a warning: at least 2 000 Kč and a quarter more than a week before. */
export const debtsRising = (till: Till | null | undefined) => !!till && till.day.debtsCents !== null && till.debtsWeekAgoCents !== null &&
  till.day.debtsCents - till.debtsWeekAgoCents >= 200000 && till.day.debtsCents >= till.debtsWeekAgoCents * 1.25;
export const debtsText = (till: Till) => `${kc(till.day.debtsCents!)}, před týdnem ${kc(till.debtsWeekAgoCents!)}`;

const MONTHS = ['leden', 'únor', 'březen', 'duben', 'květen', 'červen', 'červenec', 'srpen', 'září', 'říjen', 'listopad', 'prosinec'];
/** "Kasa: Vklad JD 70 000 Kč (říjen zatím 149 000 Kč) · záporná hotovost v tržbě 12 405 Kč, nejspíš spropitné z karet (Club 4 685 Kč) · dluhy ve výčetce 7 621 Kč (před týdnem 9 472 Kč)" */
export function renderTill(till: Till | null | undefined): string[] {
  if (!till) return [];
  const month = MONTHS[Number(till.month.slice(5)) - 1], day = till.day, parts: string[] = [];
  if (day.depositsCents) parts.push(`Vklad JD ${kc(day.depositsCents)} (${month} zatím ${kc(till.monthDepositsCents)})`);
  if (day.tipsCents) parts.push(`záporná hotovost v tržbě ${kc(day.tipsCents)}, nejspíš spropitné z karet (${day.tips.map(tip => `${tip.label} ${kc(tip.amountCents)}`).join(', ')}; ${month} zatím ${kc(till.monthTipsCents)})`);
  if (day.debtsCents) parts.push(`dluhy ve výčetce ${kc(day.debtsCents)}${till.debtsWeekAgoCents !== null ? ` (před týdnem ${kc(till.debtsWeekAgoCents)})` : ''}`);
  const lines = parts.length ? [`Kasa: ${parts.join(' · ')}`] : [];
  if (debtsRising(till)) lines.push(`⚠ Dluhy ve výčetce rostou: ${debtsText(till)}; zjisti, kdo dluží a kdy vrátí.`);
  return lines;
}
