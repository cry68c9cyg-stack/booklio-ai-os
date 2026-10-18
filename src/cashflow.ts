/**
 * Batch „Výhled hotovosti na týden“ (MC „jo“ 18. 10. 2026): from the cash book, what the till takes in cash from the sales
 * and pays out (wages and expenses) on each weekday, so that every morning OKO1 says how the loose cash and the safe will go
 * over the next 7 days and how much Vklad JD it will take, and when; on Monday the deposits day by day and the cash part of
 * the revenue, the week against the 4 weeks before. Movements (Vklad JD, Odvod) are left out: they are what the forecast is for.
 */
import {addDays, weekday} from './time.ts';
import {line, type DailyReport} from './daily-report.ts';
import {cashDay} from './cash.ts';

const kc = (cents: number) => (cents < 0 ? '−' : '') + String(Math.round(Math.abs(cents) / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ') + ' Kč';
const mean = (values: number[]) => Math.round(values.reduce((sum, value) => sum + value, 0) / values.length);
/** A sum of usual amounts, to whole thousands: "asi 315 000 Kč". */
const approx = (cents: number) => kc(Math.round(cents / 100000) * 100000);
const plain = (value: string) => value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
const shortDate = (date: string) => `${Number(date.slice(8))}. ${Number(date.slice(5, 7))}.`;
/** Basis points (hundredths of a percent) as "2,1 %", to one decimal. */
const percent = (basisPoints: number) => `${String(Math.round(basisPoints / 10) / 10).replace('.', ',')} %`;
const WEEKDAYS_SHORT = ['ne', 'po', 'út', 'st', 'čt', 'pá', 'so'];
/** A deposit is rounded up to whole thousands: nobody brings 38 417 Kč. */
const DEPOSIT_STEP_CENTS = 100000;

/**
 * One day of the till: the cash part of the sales (the cash book's „Tržba hotovost“, else the daily report's cash payment;
 * negative when card tips were paid out in cash), the cash paid to people and spent, the revenue, and the CZK cash and safe
 * counted in the evening. Cash withdrawn from the bank the same day („Výběr hotovosti“) paid for something brought along
 * (14. 10.: 110 000 Kč in, 110 000 Kč out): it is taken off what went out, so a one-off does not inflate its weekday.
 */
export type CashFlowDay = {date: string; inCents: number | null; outCents: number; revenueCents: number | null; cashCents: number | null};
export function cashFlowDay(report: DailyReport | null): CashFlowDay | null {
  if (!report) return null;
  const cash = cashDay(report);
  const received = line(report, 'journal_payment', 'cash') ?? line(report, 'payment', 'cash');
  const sections = report.lines.filter(entry => entry.kind === 'revenue_section');
  const withdrawn = report.lines.filter(entry => entry.kind === 'movement' && /^vyber/.test(plain(entry.label))).reduce((sum, entry) => sum + Math.abs(entry.amountCents), 0);
  if (!cash && !received) return null;
  return {date: report.businessDate, inCents: received ? received.amountCents : null, outCents: cash ? Math.max(0, cash.payoutsCents + cash.expensesCents - withdrawn) : 0,
    revenueCents: sections.length ? sections.reduce((sum, entry) => sum + entry.amountCents, 0) : null, cashCents: cash?.cashCents ?? null};
}

/** One day ahead: what usually comes in and goes out on its weekday, the Vklad JD it takes so the cash never goes below zero, and the cash left. */
export type ForecastDay = {date: string; inCents: number; outCents: number; depositCents: number; balanceCents: number};
export type CashForecast = {from: string; startCents: number; days: ForecastDay[]; inCents: number; outCents: number; depositCents: number; firstShort: string | null};
/**
 * The 7 days after `date` from the cash counted on its evening: each day gets the average of the same weekday of the 4 weeks
 * before it (at least 2 days of the cash book each, all of them on or before `date`). The average, not the median: the big
 * wages come on different days (the kitchen 107 533 Kč on Saturday 17. 10., Aleš 38 000 Kč on Thursday 15. 10.), and the
 * median of a weekday would leave them out, so the week would look cheaper than it is. `days` = the 28 days up to `date`.
 */
export function cashForecast(date: string, days: (CashFlowDay | null)[]): CashForecast | null {
  const byDate = new Map(days.filter((day): day is CashFlowDay => day !== null).map(day => [day.date, day]));
  const last = byDate.get(date);
  if (!last || last.cashCents === null) return null;
  const ahead: ForecastDay[] = [];
  let balanceCents = last.cashCents;
  for (let next = 1; next <= 7; next++) {
    const day = addDays(date, next);
    const past = [7, 14, 21, 28].map(back => byDate.get(addDays(day, -back))).filter((entry): entry is CashFlowDay => !!entry && entry.date <= date);
    if (past.length < 2) return null;
    const inCents = mean(past.map(entry => entry.inCents ?? 0)), outCents = mean(past.map(entry => entry.outCents));
    balanceCents += inCents - outCents;
    const depositCents = balanceCents < 0 ? Math.ceil(-balanceCents / DEPOSIT_STEP_CENTS) * DEPOSIT_STEP_CENTS : 0;
    balanceCents += depositCents;
    ahead.push({date: day, inCents, outCents, depositCents, balanceCents});
  }
  const sum = (pick: (day: ForecastDay) => number) => ahead.reduce((total, day) => total + pick(day), 0);
  return {from: date, startCents: last.cashCents, days: ahead, inCents: sum(day => day.inCents), outCents: sum(day => day.outCents), depositCents: sum(day => day.depositCents),
    firstShort: ahead.find(day => day.depositCents > 0)?.date ?? null};
}
const dayName = (date: string) => `${WEEKDAYS_SHORT[weekday(date)]} ${shortDate(date)}`;

/** "v kase a trezoru 47 900 Kč; do so 25. 10. obvykle odejde asi 330 000 Kč na výplaty a výdaje, z tržeb přijde v hotovosti asi 50 000 Kč; vklad JD bude potřeba asi 233 000 Kč, poprvé ne 19. 10." */
export function cashForecastText(forecast: CashForecast): string {
  const end = forecast.days[forecast.days.length - 1];
  const head = `v kase a trezoru ${kc(forecast.startCents)}; do ${dayName(end.date)} obvykle odejde asi ${approx(forecast.outCents)} na výplaty a výdaje, z tržeb přijde v hotovosti asi ${approx(forecast.inCents)}`;
  return forecast.firstShort ? `${head}; vklad JD bude potřeba asi ${kc(forecast.depositCents)}, poprvé ${dayName(forecast.firstShort)}`
    : `${head}; vystačí, na konci asi ${approx(end.balanceCents)}`;
}
/** Every morning: "Hotovost na 7 dní: …" */
export const renderCashForecast = (forecast: CashForecast | null | undefined) => forecast ? [`Hotovost na 7 dní: ${cashForecastText(forecast)}`] : [];

/** Monday: "Vklady JD na týden, aby hotovost na výplaty stačila: po 19. 10. 40 000 Kč, so 24. 10. 120 000 Kč (celkem 160 000 Kč)" */
export function renderDeposits(forecast: CashForecast | null | undefined): string[] {
  if (!forecast) return [];
  const days = forecast.days.filter(day => day.depositCents > 0);
  if (!days.length) return [`Vklady JD na týden: nebudou potřeba, hotovost na výplaty a výdaje obvykle vystačí (na konci týdne asi ${approx(forecast.days[forecast.days.length - 1].balanceCents)})`];
  return [`Vklady JD na týden, aby hotovost na výplaty a výdaje stačila: ${days.map(day => `${dayName(day.date)} ${kc(day.depositCents)}`).join(', ')}${days.length > 1 ? ` (celkem ${kc(forecast.depositCents)})` : ''}`];
}

/** The cash part of the sales against the whole revenue over a stretch (days with both). */
export type CashShare = {days: number; inCents: number; revenueCents: number};
export function cashShare(days: (CashFlowDay | null)[]): CashShare {
  const counted = days.filter((day): day is CashFlowDay => day !== null && day.inCents !== null && day.revenueCents !== null && day.revenueCents > 0);
  return {days: counted.length, inCents: counted.reduce((sum, day) => sum + day.inCents!, 0), revenueCents: counted.reduce((sum, day) => sum + day.revenueCents!, 0)};
}
const shareOf = (share: CashShare) => share.revenueCents > 0 ? Math.round(share.inCents * 10000 / share.revenueCents) : null;

/** Monday, with at least 5 and 14 days: "Hotovost z tržeb za týden: 18 000 Kč = 2,1 % celkové tržby (4 týdny předtím 3 %)" */
export function renderCashShare(share: {week: CashShare; before: CashShare} | null | undefined): string[] {
  if (!share || share.week.days < 5 || share.before.days < 14) return [];
  const now = shareOf(share.week), then = shareOf(share.before);
  if (now === null) return [];
  return [`Hotovost z tržeb za týden: ${kc(share.week.inCents)} = ${percent(now)} celkové tržby${then !== null ? ` (4 týdny předtím ${percent(then)})` : ''}`];
}
