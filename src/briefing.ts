import {DEFAULT_BOTTLE_LOSS_CENTS, type Bill, type BottleCheck, type CashClosing, type Reservation, type ReviewSummary, type TenantConfig, type WebTraffic} from './validate.ts';
import {weekday} from './time.ts';
import {line, total, type DailyReport} from './daily-report.ts';
import type {NotePoint, NotesAnalysis} from './notes.ts';

export type Briefing = {
  businessDate: string;
  revenueCents: number;
  bills: number;
  guests: number;
  averageBillCents: number | null;
  bySection: {section: string; label: string; revenueCents: number; bills: number}[];
  payments: {method: string; amountCents: number}[];
  discountsCents: number;
  cancelledBills: number;
  voids: {count: number; amountCents: number; afterPaymentCount: number; afterPaymentCents: number};
  cash: {registerId: string; differenceCents: number}[];
  missingClosings: string[];
  plan: {revenueCents: number; days: number} | null;
  topItems: {name: string; quantity: number; revenueCents: number}[];
  /** Morning bottle check: only meaningful losses, largest in CZK first. `null` = no check for this day. */
  bottles: {countedAt: string; checked: number; minLossCents: number; lossCents: number; losses: BottleLoss[]} | null;
  bottleCheckMissing: boolean;
  /** Where the revenue comes from: POS bills, the managers' daily report (interim), or nothing yet. */
  source: 'pos' | 'report' | 'none';
  /** Figures only the managers' report has today: cash expenses, cash payouts, safe, discount detail. */
  report: {expensesCents: number; payoutsCents: number; safeCents: number | null; cashDifferenceCents: number | null; discounts: {label: string; count: number | null; amountCents: number}[];
    /** Sections whose revenue in the daily report differs from the cash book's (both written by the managers). */
    journalMismatches: {section: string; label: string; reportCents: number; journalCents: number}[];
    /** Payment methods (cash, cards, customer cards) whose amount in the daily report differs from the cash book's. */
    paymentMismatches: {section: string; label: string; reportCents: number; journalCents: number}[]} | null;
  /** "Report dne": points from the analysis, or the raw text while it is not analysed. */
  notes: {points: NotePoint[]; summary: string | null; raw: string | null} | null;
  /** Bookings of the reported day and of the day that is starting. `null` = the reservation system sent nothing for either day. */
  reservations: {
    day: {confirmed: number; guests: number; arrived: number; noShows: number; noShowGuests: number; cancelled: number};
    today: {confirmed: number; guests: number; pending: number; bySection: {section: string; label: string; confirmed: number; guests: number}[]};
  } | null;
  /** The website on the reported calendar day, against the same weekday a week before. `null` = the website sent nothing. */
  web: {visits: number; withAction: number; lastWeekVisits: number | null; reservationsSent: number; reviewScans: number; topOrigins: {name: string; visits: number}[]} | null;
  /** Reviews that reached the website's admin on the reported calendar day, and how many wait there. `null` = nothing sent. */
  reviews: {newCount: number; averageTenths: number | null; low: number; bySource: {name: string; newCount: number}[]; waiting: number; forManagement: number; failed: number} | null;
  /** The 7 days up to the reported day against the 7 before: sums only. `null` = not asked for. */
  week: Week | null;
  /** The month so far (in the Monday message and on the dashboard), or the whole month on its last day. `null` = not asked for. */
  month: Month | null;
  /** Revenue of the same weekday a week before. `null` = no data for that day. */
  lastWeekRevenueCents: number | null;
  /** Discount types (staff, promo, write-offs…) far above their usual amount on this weekday. */
  unusualDiscounts: UnusualDiscount[];
  /** Sources that sent data before but have been silent too long (e.g. the website's hourly push). */
  silent: {name: string; since: string}[];
  /** Posted costs from accounting (iÚčto) against OKO1's revenue: this month so far, and the month before in its first half. */
  costs: MonthResult | null;
  costsPrevious: MonthResult | null;
  incomplete: boolean;
};
export type WeekPart = {revenueCents: number; revenueDays: number; reservations: number; guests: number; noShows: number; visits: number | null; visitDays: number; reviews: number; starsTenths: number | null};
export type MonthPart = {revenueCents: number; revenueDays: number; bySection: {section: string; label: string; revenueCents: number}[] | null};
/** Revenue of one month up to a day against the same days of the month before, and the cash the cash book paid out. */
export type Month = {
  month: string; through: string; complete: boolean; current: MonthPart; previous: MonthPart & {month: string; through: string};
  payouts: {label: string; amountCents: number}[]; payoutsCents: number;
  expenses: {label: string; amountCents: number}[]; expensesCents: number;
  discounts: {label: string; amountCents: number}[]; discountsCents: number;
};
/** Discounts by type summed over the same weekday of the previous weeks that have a managers' report (`days` of them). */
export type DiscountHistory = {days: number; totals: Record<string, number>};
export type UnusualDiscount = {key: string; label: string; amountCents: number; usualCents: number};
export type Week = {from: string; to: string; current: WeekPart; previous: WeekPart};
export type MonthResult = {
  month: string; through: string; rows: {account: string; name: string; amountCents: number}[];
  revenueCents: number; revenueDays: number; error: string | null;
};
const positive = (report: DailyReport, kind: 'expense' | 'payout') => report.lines.filter(entry => entry.kind === kind && entry.amountCents > 0).reduce((sum, entry) => sum + entry.amountCents, 0);

