import {DEFAULT_BOTTLE_LOSS_CENTS, type Bill, type BottleCheck, type CashClosing, type TenantConfig} from './validate.ts';
import {weekday} from './time.ts';

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
  incomplete: boolean;
};
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

/** Plan = average revenue of the same weekday over the previous weeks that have data (at least two). */
export function planFrom(history: {revenueCents: number}[]): Briefing['plan'] {
  if (history.length < 2) return null;
  return {revenueCents: Math.round(history.reduce((sum, row) => sum + row.revenueCents, 0) / history.length), days: history.length};
}

export function buildBriefing(input: {
  businessDate: string; config: TenantConfig; bills: Bill[]; closings: CashClosing[];
  planHistory: {revenueCents: number}[]; incomplete: boolean; bottleChecks?: BottleCheck[];
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
    incomplete: input.incomplete,
  };
}

const days = ['neděle', 'pondělí', 'úterý', 'středa', 'čtvrtek', 'pátek', 'sobota'];
const methods: Record<string, string> = {cash: 'hotovost', card: 'karta', voucher: 'poukaz', transfer: 'převod'};

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
  if (briefing.incomplete) lines.push(`⚠ Uzávěrka chybí${briefing.missingClosings.length ? ': ' + briefing.missingClosings.join(', ') : ''}. Čísla nemusí být konečná.`);
  let revenue = `Tržba: ${crowns(briefing.revenueCents)}`;
  if (briefing.plan) {
    const delta = briefing.plan.revenueCents ? Math.round((briefing.revenueCents / briefing.plan.revenueCents - 1) * 100) : 0;
    revenue += ` (plán ${crowns(briefing.plan.revenueCents)}, ${delta >= 0 ? '+' : '−'}${Math.abs(delta)} %)`;
  }
  lines.push(revenue);
  if (briefing.bySection.length > 1) lines.push(briefing.bySection.map(row => `${row.label} ${crowns(row.revenueCents)}`).join(' · '));
  lines.push(`Účty ${briefing.bills} · hosté ${briefing.guests}${briefing.averageBillCents === null ? '' : ` · průměrný účet ${crowns(briefing.averageBillCents)}`}`);
  const paid = briefing.payments.reduce((sum, row) => sum + row.amountCents, 0);
  if (paid > 0) lines.push('Platby: ' + briefing.payments.map(row => `${methods[row.method] ?? row.method} ${Math.round(row.amountCents / paid * 100)} %`).join(', '));
  const control = [`slevy ${crowns(briefing.discountsCents)}`, `storna ${briefing.voids.count}× ${crowns(briefing.voids.amountCents)}`];
  if (briefing.cancelledBills) control.push(`zrušené účty ${briefing.cancelledBills}`);
  lines.push('Kontrola: ' + control.join(' · '));
  if (briefing.voids.afterPaymentCount) lines.push(`⚠ Storna po zaplacení: ${briefing.voids.afterPaymentCount}× ${crowns(briefing.voids.afterPaymentCents)}`);
  const differences = briefing.cash.filter(row => row.differenceCents !== 0);
  if (differences.length) lines.push('⚠ Rozdíl v hotovosti: ' + differences.map(row => `${row.registerId} ${row.differenceCents > 0 ? '+' : ''}${crowns(row.differenceCents)}`).join(', '));
  else if (briefing.cash.length) lines.push('Hotovost v pokladnách sedí.');
  if (briefing.topItems.length) lines.push('Nejvíc tržeb: ' + briefing.topItems.slice(0, 3).map(row => `${row.name} ${row.quantity}×`).join(', '));
  lines.push(...renderBottles(briefing));
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
