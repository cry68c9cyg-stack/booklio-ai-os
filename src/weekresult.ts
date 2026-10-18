/**
 * Batch „Výsledek týdne v Kč“ (MC „jo“ 18. 10. 2026; the first KPI of the master document, the operating result): on
 * Monday what the week left after the supplier invoices and the wages paid out of the till, against the average week of
 * the 4 before, and the food and drink bought against the revenue. A rough figure, said so: revenue with VAT, invoices
 * without it, and no rent, energy or wages paid by the bank (those come with the accounting). Cash spent out of the till
 * is shown beside it, not taken off: part of it is paid supplier invoices that are already counted.
 */
const kc = (cents: number) => (cents < 0 ? '−' : '') + String(Math.round(Math.abs(cents) / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ') + ' Kč';
const percent = (permille: number) => `${String(Math.round(permille) / 10).replace('.', ',')} %`;
const shortDate = (date: string) => `${Number(date.slice(8))}. ${Number(date.slice(5, 7))}.`;

/** A stretch of days: revenue with VAT, supplier invoices without VAT (all and food with drink), cash wages and cash spent. */
export type ResultPart = {revenueCents: number; revenueDays: number; invoices: number; purchasesCents: number; foodDrinkCents: number; payoutsCents: number; expensesCents: number};
export type WeekResult = {from: string; to: string; week: ResultPart; before: ResultPart};

const resultOf = (part: ResultPart) => part.revenueCents - part.purchasesCents - part.payoutsCents;
const foodCost = (part: ResultPart) => part.revenueCents > 0 ? part.foodDrinkCents * 1000 / part.revenueCents : null;
/** The 4 weeks before as one average week (their sums divided by 4). */
const averageWeek = (part: ResultPart): ResultPart => ({revenueCents: part.revenueCents / 4, revenueDays: part.revenueDays / 4, invoices: part.invoices / 4, purchasesCents: part.purchasesCents / 4,
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
    `nákup z faktur ${kc(week.purchasesCents)}, z toho jídlo a nápoje ${kc(week.foodDrinkCents)}${figures.foodCostPermille !== null ? ` = ${percent(figures.foodCostPermille)} tržby` : ''}${figures.beforeFoodCostPermille !== null ? ` (předtím ${percent(figures.beforeFoodCostPermille)})` : ''}`,
    `výplaty z kasy ${kc(week.payoutsCents)}`];
  if (week.expensesCents) parts.push(`výdaje z kasy ${kc(week.expensesCents)} navíc neodečtené (část jsou zaplacené faktury)`);
  return [`Výsledek týdne ${shortDate(result.from)}–${shortDate(result.to)} (tržba s DPH ${kc(week.revenueCents)} − nákup z faktur bez DPH − výplaty z kasy; bez nájmu, energií a mezd z účtu): ${parts.join(' · ')}`];
}