/** The daily report and the cash book should say the same revenue per section; any difference of a crown or more is shown. */
export const JOURNAL_MISMATCH_CENTS = 100;
function journalMismatches(report: DailyReport, names: Record<string, string>, reportKind: 'revenue_section' | 'payment' = 'revenue_section',
  journalKind: 'journal_revenue' | 'journal_payment' = 'journal_revenue', only: string[] | null = null, onBothSides = false): NonNullable<Briefing['report']>['journalMismatches'] {
  const wanted = (key: string) => !only || only.includes(key);
  const journal = report.lines.filter(entry => entry.kind === journalKind && wanted(entry.key));
  if (!journal.length) return [];
  const sum = (kind: string, key: string) => report.lines.filter(entry => entry.kind === kind && entry.key === key).reduce((total, entry) => total + entry.amountCents, 0);
  const reported = report.lines.filter(entry => entry.kind === reportKind && wanted(entry.key)).map(entry => entry.key);
  // Payments: a method only one of the two files has a row for (the report has no customer cards row) is not compared.
  const keys = onBothSides ? [...new Set(reported)].filter(key => journal.some(entry => entry.key === key)) : [...new Set([...reported, ...journal.map(entry => entry.key)])];
  const order = Object.keys(names);
  return keys.map(section => ({section, label: names[section] ?? section, reportCents: sum(reportKind, section), journalCents: sum(journalKind, section)}))
    .filter(row => Math.abs(row.reportCents - row.journalCents) >= JOURNAL_MISMATCH_CENTS)
    .sort((a, b) => (order.indexOf(a.section) + 1 || 99) - (order.indexOf(b.section) + 1 || 99) || a.section.localeCompare(b.section));
}

/** Counts bookings: the reported day (who came, who did not) and today's outlook (confirmed and still waiting). */
export function summarizeReservations(config: TenantConfig, day: Reservation[], today: Reservation[]): Briefing['reservations'] {
  if (!day.length && !today.length) return null;
  const confirmedDay = day.filter(row => row.status === 'confirmed');
  const noShows = confirmedDay.filter(row => row.arrival === 'no_show');
  const confirmedToday = today.filter(row => row.status === 'confirmed');
  const sections = new Map<string, {confirmed: number; guests: number}>();
  for (const row of confirmedToday) {
    const section = sections.get(row.section) ?? {confirmed: 0, guests: 0};
    section.confirmed++; section.guests += row.partySize; sections.set(row.section, section);
  }
  const order = Object.keys(config.sections);
  const guests = (rows: Reservation[]) => rows.reduce((sum, row) => sum + row.partySize, 0);
  return {
    day: {
      confirmed: confirmedDay.length, guests: guests(confirmedDay), arrived: confirmedDay.filter(row => row.arrival === 'arrived').length,
      noShows: noShows.length, noShowGuests: guests(noShows), cancelled: day.filter(row => row.status === 'cancelled').length,
    },
    today: {
      confirmed: confirmedToday.length, guests: guests(confirmedToday), pending: today.filter(row => row.status === 'pending').length,
      bySection: [...sections].map(([section, row]) => ({section, label: config.sections[section] ?? section, ...row}))
        .sort((a, b) => (order.indexOf(a.section) + 1 || 99) - (order.indexOf(b.section) + 1 || 99) || a.section.localeCompare(b.section)),
    },
  };
}
/** The website's day in a few numbers; reservations sent = visits that sent the booking form. */
export function summarizeWeb(day: WebTraffic | undefined, lastWeek: WebTraffic | undefined): Briefing['web'] {
  if (!day) return null;
  return {
    visits: day.visits, withAction: day.visitsWithAction, lastWeekVisits: lastWeek?.visits ?? null,
    reservationsSent: day.actions['rezervace-odeslana'] ?? 0, reviewScans: day.reviewScans,
    topOrigins: [...day.origins].sort((a, b) => b.visits - a.visits || a.key.localeCompare(b.key)).filter(row => row.visits > 0).slice(0, 3).map(({name, visits}) => ({name, visits})),
  };
}
/** New reviews of the day: count, average stars (tenths), how many have 3 ★ or less, per source; and what waits in the admin. */
export function summarizeReviews(day: ReviewSummary | undefined): Briefing['reviews'] {
  if (!day) return null;
  let rated = 0, starSum = 0, low = 0, unrated = 0;
  for (const source of day.sources) {
    source.stars.forEach((count, i) => { rated += count; starSum += count * (i + 1); if (i < 3) low += count; });
    unrated += source.unrated;
  }
  return {
    newCount: rated + unrated, averageTenths: rated ? Math.round(starSum / rated * 10) : null, low,
    bySource: day.sources.map(source => ({name: source.name, newCount: source.stars.reduce((sum, count) => sum + count, 0) + source.unrated})).filter(row => row.newCount > 0),
    waiting: day.waiting, forManagement: day.forManagement, failed: day.failed,
  };
}
export type BottleLoss = {name: string; lossMl: number; lossCents: number};

