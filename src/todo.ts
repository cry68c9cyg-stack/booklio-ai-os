import {addDays, weekday} from './time.ts';
import {promoStreakText} from './promo.ts';
import {cashForecastText, SURPLUS_CENTS} from './cashflow.ts';
import {cashDiffRepeatText, voidAndDiffText} from './voids.ts';
import {nightShareText, staffGapToday} from './wages.ts';
import {cashNeedText, debtsRising, debtsText, payoutAlarmText} from './cash.ts';
import {repeatedText, waitingText} from './mail-insights.ts';
import {gapsText, hasGaps, shiftSignals, shiftText} from './goals.ts';
import {conflictText, dueText, missingText, duplicateText, newSupplierText, paymentText, foodCostText, overdueText, receiptsText, riseText, unreadableText, unusualText} from './supplies.ts';
import {CASH_DIFFERENCE_CENTS, crowns, menuGapsText, mismatch, mismatchText, noShowAlarm, noShowText, pendingAheadText, themeTodos, reviewDrop, reviewDropText, unusual, weakDays, weakDaysText, webDropText, type Briefing} from './briefing.ts';

export type TodoItem = {level: 'warn' | 'info'; text: string; amountCents: number | null};
const LIMIT = 15;

/** "K vyřízení": deviations of the day, warnings first, each group by Kč (largest first), at most fifteen (specification §6.3). */
export function todoList(briefing: Briefing, reportWarnings: string[] = []): TodoItem[] {
  const items: TodoItem[] = [];
  const warn = (text: string, amountCents: number | null = null) => items.push({level: 'warn', text, amountCents});
  if (briefing.incomplete) warn(`Report za den chybí${briefing.missingClosings.length ? ` (uzávěrky: ${briefing.missingClosings.join(', ')})` : ''}.`);
  if (briefing.voids.afterPaymentCount) warn(`Storna po zaplacení: ${briefing.voids.afterPaymentCount}× ${crowns(briefing.voids.afterPaymentCents)}`, briefing.voids.afterPaymentCents);
  for (const row of briefing.cash.filter(row => row.differenceCents !== 0)) warn(`Rozdíl v hotovosti ${row.registerId}: ${row.differenceCents > 0 ? '+' : ''}${crowns(row.differenceCents)}`, row.differenceCents);
  if (briefing.report?.safeCents != null && briefing.report.safeCents < 0) warn(`Trezor je v deníku záporný: ${crowns(briefing.report.safeCents)}`, briefing.report.safeCents);
  const difference = briefing.report?.cashDifferenceCents ?? null;
  if (difference !== null && Math.abs(difference) >= CASH_DIFFERENCE_CENTS) warn(`Přepočet pokladny nesedí s deníkem: ${difference > 0 ? '+' : ''}${crowns(difference)}`, difference);
  for (const row of briefing.report?.journalMismatches ?? []) warn(`Tržba nesedí s deníkem, ${mismatch(row)}`, row.reportCents - row.journalCents);
  for (const row of briefing.report?.paymentMismatches ?? []) warn(`Platba nesedí s deníkem, ${mismatch(row)}`, row.reportCents - row.journalCents);
  // The managers' tables that do not add up (src/checks.ts): a wrong sum is a warning, a small cash difference or a sign to check is info.
  for (const check of briefing.tableChecks ?? []) items.push({level: check.level, text: `Tabulky: ${check.text}`, amountCents: check.amountCents});
  for (const text of themeTodos(briefing.noteThemes)) items.push({level: 'info', text, amountCents: null});
  if (briefing.cashNeed) warn(`Hotovost na dnešek nestačí: ${cashNeedText(briefing.cashNeed)}`, -briefing.cashNeed.shortCents);
  if (briefing.cashForecast && !briefing.cashForecast.firstShort && briefing.cashForecast.surplusCents >= SURPLUS_CENTS)
    items.push({level: 'info', text: `Hotovost nad potřebou týdne: asi ${crowns(briefing.cashForecast.surplusCents)} může na účet`, amountCents: briefing.cashForecast.surplusCents});
  if (briefing.cashForecast?.firstShort) items.push({level: 'info', text: `Hotovost na 7 dní: ${cashForecastText(briefing.cashForecast)}`, amountCents: briefing.cashForecast.depositCents});
  if (debtsRising(briefing.till)) warn(`Dluhy ve výčetce rostou: ${debtsText(briefing.till!)}`, briefing.till!.day.debtsCents! - briefing.till!.debtsWeekAgoCents!);
  if (briefing.payoutAlarm) warn(`Výplaty v hotovosti nad obvyklým: ${payoutAlarmText(briefing.payoutAlarm)}`, briefing.payoutAlarm.payoutsCents - briefing.payoutAlarm.usualCents);
  if (briefing.nightShare) warn(`Výplaty noci nad obvyklým podílem: ${nightShareText(briefing.nightShare)}`, briefing.nightShare.overCents);
  const staffGap = staffGapToday(addDays(briefing.businessDate, 1), briefing.staffGaps);
  if (staffGap) items.push({level: 'info', text: `Personál: ${staffGap}`, amountCents: null});
  if (briefing.voidAndDiff) warn(`Storna a rozdíl v kase: ${voidAndDiffText(briefing.voidAndDiff)}`, briefing.voidAndDiff.voidCents - briefing.voidAndDiff.usualCents);
  if (briefing.cashDiffRepeat) warn(`Kasa: ${cashDiffRepeatText(briefing.cashDiffRepeat)}`, briefing.cashDiffRepeat.reduce((sum, day) => sum + day.cents, 0));
  for (const streak of briefing.promoStreaks ?? []) warn(promoStreakText(streak), streak.days.reduce((sum, day) => sum + day.cents - day.usualCents, 0));
  for (const row of briefing.unusualDiscounts) warn(`Neobvyklá sleva: ${unusual(row)}`, row.amountCents - row.usualCents);
  if (noShowAlarm(briefing.noShows)) warn(`No-show: ${noShowText(briefing.noShows!)}`);
  if (briefing.week && weekday(briefing.businessDate) === 0 && reviewDrop(briefing.week)) warn(`Recenze klesají: ${reviewDropText(briefing.week)}`);
  for (const source of briefing.silent) warn(`${source.name} neposílá data od ${source.since}`);
  if (hasGaps(briefing.dataGaps)) warn(`Doplnit chybějící data za 14 dní: ${gapsText(briefing.dataGaps!)}`);
  if (briefing.reservations?.today.pending) warn(`Rezervace na dnešek čekající na potvrzení: ${briefing.reservations.today.pending}`);
  if (briefing.pendingAhead) warn(`Na příštích 7 dní ${pendingAheadText(briefing.pendingAhead)}`);
  const weak = weakDays(briefing.guestOutlook);
  if (weak.length) warn(`Slabší výhled, zvaž akci nebo kampaň: ${weakDaysText(weak, briefing.eventRanking)}`);
  // Shifts to strengthen or thin from the guests to expect (src/goals.ts): for planning, so info.
  for (const signal of shiftSignals(briefing.guestOutlook?.days)) items.push({level: 'info', text: `Směna: ${shiftText(signal)}`, amountCents: null});
  if (briefing.webDrop) warn(`Web: ${webDropText(briefing.webDrop)}`);
  const reviews = briefing.reviews;
  if (reviews?.low) warn(`Slabé recenze (3 ★ a méně): ${reviews.low}`);
  if (reviews?.forManagement) warn(`Recenze čekají na vedení: ${reviews.forManagement}`);
  if (reviews?.failed) warn(`Odpovědi na recenze se nepodařilo odeslat: ${reviews.failed}`);
  // Supplier invoices: each price rise of the week (weighted by what it cost on that purchase) and each overdue invoice.
  for (const rise of briefing.supplies?.rises ?? []) warn(`Zdražení: ${riseText(rise)}`, rise.extraCents);
  for (const row of briefing.supplies?.overdue ?? []) warn(`Faktura po splatnosti: ${overdueText(row)}`, row.grossCents);
  for (const row of briefing.supplies?.duplicates ?? []) warn(`Možná duplicitní faktura: ${duplicateText(row)}`, row.grossCents);
  for (const row of briefing.supplies?.unusual ?? []) warn(`Neobvyklý nákup: ${unusualText(row)}`, row.netCents);
  if (briefing.supplies?.foodCostAlert) warn(`${foodCostText(briefing.supplies.foodCostAlert)}.`);
  // Invoices to pay this week: not late yet, so info, but with their amount so nothing slips past its due date.
  for (const row of briefing.supplies?.newFromMail ?? []) warn(`Faktura z pošty od nového dodavatele, ověřit, než se zaplatí: ${newSupplierText(row)}`, row.grossCents);
  for (const row of briefing.supplies?.missing ?? []) warn(`Nepřišla obvyklá faktura, ověřit u dodavatele: ${missingText(row)}`, row.lastGrossCents);
  if (briefing.supplies?.receipts) items.push({level: 'info', text: `${receiptsText(briefing.supplies.receipts)}.`, amountCents: null});
  for (const row of briefing.supplies?.conflicts ?? []) warn(`Stejná faktura s jinou částkou, ověřit u dodavatele: ${conflictText(row)}`);
  if (briefing.supplies?.payments) items.push({level: 'info', text: `Připravit hromadnou platbu na ${paymentText(briefing.supplies.payments)}`, amountCents: briefing.supplies.payments.totalCents});
  for (const row of briefing.supplies?.dueSoon ?? []) items.push({level: 'info', text: `Zaplatit: ${dueText(row)}`, amountCents: row.grossCents});
  for (const row of briefing.mail?.insights.waiting ?? []) warn(`Odpovědět na e-mail: ${waitingText(row)}${row.summary ? ` – ${row.summary}` : ''}`);
  for (const text of briefing.mail?.insights.outOfControl.filter(text => text.includes('píše už')) ?? []) warn(`Pošta info@: ${text}`);
  for (const row of briefing.mail?.repeated ?? []) warn(`Pošta info@: ${repeatedText(row)}`);
  for (const row of briefing.supplies?.unreadable ?? []) items.push({level: 'info', text: `Doklad z pošty nešel přečíst: ${unreadableText(row)}`, amountCents: null});
  // Products the POS charges at another price than the menu: weighted by what it made the day's revenue differ.
  // One line for all of them, so a POS not yet repriced does not push the other warnings out of the list.
  const mismatches = briefing.priceMismatches ?? [];
  if (mismatches.length) warn(`Cena v pokladně nesedí s lístkem: ${mismatches.slice(0, 3).map(mismatchText).join(', ')}${mismatches.length > 3 ? ` a další ${mismatches.length - 3}` : ''}`,
    Math.round(mismatches.reduce((sum, row) => sum + row.quantity * Math.abs(row.posCents - row.menuCents), 0)));
  for (const text of briefing.menuProblems ?? []) warn(text);
  // Monday: the menu on the website lacks something guests read (not money, so after the warnings).
  if (briefing.menuGaps?.total) items.push({level: 'info', text: `Na webu opravit v lístku: ${menuGapsText(briefing.menuGaps)}`, amountCents: null});
  if (briefing.bottleCheckMissing) warn('Ranní kontrola lahví chybí.');
  for (const row of briefing.bottles?.losses ?? []) warn(`Manko ${row.name}: −${row.lossMl} ml (${crowns(row.lossCents)})`, row.lossCents);
  for (const point of briefing.notes?.points ?? []) items.push({level: point.kind === 'incident' || point.kind === 'problem' ? 'warn' : 'info', text: point.text, amountCents: point.amountCents});
  for (const text of reportWarnings) items.push({level: 'info', text, amountCents: null});
  // A missing report is always first; then by the size of the money involved; items without an amount keep their order.
  const weight = (item: TodoItem) => item.amountCents === null ? -1 : Math.abs(item.amountCents);
  const group = (level: TodoItem['level']) => items.filter(item => item.level === level).map((item, i) => ({item, i}))
    .sort((a, b) => (b.item.text.startsWith('Report za den chybí') ? 1 : 0) - (a.item.text.startsWith('Report za den chybí') ? 1 : 0) || weight(b.item) - weight(a.item) || a.i - b.i)
    .map(entry => entry.item);
  const sorted = [...group('warn'), ...group('info')];
  return sorted.length > LIMIT ? [...sorted.slice(0, LIMIT - 1), {level: 'info', text: `… a další ${sorted.length - LIMIT + 1}`, amountCents: null}] : sorted;
}
