/**
 * Batch „Rizikové skóre mank“ (MC „jo“ 18. 10. 2026; module 5 of the master document, detection of shrinkage): the signals
 * the morning message already finds for a day (voids after payment, voids with a cash difference, a cash difference that
 * keeps coming back, the cash count against the cash book, the report against the cash book, unusual discounts, promo over
 * its usual, rising IOUs, tables that do not add up, negative cash in the revenue) summed into one score of 0 to 100, with
 * what each part means to check. Nothing here accuses anyone: a high score says which day to look at first.
 */
import type {Briefing} from './briefing.ts';
import {debtsRising} from './cash.ts';
import {weekday} from './time.ts';

const kc = (cents: number) => (cents < 0 ? '−' : '') + String(Math.round(Math.abs(cents) / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ') + ' Kč';
const signed = (cents: number) => (cents > 0 ? '+' : '') + kc(cents);
const shortDate = (date: string) => `${Number(date.slice(8))}. ${Number(date.slice(5, 7))}.`;
const WEEKDAYS_SHORT = ['ne', 'po', 'út', 'st', 'čt', 'pá', 'so'];

/** From this score the day gets a warning and goes to the to-do list. */
export const RISK_HIGH = 50;
/** Under this score the day is not worth a line every morning (5 Kč of card tips or one table check); Monday still lists it. */
export const RISK_SHOWN = 20;

/** One part of the score: its points, what was found, and what to check. */
export type RiskReason = {points: number; text: string; check: string};
export type Risk = {date: string; score: number; reasons: RiskReason[]};

/** The fields of the morning message the score reads (a lighter briefing for past days has the same ones). */
export type RiskInput = Pick<Briefing, 'businessDate' | 'voids' | 'report' | 'unusualDiscounts' | 'promoStreaks' | 'cashDiffRepeat' | 'voidAndDiff' | 'till' | 'tableChecks'>;

export function riskScore(briefing: RiskInput): Risk {
  const reasons: RiskReason[] = [];
  const add = (points: number, text: string, check: string) => { if (points > 0) reasons.push({points, text, check}); };
  if (briefing.voids.afterPaymentCount) add(25, `storna po zaplacení ${briefing.voids.afterPaymentCount}× ${kc(briefing.voids.afterPaymentCents)}`, 'kdo stornoval po zaplacení a proč');
  if (briefing.voidAndDiff) add(30, `storna ${kc(briefing.voidAndDiff.voidCents)} nad obvyklým a zároveň rozdíl v kase ${signed(briefing.voidAndDiff.cashDiffCents)}`, 'projít storna toho dne');
  if (briefing.cashDiffRepeat) add(20, `rozdíl v kase ${briefing.cashDiffRepeat.length}× za 7 dní`, 'kdo měl kasu ve dnech s rozdílem');
  const difference = briefing.report?.cashDifferenceCents ?? null;
  if (difference !== null && Math.abs(difference) >= 50000) add(Math.abs(difference) >= 200000 ? 25 : 15, `přepočet kasy proti deníku ${signed(difference)}`, 'přepočítat kasu a doklady toho dne');
  const mismatches = (briefing.report?.journalMismatches.length ?? 0) + (briefing.report?.paymentMismatches.length ?? 0);
  if (mismatches) add(15, `report nesedí s deníkem (${mismatches}×)`, 'porovnat report s deníkem');
  if (briefing.unusualDiscounts.length) add(Math.min(20, 10 * briefing.unusualDiscounts.length), `neobvyklé slevy: ${briefing.unusualDiscounts.map(row => row.label).join(', ')}`, 'kdo slevy dal a komu');
  if (briefing.promoStreaks?.length) add(Math.min(20, 10 * briefing.promoStreaks.length), `promo nebo odpis 3 dny nad obvyklým: ${briefing.promoStreaks.map(streak => `${streak.kind === 'promo' ? 'Promo' : 'Odpis'} ${streak.place}`).join(', ')}`, 'kdo promo a odpisy zapisuje');
  if (debtsRising(briefing.till)) add(10, `dluhy ve výčetce rostou na ${kc(briefing.till!.day.debtsCents!)}`, 'kdo dluží a kdy vrátí');
  const tables = (briefing.tableChecks ?? []).filter(check => check.level === 'warn').length;
  if (tables) add(Math.min(10, 5 * tables), `tabulky nesedí (${tables}×)`, 'opravit tabulky');
  if ((briefing.till?.day.tipsCents ?? 0) >= 500000) add(5, `záporná hotovost v tržbě ${kc(briefing.till!.day.tipsCents)}`, 'spropitné z karet vyplácet podle záznamu');
  reasons.sort((a, b) => b.points - a.points);
  return {date: briefing.businessDate, score: Math.min(100, reasons.reduce((sum, reason) => sum + reason.points, 0)), reasons};
}

/** "Riziko mank: 45 ze 100 · storna 4 000 Kč nad obvyklým a zároveň rozdíl v kase −250 Kč (30): projít storna toho dne · …" */
export const riskText = (risk: Risk) =>
  `${risk.score} ze 100 · ${risk.reasons.map(reason => `${reason.text} (${reason.points}): ${reason.check}`).join(' · ')}`;
export function renderRisk(risk: Risk | null | undefined): string[] {
  if (!risk || risk.score < RISK_SHOWN) return [];
  return [`${risk.score >= RISK_HIGH ? '⚠ ' : ''}Riziko mank: ${riskText(risk)}`];
}

/** Monday: "Riziko mank za týden: so 17. 10. 55 (storna nad obvyklým…), pá 16. 10. 15 (…); ostatní dny 0" */
export function renderRiskWeek(days: Risk[] | null | undefined): string[] {
  if (!days?.length) return [];
  const scored = days.filter(day => day.score > 0).sort((a, b) => b.score - a.score || b.date.localeCompare(a.date));
  if (!scored.length) return [`Riziko mank za týden: všech ${days.length} dní 0 ze 100`];
  const shown = scored.slice(0, 3).map(day => `${WEEKDAYS_SHORT[weekday(day.date)]} ${shortDate(day.date)} ${day.score} (${day.reasons.map(reason => reason.text).join('; ')})`);
  const rest = days.length - scored.length;
  return [`Riziko mank za týden: ${shown.join(', ')}${scored.length > 3 ? ` a další ${scored.length - 3} dny` : ''}${rest ? `; ostatní dny 0` : ''}`];
}