/**
 * Loss per bottle = expected − counted (surpluses are not netted against losses). CZK at purchase
 * price per litre. Only losses from the venue's threshold (default 100 Kč) are listed.
 */
export function bottleLosses(check: BottleCheck, minLossCents: number) {
  const all = check.items.map(item => {
    const lossMl = Math.max(0, item.expectedMl - item.countedMl);
    return {name: item.name, lossMl, lossCents: Math.round(lossMl * item.costPerLitreCents / 1000)};
  }).filter(row => row.lossMl > 0);
  return {
    lossCents: all.reduce((sum, row) => sum + row.lossCents, 0),
    losses: all.filter(row => row.lossCents > 0 && row.lossCents >= minLossCents).sort((a, b) => b.lossCents - a.lossCents || a.name.localeCompare(b.name, 'cs')),
  };
}

/** A discount type counts as unusual when it is at least twice its usual amount and at least 1 000 Kč above it. */
export const UNUSUAL_DISCOUNT_CENTS = 100000;
/**
 * Discount types of the day (staff, promo, write-offs…) far above their usual amount: the average of the same weekday
 * over the previous weeks that have a report (at least two). A type missing on such a day counts as zero.
 */
export function unusualDiscounts(report: DailyReport, history: DiscountHistory): UnusualDiscount[] {
  const days = history.days;
  if (days < 2) return [];
  const today = new Map<string, {label: string; amountCents: number}>();
  for (const entry of report.lines.filter(entry => entry.kind === 'discount' && entry.amountCents > 0)) {
    const row = today.get(entry.key) ?? {label: entry.label, amountCents: 0};
    row.amountCents += entry.amountCents; today.set(entry.key, row);
  }
  return [...today].map(([key, row]) => ({key, ...row, usualCents: Math.round((history.totals[key] ?? 0) / days)}))
    .filter(row => row.amountCents >= 2 * row.usualCents && row.amountCents - row.usualCents >= UNUSUAL_DISCOUNT_CENTS)
    .sort((a, b) => (b.amountCents - b.usualCents) - (a.amountCents - a.usualCents) || a.key.localeCompare(b.key));
}

/** Plan = average revenue of the same weekday over the previous weeks that have data (at least two). */
export function planFrom(history: {revenueCents: number}[]): Briefing['plan'] {
  if (history.length < 2) return null;
  return {revenueCents: Math.round(history.reduce((sum, row) => sum + row.revenueCents, 0) / history.length), days: history.length};
}

