/**
 * Batch „Výsledek týdne v Kč“ (MC „jo“ 18. 10. 2026; the first KPI of the master document, the operating result): on
 * Monday what the week left after the supplier invoices and the wages paid out of the till, against the average week of
 * the 4 before, and the food and drink bought against the revenue. Both sides without VAT: the invoices state theirs, the
 * revenue's is taken off by the POS rate of each item, else estimated by section (below). A rough figure, said so: no
 * rent, energy or wages paid by the bank (those come with the accounting). Cash spent out of the till is shown beside it,
 * not taken off: part of it is paid supplier invoices that are already counted.
 */
const kc = (cents: number) => (cents < 0 ? '−' : '') + String(Math.round(Math.abs(cents) / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ') + ' Kč';
const percent = (permille: number) => `${String(Math.round(permille) / 10).replace('.', ',')} %`;
const shortDate = (date: string) => `${Number(date.slice(8))}. ${Number(date.slice(5, 7))}.`;

/**
 * The VAT rate assumed where the POS does not give it, in whole percent: the day restaurant („Restaurace den“) sells
 * mostly food and soft drinks (12 %), the night bar and the club mostly alcohol (21 %); a day known only by its total
 * gets 21 %, so the result is rather under than over.
 */
export const SECTION_VAT: Record<string, number> = {diner: 12, bar: 21, club: 21};
export const DEFAULT_VAT = 21;
/** Revenue with VAT at `rate` % without it. */
export const withoutVat = (cents: number, rate: number) => Math.round(cents * 100 / (100 + rate));

/** A stretch of days: revenue with VAT and without it, supplier invoices without VAT (all and food with drink), cash wages and cash spent. */
export type ResultPart = {revenueCents: number; revenueNetCents: number; revenueDays: number; invoices: number; purchasesCents: number; foodDrinkCents: number; payoutsCents: number; expensesCents: number};
export type WeekResult = {from: string; to: string; week: ResultPart; before: ResultPart};

const resultOf = (part: ResultPart) => part.revenueNetCents - part.purchasesCents - part.payoutsCents;
const foodCost = (part: ResultPart) => part.revenueNetCents > 0 ? part.foodDrinkCents * 1000 / part.revenueNetCents : null;
/** The 4 weeks before as one average week (their sums divided by 4). */
const averageWeek = (part: ResultPart): ResultPart => ({revenueCents: part.revenueCents / 4, revenueNetCents: part.revenueNetCents / 4, revenueDays: part.revenueDays / 4, invoices: part.invoices / 4, purchasesCents: part.purchasesCents / 4,
  foodDrinkCents: part.foodDrinkCents / 4, payoutsCents: part.payoutsCents / 4, expensesCents: part.expensesCents / 4});

/** The figures of the line and the card: the week, the average week before (`null` until the 4 weeks have invoices and 21 days of revenue). */
export function weekResultFigures(result: WeekResult) {
  const before = result.before.invoices > 0 && result.before.revenueDays >= 21 ? averageWeek(result.before) : null;
  return {resultCents: resultOf(result.week), beforeCents: before ? Math.round(resultOf(before)) : null,
    foodCostPermille: foodCost(result.week), beforeFoodCostPermille: before ? foodCost(before) : null};
}

/** Monday, once the week has revenue on 5 days and at least one invoice. */
export function renderWeekResult(result: WeekResult | null | undefined): string[] {
  if (!result || result.week.revenueDays < 5 || !result.week.invoices) return [];
  const {week} = result, figures = weekResultFigures(result);
  const parts = [`${kc(figures.resultCents)}${figures.beforeCents !== null ? ` (průměrný týden ze 4 předchozích ${kc(figures.beforeCents)})` : ''}`,
    `nákup z faktur ${kc(week.purchasesCents)}, z toho jídlo a nápoje ${kc(week.foodDrinkCents)}${figures.foodCostPermille !== null ? ` = ${percent(figures.foodCostPermille)} tržby bez DPH` : ''}${figures.beforeFoodCostPermille !== null ? ` (předtím ${percent(figures.beforeFoodCostPermille)})` : ''}`,
    `výplaty z kasy ${kc(week.payoutsCents)}`];
  if (week.expensesCents) parts.push(`výdaje z kasy ${kc(week.expensesCents)} navíc neodečtené (část jsou zaplacené faktury)`);
  return [`Výsledek týdne ${shortDate(result.from)}–${shortDate(result.to)} (tržba bez DPH ${kc(week.revenueNetCents)} − nákup z faktur bez DPH − výplaty z kasy; DPH z tržby odhadem, bez nájmu, energií a mezd z účtu): ${parts.join(' · ')}`];
}

/**
 * Batch „Výsledek měsíce v Kč“ (MC „jo“ 18. 10. 2026): the same result for the month so far, against the same days of the
 * month before, and a rough projection to the month's end: the revenue still forecast (with VAT, src/briefing.ts) taken
 * without VAT at the month's own ratio and kept at the month's own margin so far, against the whole month before.
 */
export type MonthOutcome = {month: string; through: string; complete: boolean; now: ResultPart;
  /** The month before, the same days (1st up to the same day, or its end), and the whole of it. */
  previousThrough: string; previous: ResultPart; previousFull: ResultPart;
  /** Revenue with VAT still forecast for the rest of the month; `null` without a forecast or once it is over. */
  restRevenueCents: number | null};

export function monthResultFigures(result: MonthOutcome) {
  const {now} = result, resultCents = resultOf(now);
  const comparable = (part: ResultPart) => part.invoices > 0 && part.revenueDays > 0;
  const projectedCents = !result.complete && result.restRevenueCents !== null && now.revenueCents > 0 && now.revenueNetCents > 0
    ? Math.round(resultCents + result.restRevenueCents * now.revenueNetCents / now.revenueCents * resultCents / now.revenueNetCents) : null;
  return {resultCents, previousCents: comparable(result.previous) ? resultOf(result.previous) : null,
    projectedCents, previousFullCents: comparable(result.previousFull) ? resultOf(result.previousFull) : null,
    foodCostPermille: foodCost(now), previousFoodCostPermille: comparable(result.previous) ? foodCost(result.previous) : null};
}

/** Monday and the month's last day, with the month's lines; once the month has revenue on 5 days and an invoice. */
export function renderMonthResult(result: MonthOutcome | null | undefined): string[] {
  if (!result || result.now.revenueDays < 5 || !result.now.invoices) return [];
  const figures = monthResultFigures(result), before = `${shortDate(result.previousThrough.slice(0, 8) + '01')}–${shortDate(result.previousThrough)}`;
  const parts = [`${kc(figures.resultCents)}${figures.previousCents !== null ? ` (minulý měsíc ${before} ${kc(figures.previousCents)})` : ''}`];
  if (figures.projectedCents !== null) parts.push(`odhad za celý měsíc ${kc(figures.projectedCents)}${figures.previousFullCents !== null ? ` (minulý měsíc celkem ${kc(figures.previousFullCents)})` : ''}`);
  if (figures.foodCostPermille !== null) parts.push(`jídlo a nápoje ${percent(figures.foodCostPermille)} tržby bez DPH${figures.previousFoodCostPermille !== null ? ` (minulý měsíc ${percent(figures.previousFoodCostPermille)})` : ''}`);
  if (result.now.expensesCents) parts.push(`výdaje z kasy ${kc(result.now.expensesCents)} neodečtené`);
  return [`Výsledek měsíce ${result.complete ? 'celkem' : `do ${shortDate(result.through)}`} (tržba bez DPH ${kc(result.now.revenueNetCents)} − nákup z faktur ${kc(result.now.purchasesCents)} − výplaty z kasy ${kc(result.now.payoutsCents)}): ${parts.join(' · ')}`];
}
