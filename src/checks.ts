/**
 * Checks of the managers' tables (MC, 18. 10. 2026: "podívej se, jestli tabulky sedí a není v nich žádná chyba"): sums that
 * the files state against the rows they sum, the cash count against the journal, the journal's opening balance against
 * the day before. Only what the files say; nothing is corrected, every finding goes to the morning message and the to-do list.
 */
import {JOURNAL_LABEL, line, type DailyReport, type ReportLine} from './daily-report.ts';

export type TableCheck = {level: 'warn' | 'info'; text: string; amountCents: number | null};

/** Differences under 1 Kč are rounding (cards are kept in haléře in the journal). */
const TOLERANCE_CENTS = 100;
/** From 500 Kč the briefing already warns about the cash count (CASH_DIFFERENCE_CENTS); below it the check says it once. */
const COUNT_WARNING_CENTS = 50000;
/** Money received into the till that is expected: deposits, withdrawals, advances, sales. Anything else negative is worth a look. */
const RECEIVED = /^(vklad|odvod|zaloh|vyber|prodej|vratk|dobropis|trzba|pocatecni)/;

const kc = (cents: number) => {
  const sign = cents < 0 ? '−' : '';
  return sign + String(Math.round(Math.abs(cents) / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ') + ' Kč';
};
const signed = (cents: number) => (cents > 0 ? '+' : '') + kc(cents);
const plain = (value: string) => value.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const fromReport = (entry: ReportLine) => !entry.label.startsWith(JOURNAL_LABEL);
const sum = (lines: ReportLine[]) => lines.reduce((total, entry) => total + entry.amountCents, 0);
const off = (a: number, b: number) => Math.abs(a - b) >= TOLERANCE_CENTS;

/** The findings of one day; `previous` is the report of the day before (for the journal's opening balance). */
export function tableChecks(report: DailyReport | null, previous: DailyReport | null = null): TableCheck[] {
  if (!report) return [];
  const checks: TableCheck[] = [];
  const warn = (text: string, amountCents: number | null) => checks.push({level: 'warn', text, amountCents});
  const lines = report.lines;

  // The promo line of the report against the promo discounts listed below it.
  const promo = line(report, 'total', 'promo');
  const promoLines = lines.filter(entry => entry.kind === 'discount' && entry.key.startsWith('promo'));
  if (promo && promoLines.length && off(promo.amountCents, sum(promoLines)))
    warn(`Promo v denním reportu ${kc(promo.amountCents)} nesedí se součtem promo slev ${kc(sum(promoLines))}`, promo.amountCents - sum(promoLines));

  // The discount total against its rows.
  const discounts = line(report, 'total', 'discounts'), discountLines = lines.filter(entry => entry.kind === 'discount');
  if (discounts && discountLines.length && off(discounts.amountCents, sum(discountLines)))
    warn(`Slevy celkem ${kc(discounts.amountCents)} nesedí se součtem řádků slev ${kc(sum(discountLines))}`, discounts.amountCents - sum(discountLines));

  // The club total against its registers and Texaco, both from the daily report.
  const club = lines.find(entry => entry.kind === 'revenue_section' && entry.key === 'club' && fromReport(entry));
  const registers = lines.filter(entry => entry.kind === 'revenue_register' && fromReport(entry));
  if (club && registers.length && off(club.amountCents, sum(registers)))
    warn(`Club celkem ${kc(club.amountCents)} nesedí se součtem pokladen a Texaca ${kc(sum(registers))}`, club.amountCents - sum(registers));

  // "Celkem podle výjezdů" against the sections, and against cash plus cards.
  const payments = lines.find(entry => entry.kind === 'total' && entry.key === 'payments' && fromReport(entry));
  const sections = lines.filter(entry => entry.kind === 'revenue_section' && fromReport(entry));
  if (payments && sections.length && off(payments.amountCents, sum(sections)))
    warn(`Celkem podle výjezdů ${kc(payments.amountCents)} nesedí se součtem částí ${kc(sum(sections))}`, payments.amountCents - sum(sections));
  const paid = lines.filter(entry => entry.kind === 'payment' && fromReport(entry));
  if (payments && paid.length >= 2 && off(payments.amountCents, sum(paid)))
    warn(`Celkem podle výjezdů ${kc(payments.amountCents)} nesedí s hotovostí a kartami ${kc(sum(paid))}`, payments.amountCents - sum(paid));

  // The evening cash count: no negative amount, and small differences from the journal said once (from 500 Kč the briefing warns).
  for (const entry of lines.filter(entry => entry.kind === 'cash_count' && entry.amountCents < 0 && entry.key !== 'celkem'))
    warn(`Ve výčetce hotovosti je záporná částka: ${entry.label} ${kc(entry.amountCents)}`, entry.amountCents);
  const difference = line(report, 'total', 'cash-difference')?.amountCents ?? null;
  if (difference !== null && difference !== 0 && Math.abs(difference) >= TOLERANCE_CENTS && Math.abs(difference) < COUNT_WARNING_CENTS)
    checks.push({level: 'info', text: `Výčetka hotovosti se liší od zůstatku v deníku o ${signed(difference)}`, amountCents: difference});

  // The journal's opening balance against yesterday's closing one.
  const opening = line(report, 'balance', 'register-start'), closing = previous ? line(previous, 'balance', 'register') : null;
  if (opening && closing && off(opening.amountCents, closing.amountCents))
    warn(`Počáteční stav deníku ${kc(opening.amountCents)} nesedí se včerejším zůstatkem ${kc(closing.amountCents)}`, opening.amountCents - closing.amountCents);

  // Cash that came into the till without being a deposit or a sale: often a purchase written with the wrong sign.
  for (const entry of lines.filter(entry => entry.kind === 'movement' && entry.amountCents < 0 && !RECEIVED.test(plain(entry.label))))
    checks.push({level: 'info', text: `V deníku je „${entry.label}“ ${kc(entry.amountCents)} jako příjem do kasy; jestli to byl nákup, má být kladně`, amountCents: entry.amountCents});
  return checks;
}