export function buildBriefing(input: {
  businessDate: string; config: TenantConfig; bills: Bill[]; closings: CashClosing[];
  planHistory: {revenueCents: number}[]; incomplete: boolean; bottleChecks?: BottleCheck[];
  report?: DailyReport | null; notes?: NotesAnalysis | null;
  reservations?: Reservation[]; reservationsToday?: Reservation[];
  web?: WebTraffic; webLastWeek?: WebTraffic;
  costs?: MonthResult | null; costsPrevious?: MonthResult | null;
  reviews?: ReviewSummary;
  week?: Week | null; silent?: {name: string; since: string}[];
  month?: Month | null; lastWeekRevenueCents?: number | null;
  discountHistory?: DiscountHistory;
}): Briefing {
  const closed = input.bills.filter(bill => bill.status === 'closed');
  const add = <K>(map: Map<K, number>, key: K, value: number) => map.set(key, (map.get(key) ?? 0) + value);
  const sections = new Map<string, {revenueCents: number; bills: number}>();
  const payments = new Map<string, number>();
  const items = new Map<string, {quantity: number; revenueCents: number}>();
  let revenueCents = 0, guests = 0, discountsCents = 0;
  const voids = {count: 0, amountCents: 0, afterPaymentCount: 0, afterPaymentCents: 0};
  for (const bill of input.bills) {
    for (const entry of bill.voids) {
      voids.count++; voids.amountCents += entry.amountCents;
      if (entry.afterPayment) { voids.afterPaymentCount++; voids.afterPaymentCents += entry.amountCents; }
    }
  }
  for (const bill of closed) {
    revenueCents += bill.totalCents; guests += bill.guests ?? 0; discountsCents += bill.discountCents;
    const section = sections.get(bill.section) ?? {revenueCents: 0, bills: 0};
    section.revenueCents += bill.totalCents; section.bills++; sections.set(bill.section, section);
    for (const payment of bill.payments) add(payments, payment.method, payment.amountCents);
    for (const item of bill.items) {
      const row = items.get(item.name) ?? {quantity: 0, revenueCents: 0};
      row.quantity += item.quantity; row.revenueCents += item.totalCents; items.set(item.name, row);
    }
  }
  const closedRegisters = new Set(input.closings.map(closing => closing.registerId));
  // A recount the same morning replaces the earlier one.
  const check = [...(input.bottleChecks ?? [])].sort((a, b) => b.countedAt.localeCompare(a.countedAt) || b.version - a.version)[0];
  const minLossCents = input.config.bottleCheck?.minLossCents ?? DEFAULT_BOTTLE_LOSS_CENTS;
  const order = Object.keys(input.config.sections);
  const report = input.report ?? null;
  // Until Pexeso runs, the managers' report is the only source of revenue; POS bills win as soon as there are any.
  const source = closed.length ? 'pos' : report && report.lines.some(entry => entry.kind === 'revenue_section') ? 'report' : 'none';
  if (source === 'report' && report) {
    for (const entry of report.lines.filter(entry => entry.kind === 'revenue_section')) {
      revenueCents += entry.amountCents;
      sections.set(entry.key, {revenueCents: entry.amountCents, bills: 0});
    }
    for (const entry of report.lines.filter(entry => entry.kind === 'payment')) add(payments, entry.key, entry.amountCents);
    discountsCents = line(report, 'total', 'discounts')?.amountCents ?? total(report, 'discount');
    const voided = report.lines.filter(entry => entry.kind === 'void');
    voids.count = voided.reduce((sum, entry) => sum + (entry.count ?? (entry.amountCents ? 1 : 0)), 0);
    voids.amountCents = total(report, 'void');
  }
  return {
    businessDate: input.businessDate,
    revenueCents, bills: closed.length, guests,
    averageBillCents: closed.length ? Math.round(revenueCents / closed.length) : null,
    bySection: [...sections].map(([section, row]) => ({section, label: input.config.sections[section] ?? section, ...row}))
      .sort((a, b) => (order.indexOf(a.section) + 1 || 99) - (order.indexOf(b.section) + 1 || 99) || a.section.localeCompare(b.section)),
    payments: [...payments].map(([method, amountCents]) => ({method, amountCents})).sort((a, b) => b.amountCents - a.amountCents),
    discountsCents,
    cancelledBills: input.bills.length - closed.length,
    voids,
    cash: input.closings.map(closing => ({registerId: closing.registerId, differenceCents: closing.countedCents - closing.expectedCents}))
      .sort((a, b) => a.registerId.localeCompare(b.registerId)),
    missingClosings: input.config.registers.filter(register => !closedRegisters.has(register)),
    plan: planFrom(input.planHistory),
    topItems: [...items].map(([name, row]) => ({name, ...row})).sort((a, b) => b.revenueCents - a.revenueCents || a.name.localeCompare(b.name)).slice(0, 5),
    bottles: check ? {countedAt: check.countedAt, checked: check.items.length, minLossCents, ...bottleLosses(check, minLossCents)} : null,
    bottleCheckMissing: !check && !!input.config.bottleCheck,
    source,
    report: report ? {
      expensesCents: positive(report, 'expense'), payoutsCents: positive(report, 'payout'), safeCents: line(report, 'balance', 'safe')?.amountCents ?? null, cashDifferenceCents: line(report, 'total', 'cash-difference')?.amountCents ?? null,
      discounts: report.lines.filter(entry => entry.kind === 'discount' && entry.amountCents > 0).sort((a, b) => b.amountCents - a.amountCents)
        .map(({label, count, amountCents}) => ({label, count, amountCents})),
      journalMismatches: journalMismatches(report, input.config.sections),
      paymentMismatches: journalMismatches(report, methods, 'payment', 'journal_payment', ['cash', 'card', 'customer_card'], true),
    } : null,
    notes: input.notes ? {points: input.notes.points, summary: input.notes.summary, raw: null}
      : report?.notes ? {points: [], summary: null, raw: report.notes} : null,
    reservations: summarizeReservations(input.config, input.reservations ?? [], input.reservationsToday ?? []),
    web: summarizeWeb(input.web, input.webLastWeek),
    reviews: summarizeReviews(input.reviews),
    costs: input.costs ?? null, costsPrevious: input.costsPrevious ?? null,
    week: input.week ?? null,
    month: input.month ?? null,
    lastWeekRevenueCents: input.lastWeekRevenueCents ?? null,
    unusualDiscounts: report ? unusualDiscounts(report, input.discountHistory ?? {days: 0, totals: {}}) : [],
    silent: input.silent ?? [],
    incomplete: input.incomplete,
  };
}

