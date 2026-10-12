import {CASH_DIFFERENCE_CENTS, crowns, mismatch, type Briefing} from './briefing.ts';

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
  if (briefing.reservations?.today.pending) warn(`Rezervace na dnešek čekající na potvrzení: ${briefing.reservations.today.pending}`);
  const reviews = briefing.reviews;
  if (reviews?.low) warn(`Slabé recenze (3 ★ a méně): ${reviews.low}`);
  if (reviews?.forManagement) warn(`Recenze čekají na vedení: ${reviews.forManagement}`);
  if (reviews?.failed) warn(`Odpovědi na recenze se nepodařilo odeslat: ${reviews.failed}`);
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
