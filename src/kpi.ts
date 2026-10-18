/**
 * Batch „KPI karta týdne“ (MC „jo“ 18. 10. 2026; chapter 9 of the master document: every KPI has a definition, an owner
 * and a reaction): on Monday the week's KPIs against the 4 weeks before, who answers for each and what to do when it got
 * worse. Spend per guest waits for Pexeso: guests without a booking are not in the data yet.
 */
const kc = (cents: number) => (cents < 0 ? '−' : '') + String(Math.round(Math.abs(cents) / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ') + ' Kč';
/** Basis points (hundredths of a per cent) as "0,4 %", to one decimal. */
const percent = (basisPoints: number) => `${String(Math.round(basisPoints / 10) / 10).replace('.', ',')} %`;
const share = (part: number, whole: number) => whole > 0 ? Math.round(part * 10000 / whole) : null;

/** What the week and the 4 weeks before add up to (the worker sums the days). */
export type KpiPart = {
  /** Days with revenue, and their revenue. */
  days: number; revenueCents: number;
  /** Voids and the revenue of the days with a daily report, and how many such days. */
  reportDays: number; voidCents: number; reportRevenueCents: number;
  promoCents: number; promoRevenueCents: number;
  /** Cash differences of the cash book, without their sign, and cash paid out of the till (wages and expenses) against the revenue of the same days. */
  cashDiffAbsCents: number; payoutsCents: number; payoutRevenueCents: number;
  guests: number; noShowGuests: number;
  /** Mail of info@ answered within 24 hours (promile), `null` without mail; only the week's is used. */
  mailWithin24Permille: number | null};
export type KpiInput = {from: string; to: string; week: KpiPart; before: KpiPart;
  /** Unpaid invoices past their due date today. */
  overdue: {count: number; grossCents: number}};

export type KpiRow = {key: string; name: string; owner: string; now: string; before: string | null; worse: boolean; action: string};

/** Each KPI with its definition in the name, the owner and the reaction; `before` is the average week of the 4 weeks before. */
export function kpiRows(input: KpiInput): KpiRow[] {
  const {week, before} = input, rows: KpiRow[] = [];
  const weeks = 4;
  if (week.revenueCents) {
    const usual = before.days && before.revenueCents ? Math.round(before.revenueCents / before.days * week.days) : null;
    rows.push({key: 'revenue', name: 'Tržba', owner: 'Matěj', now: kc(week.revenueCents), before: usual === null ? null : kc(usual),
      worse: usual !== null && week.revenueCents < usual * 0.9, action: 'projít slabé dny, akce a obsazení'});
  }
  const rate = (key: string, name: string, owner: string, nowShare: number | null, beforeShare: number | null, factor: number, minBasisPoints: number, action: string) => {
    if (nowShare === null) return;
    rows.push({key, name, owner, now: percent(nowShare), before: beforeShare === null ? null : percent(beforeShare),
      worse: beforeShare !== null && nowShare >= beforeShare * factor && nowShare - beforeShare >= minBasisPoints, action});
  };
  // Voids and promo come from the daily report only: compared once the weeks before have 14 days of it.
  const reported = before.reportDays >= 14;
  if (week.reportDays) {
    rate('voids', 'Storna z tržby', 'Matěj', share(week.voidCents, week.reportRevenueCents), reported ? share(before.voidCents, before.reportRevenueCents) : null, 1.25, 10, 'projít storna po dnech a kdo je dělal');
    rate('promo', 'Promo a odpisy z tržby', 'Matěj', share(week.promoCents, week.promoRevenueCents), reported ? share(before.promoCents, before.promoRevenueCents) : null, 1.25, 20, 'kdo promo a odpisy zapisuje a proč víc');
  }
  rate('payouts', 'Výplaty a výdaje z kasy z tržby', 'Matěj', share(week.payoutsCents, week.payoutRevenueCents), share(before.payoutsCents, before.payoutRevenueCents), 1.15, 50, 'směny a počet lidí proti tržbě');
  rate('noShows', 'Nepřišlí hosté z rezervovaných', 'Matěj', week.guests >= 20 ? share(week.noShowGuests, week.guests) : null, before.guests >= 20 ? share(before.noShowGuests, before.guests) : null, 1.25, 100, 'potvrzovat rezervace den předem');
  if (week.reportDays || week.cashDiffAbsCents) {
    const usual = Math.round(before.cashDiffAbsCents / weeks);
    rows.push({key: 'cashDiff', name: 'Rozdíly v kase (součet bez znaménka)', owner: 'Matěj', now: kc(week.cashDiffAbsCents), before: kc(usual),
      worse: week.cashDiffAbsCents >= usual * 1.5 && week.cashDiffAbsCents - usual >= 50000, action: 'přepočítávat kasu při předání směny'});
  }
  rows.push({key: 'reports', name: 'Dny s denním reportem', owner: 'Matěj', now: `${week.reportDays}/7`, before: null, worse: week.reportDays < 7,
    action: 'denní report každý den do 7:00 do složky OKO1 reporty'});
  // Mail is new (from April only for invoices), so it is held against a fixed bar instead of the weeks before.
  if (week.mailWithin24Permille !== null) rows.push({key: 'mail', name: 'E-maily info@ zodpovězené do 24 h', owner: 'Matěj', now: percent(week.mailWithin24Permille * 10), before: null,
    worse: week.mailWithin24Permille < 800, action: 'odpovídat do druhého dne (aspoň 80 %), návrhy odpovědí jsou v Poště info@'});
  rows.push({key: 'overdue', name: 'Faktury po splatnosti', owner: 'Nancy', now: input.overdue.count ? `${input.overdue.count}× ${kc(input.overdue.grossCents)}` : '0', before: null,
    worse: input.overdue.count > 0, action: 'zaplatit, nebo s dodavatelem domluvit odklad'});
  return rows;
}

/** Monday: one line with the values, then one line per KPI that got worse, with its owner and what to do. */
export function renderKpi(input: KpiInput | null | undefined): string[] {
  if (!input) return [];
  const rows = kpiRows(input);
  if (!rows.length) return [];
  const lines = [`KPI týdne (v závorce průměrný týden ze 4 předchozích): ${rows.map(row => `${row.name.toLowerCase()} ${row.now}${row.before !== null ? ` (${row.before})` : ''}`).join(' · ')}`];
  const worse = rows.filter(row => row.worse);
  if (worse.length) lines.push(`⚠ KPI horší: ${worse.map(row => `${row.name} ${row.now} – ${row.owner}: ${row.action}`).join(' · ')}`);
  return lines;
}