const days = ['neděle', 'pondělí', 'úterý', 'středa', 'čtvrtek', 'pátek', 'sobota'];
const methods: Record<string, string> = {cash: 'hotovost', card: 'karta', customer_card: 'zákaznická karta', voucher: 'poukaz', transfer: 'převod'};

/** Whole crowns with a space as the thousands separator: 84 320 Kč. */
export function crowns(cents: number): string {
  const sign = cents < 0 ? '−' : '';
  return sign + group(Math.round(Math.abs(cents) / 100)) + ' Kč';
}
const group = (value: number) => String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');

function czechDate(date: string): string {
  const [year, month, day] = date.split('-').map(Number);
  return `${days[weekday(date)]} ${day}. ${month}. ${year}`;
}

/** Plain text for WhatsApp or SMS. Short lines, warnings marked with ⚠. */
export function renderBriefing(name: string, briefing: Briefing): string {
  const lines = [`${name} · ${czechDate(briefing.businessDate)}`];
  if (briefing.incomplete) lines.push(`⚠ Report chybí${briefing.missingClosings.length ? ': ' + briefing.missingClosings.join(', ') : ''}. Čísla nemusí být konečná.`);
  for (const source of briefing.silent) lines.push(`⚠ ${source.name} neposílá data od ${source.since}.`);
  let revenue = `Tržba: ${crowns(briefing.revenueCents)}`;
  if (briefing.plan) {
    const delta = briefing.plan.revenueCents ? Math.round((briefing.revenueCents / briefing.plan.revenueCents - 1) * 100) : 0;
    revenue += ` (plán ${crowns(briefing.plan.revenueCents)}, ${delta >= 0 ? '+' : '−'}${Math.abs(delta)} %)`;
  }
  if (briefing.lastWeekRevenueCents && briefing.revenueCents && !briefing.incomplete) revenue += ` · před týdnem ${crowns(briefing.lastWeekRevenueCents)}${change(briefing.revenueCents, briefing.lastWeekRevenueCents)}`;
  lines.push(revenue);
  if (briefing.bySection.length > 1) lines.push(briefing.bySection.map(row => `${row.label} ${crowns(row.revenueCents)}`).join(' · '));
  if (briefing.source !== 'report') lines.push(`Účty ${briefing.bills} · hosté ${briefing.guests}${briefing.averageBillCents === null ? '' : ` · průměrný účet ${crowns(briefing.averageBillCents)}`}`);
  // Shares of what was paid in; a negative cash part (more on cards than the bill) is shown as an amount.
  const paid = briefing.payments.filter(row => row.amountCents > 0).reduce((sum, row) => sum + row.amountCents, 0);
  if (paid > 0) lines.push('Platby: ' + briefing.payments.map(row => `${methods[row.method] ?? row.method} ${row.amountCents < 0 ? crowns(row.amountCents) : `${Math.round(row.amountCents / paid * 100)} %`}`).join(', '));
  const control = [`slevy ${crowns(briefing.discountsCents)}`, `storna ${briefing.voids.count}× ${crowns(briefing.voids.amountCents)}`];
  if (briefing.cancelledBills) control.push(`zrušené účty ${briefing.cancelledBills}`);
  lines.push('Kontrola: ' + control.join(' · '));
  if (briefing.voids.afterPaymentCount) lines.push(`⚠ Storna po zaplacení: ${briefing.voids.afterPaymentCount}× ${crowns(briefing.voids.afterPaymentCents)}`);
  const differences = briefing.cash.filter(row => row.differenceCents !== 0);
  if (differences.length) lines.push('⚠ Rozdíl v hotovosti: ' + differences.map(row => `${row.registerId} ${row.differenceCents > 0 ? '+' : ''}${crowns(row.differenceCents)}`).join(', '));
  else if (briefing.cash.length) lines.push('Hotovost v pokladnách sedí.');
  if (briefing.topItems.length) lines.push('Nejvíc tržeb: ' + briefing.topItems.slice(0, 3).map(row => `${row.name} ${row.quantity}×`).join(', '));
  lines.push(...renderReport(briefing));
  lines.push(...renderBottles(briefing));
  lines.push(...renderReservations(briefing.reservations));
  lines.push(...renderWeb(briefing.web));
  lines.push(...renderReviews(briefing.reviews));
  lines.push(...renderCosts(briefing.costs, briefing.costsPrevious));
  lines.push(...renderNotes(briefing));
  // The week in a few numbers once a week, in the message about Sunday (Monday morning).
  if (weekday(briefing.businessDate) === 0) lines.push(...renderWeek(briefing.week));
  // The month so far once a week, and the whole month in the message about its last day (the 1st in the morning).
  lines.push(...renderMonth(briefing.month));
  return lines.join('\n');
}

const BOTTLE_LINES = 5;
/** Short bottle block: one line per meaningful loss, at most five, largest first. */
export function renderBottles(briefing: Pick<Briefing, 'bottles' | 'bottleCheckMissing'>): string[] {
  if (briefing.bottleCheckMissing) return ['⚠ Ranní kontrola lahví chybí.'];
  const bottles = briefing.bottles;
  if (!bottles) return [];
  if (!bottles.losses.length) return [`Lahve: ${bottles.checked} spočítáno, bez manka nad ${crowns(bottles.minLossCents)}.`];
  const shown = bottles.losses.slice(0, BOTTLE_LINES);
  return [
    `Lahve: manko ${crowns(bottles.lossCents)} (${bottles.checked} spočítáno)`,
    ...shown.map(row => `⚠ ${row.name} −${group(row.lossMl)} ml (${crowns(row.lossCents)})`),
    ...(bottles.losses.length > shown.length ? [`… a další ${bottles.losses.length - shown.length}`] : []),
  ];
}

export const CASH_DIFFERENCE_CENTS = 50000;
const count = (value: number | null) => value === null ? '' : `${value}× `;
/** Cash the POS does not see yet: expenses and payouts from the cash book, the safe, where discounts went. */
export function renderReport(briefing: Pick<Briefing, 'report' | 'unusualDiscounts'>): string[] {
  const report = briefing.report;
  if (!report) return [];
  const lines: string[] = [];
  if (report.discounts.length) lines.push('Slevy a odpisy: ' + report.discounts.slice(0, 3).map(row => `${row.label} ${count(row.count)}${crowns(row.amountCents)}`).join(', '));
  if (report.expensesCents || report.payoutsCents) lines.push(`Výdaje z kasy ${crowns(report.expensesCents)} · výplaty v hotovosti ${crowns(report.payoutsCents)}`);
  if (report.safeCents !== null && report.safeCents < 0) lines.push(`⚠ Trezor je v deníku záporný: ${crowns(report.safeCents)}`);
  // Coins and rounding make a few crowns of difference every day; from 500 Kč it is worth a look.
  if (report.cashDifferenceCents !== null && Math.abs(report.cashDifferenceCents) >= CASH_DIFFERENCE_CENTS)
    lines.push(`⚠ Přepočet pokladny nesedí se zůstatkem v deníku: ${report.cashDifferenceCents < 0 ? 'chybí' : 'přebývá'} ${crowns(Math.abs(report.cashDifferenceCents))}`);
  if (report.journalMismatches.length) lines.push('⚠ Tržba v reportu nesedí s deníkem: ' + report.journalMismatches.map(mismatch).join(', '));
  if (report.paymentMismatches.length) lines.push('⚠ Platby v reportu nesedí s deníkem: ' + report.paymentMismatches.map(mismatch).join(', '));
  if (briefing.unusualDiscounts.length) lines.push('⚠ Neobvyklé slevy: ' + briefing.unusualDiscounts.map(unusual).join(', '));
  return lines;
}

/** "Diner: report 45 200 Kč, deník 44 900 Kč" */
export const unusual = (row: UnusualDiscount) => `${row.label} ${crowns(row.amountCents)} (obvykle ${crowns(row.usualCents)})`;
export const mismatch = (row: NonNullable<Briefing['report']>['journalMismatches'][number]) => `${row.label}: report ${crowns(row.reportCents)}, deník ${crowns(row.journalCents)}`;

const NOTE_LINES = 3;
const marks: Record<NotePoint['kind'], string> = {incident: '⚠', problem: '⚠', task: '•', info: '•'};
const kinds: NotePoint['kind'][] = ['incident', 'problem', 'task', 'info'];
/** The most important points of "Report dne"; incidents and problems first. */
export function renderNotes(briefing: Pick<Briefing, 'notes'>): string[] {
  const notes = briefing.notes;
  if (!notes) return [];
  if (notes.raw) return [`Report dne: ${notes.raw.length > 280 ? notes.raw.slice(0, 279) + '…' : notes.raw}`.replace(/\s*\n\s*/g, ' / ')];
  if (!notes.points.length) return notes.summary ? [`Report dne: ${notes.summary}`] : [];
  const points = [...notes.points].sort((a, b) => kinds.indexOf(a.kind) - kinds.indexOf(b.kind));
  return ['Report dne:', ...points.slice(0, NOTE_LINES).map(point => `${marks[point.kind]} ${point.text}`),
    ...(notes.points.length > NOTE_LINES ? [`… a další ${notes.points.length - NOTE_LINES}`] : [])];
}

const guestsWord = (count: number) => count === 1 ? 'host' : count >= 2 && count <= 4 ? 'hosté' : 'hostů';
/** Two short lines: how the reported day's bookings turned out, and what is booked for the day that is starting. */
export function renderReservations(reservations: Briefing['reservations']): string[] {
  if (!reservations) return [];
  const {day, today} = reservations;
  let past = `Rezervace: ${day.confirmed} (${day.guests} ${guestsWord(day.guests)})`;
  if (day.noShows) past += `, nedorazilo ${day.noShows} (${day.noShowGuests} ${guestsWord(day.noShowGuests)})`;
  if (day.cancelled) past += `, zrušeno ${day.cancelled}`;
  let next = `Dnes rezervováno: ${today.confirmed} (${today.guests} ${guestsWord(today.guests)})`;
  if (today.bySection.length > 1) next += ' · ' + today.bySection.map(row => `${row.label} ${row.confirmed}`).join(' · ');
  if (today.pending) next += `, čeká na potvrzení ${today.pending}`;
  return [past, next];
}

const visitsWord = (count: number) => count === 1 ? 'návštěva' : count >= 2 && count <= 4 ? 'návštěvy' : 'návštěv';
/** The website's day: visits against a week before, what visitors did, and where most of them came from. */
export function renderWeb(web: Briefing['web']): string[] {
  if (!web) return [];
  let line = `Web: ${group(web.visits)} ${visitsWord(web.visits)}`;
  if (web.lastWeekVisits !== null) {
    const change = web.lastWeekVisits ? `, ${web.visits >= web.lastWeekVisits ? '+' : '−'}${Math.round(Math.abs(web.visits - web.lastWeekVisits) / web.lastWeekVisits * 100)} %` : '';
    line += ` (před týdnem ${group(web.lastWeekVisits)}${change})`;
  }
  line += `, ${group(web.withAction)} s rezervací, telefonem nebo navigací, odeslané rezervace ${web.reservationsSent}`;
  if (web.reviewScans) line += `, QR na recenze ${web.reviewScans}×`;
  return web.topOrigins.length ? [line, 'Odkud: ' + web.topOrigins.map(row => `${row.name} ${group(row.visits)}`).join(' · ')] : [line];
}

const reviewsWord = (count: number) => count === 1 ? 'nová' : count >= 2 && count <= 4 ? 'nové' : 'nových';
/** Reviews in one line: new ones with their average and the weak ones, then what waits in the website's admin. Nothing when all is quiet. */
export function renderReviews(reviews: Briefing['reviews']): string[] {
  if (!reviews || (!reviews.newCount && !reviews.waiting && !reviews.forManagement && !reviews.failed)) return [];
  let line = 'Recenze: ' + (reviews.newCount ? `${reviews.newCount} ${reviewsWord(reviews.newCount)}` : 'žádná nová');
  if (reviews.averageTenths !== null) line += `, průměr ${(reviews.averageTenths / 10).toFixed(1).replace('.', ',')} ★`;
  if (reviews.bySource.length > 1) line += ` (${reviews.bySource.map(row => `${row.name} ${row.newCount}`).join(' · ')})`;
  else if (reviews.bySource.length === 1) line += ` (${reviews.bySource[0].name})`;
  if (reviews.low) line += `, ${reviews.low}× 3 ★ a méně`;
  const admin = [reviews.waiting && `čeká na odpověď ${reviews.waiting}`, reviews.forManagement && `pro vedení ${reviews.forManagement}`,
    reviews.failed && `neodeslané odpovědi ${reviews.failed}`].filter(Boolean);
  if (admin.length) line += `; v adminu ${admin.join(', ')}`;
  return [line];
}

/** Change in whole per cent, with its sign; empty when there is nothing to compare with. */
const change = (now: number, before: number) => before ? ` (${now >= before ? '+' : '−'}${Math.round(Math.abs(now - before) / before * 100)} %)` : '';
const daysWord = (count: number) => `${count} ${count === 1 ? 'den' : count >= 2 && count <= 4 ? 'dny' : 'dní'}`;
const shortDate = (date: string) => `${Number(date.slice(8))}. ${Number(date.slice(5, 7))}.`;
/** The 7 days up to the reported day against the 7 before: revenue, bookings, no-shows, website, reviews. */
export function renderWeek(week: Briefing['week']): string[] {
  if (!week) return [];
  const {current: now, previous: before} = week;
  // Changes only against a week with data for as many days; otherwise the per cent would compare different lengths.
  const same = before.revenueDays === now.revenueDays;
  const parts: string[] = [];
  if (now.revenueDays) {
    const notes = [same ? change(now.revenueCents, before.revenueCents).slice(2, -1) : '', now.revenueDays < 7 ? `${daysWord(now.revenueDays)} s daty` : ''].filter(Boolean);
    parts.push(`tržba ${crowns(now.revenueCents)}${notes.length ? ` (${notes.join(', ')})` : ''}`);
  }
  if (now.reservations || before.reservations) parts.push(`rezervace ${now.reservations}, ${now.guests} ${guestsWord(now.guests)}${change(now.guests, before.guests)}${now.noShows ? `, nedorazilo ${now.noShows}` : ''}`);
  if (now.visits !== null) parts.push(`web ${group(now.visits)} ${visitsWord(now.visits)}${before.visits !== null && before.visitDays === now.visitDays ? change(now.visits, before.visits) : ''}`);
  if (now.reviews) parts.push(`recenze ${now.reviews}${now.starsTenths !== null ? `, průměr ${(now.starsTenths / 10).toFixed(1).replace('.', ',')} ★` : ''}`);
  return parts.length ? [`Týden ${shortDate(week.from)}–${shortDate(week.to)}: ${parts.join(' · ')}`] : [];
}

/** "Říjen: tržba … (+4 % proti září) · Diner … · výplaty v hotovosti … · výdaje z kasy …" */
export function renderMonth(month: Briefing['month']): string[] {
  if (!month || !month.current.revenueDays) return [];
  const {current: now, previous: before} = month;
  const name = monthName(month.month), title = name[0].toUpperCase() + name.slice(1);
  // A change only between stretches with the same coverage: as many days with data, or every day of each.
  const full = (part: MonthPart, through: string) => part.revenueDays === Number(through.slice(8));
  const comparable = before.revenueCents > 0 && (before.revenueDays === now.revenueDays || (full(now, month.through) && full(before, before.through)));
  const against = month.complete ? monthName(before.month) : `${shortDate(before.month + '-01')}–${shortDate(before.through)}`;
  const notes = [comparable ? `${change(now.revenueCents, before.revenueCents).slice(2, -1)} proti ${against}` : '',
    now.revenueDays < Number(month.through.slice(8)) ? `${daysWord(now.revenueDays)} s daty` : ''].filter(Boolean);
  const parts = [`tržba ${crowns(now.revenueCents)}${notes.length ? ` (${notes.join(', ')})` : ''}`];
  if (now.bySection && now.bySection.length > 1) parts.push(now.bySection.map(row => `${row.label} ${crowns(row.revenueCents)}`).join(' · '));
  if (month.payoutsCents) parts.push(`výplaty v hotovosti ${crowns(month.payoutsCents)}`);
  if (month.expensesCents) parts.push(`výdaje z kasy ${crowns(month.expensesCents)}`);
  if (month.discountsCents) parts.push(`slevy ${crowns(month.discountsCents)}`);
  return [`${title}${month.complete ? ' celkem' : ` do ${shortDate(month.through)}`}: ${parts.join(' · ')}`];
}

const MONTHS = ['leden', 'únor', 'březen', 'duben', 'květen', 'červen', 'červenec', 'srpen', 'září', 'říjen', 'listopad', 'prosinec'];
const monthName = (month: string) => MONTHS[Number(month.slice(5, 7)) - 1] ?? month;
const COST_LINES = 3;
/**
 * Costs from accounting: the month so far (largest accounts) and revenue − costs; the month before while invoices
 * for it still arrive. Accounting lags behind, so the costs are "posted so far", never a final result.
 */
export function renderCosts(costs: MonthResult | null, previous: MonthResult | null): string[] {
  if (!costs) return [];
  const lines: string[] = [];
  const total = (month: MonthResult) => month.rows.reduce((sum, row) => sum + row.amountCents, 0);
  const result = (month: MonthResult) => `tržby ${crowns(month.revenueCents)} − náklady ${crowns(total(month))} = ${crowns(month.revenueCents - total(month))}`;
  const day = Number(costs.through.slice(8, 10)), monthOf = Number(costs.through.slice(5, 7));
  if (costs.rows.length) {
    const top = costs.rows.slice(0, COST_LINES).map(row => `${row.name} ${crowns(row.amountCents)}`).join(' · ');
    lines.push(`Náklady ${monthName(costs.month)} do ${day}. ${monthOf}. (zaúčtované): ${crowns(total(costs))} · ${top}`);
    lines.push(`${monthName(costs.month)[0].toUpperCase()}${monthName(costs.month).slice(1)} zatím: ${result(costs)}`);
  } else if (!costs.error) lines.push(`Náklady ${monthName(costs.month)}: zatím nic zaúčtováno.`);
  if (previous?.rows.length) lines.push(`${monthName(previous.month)[0].toUpperCase()}${monthName(previous.month).slice(1)} celkem: ${result(previous)}`);
  if (costs.error) lines.push(`⚠ Náklady z iÚčta se dnes nepodařilo načíst (${costs.error})${costs.rows.length || previous?.rows.length ? ', čísla jsou z posledního načtení' : ''}.`);
  return lines;
}
