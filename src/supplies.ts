/**
 * Supplier invoices (record `supplier_invoice`, docs/ingest-v1.md): what the venue buys, from whom and at what price.
 * The interim sender is Dishboard (decision of MC, 13. 10. 2026: a temporary input, later replaced, most likely by
 * Pexeso); any sender may use the same record, so the next source only fills the same place. Each sender has its
 * `source`, and the venue's `disabledSources` switches one off without touching the rest of OKO1.
 */
import {COST_KINDS, type SupplierInvoice} from './validate.ts';
import {addDays} from './time.ts';

/** A supplier raised the price of an item when its unit price is at least 5 % above the purchase before. */
export const PRICE_RISE_PERMILLE = 50;

export type CostKind = typeof COST_KINDS[number];
export const COST_KIND_NAMES: Record<CostKind, string> = {food: 'jídlo', beverage: 'nápoje', other: 'ostatní'};

export type PriceRise = {date: string; supplier: string; name: string; unit: string | null; oldCents: number; newCents: number; permille: number;
  /** What the rise cost on this purchase: (new − old) × quantity, in haléře. */
  extraCents: number};
export type OverdueInvoice = {supplier: string; number: string | null; dueDate: string; days: number; grossCents: number};
export type SupplySummary = {
  from: string; to: string; invoices: number; netCents: number; grossCents: number;
  byKind: {kind: CostKind; name: string; netCents: number}[];
  byCategory: {name: string; netCents: number}[];
  bySupplier: {name: string; netCents: number; invoices: number}[];
  /** Food and drink bought (without VAT) per revenue with VAT over the same days, in per mille; null without revenue. */
  foodCostPermille: number | null; revenueCents: number; revenueDays: number;
};
/** For the morning message, the to-do list and the dashboard: the month so far, recent price rises and overdue invoices. */
export type SupplyBrief = {month: SupplySummary; rises: PriceRise[]; overdue: OverdueInvoice[]; sources: string[]};

/** The invoices that count: not cancelled and not from a switched-off sender. */
export const counted = (invoices: SupplierInvoice[], disabled: string[]) => invoices.filter(invoice => invoice.status !== 'cancelled' && !disabled.includes(invoice.source));

/** Costs of the invoices issued in `from`–`to` by kind, category and supplier, and food cost against the revenue of those days. */
export function supplySummary(invoices: SupplierInvoice[], from: string, to: string, revenue: {revenueCents: number; revenueDays: number}): SupplySummary {
  const inRange = invoices.filter(invoice => invoice.businessDate >= from && invoice.businessDate <= to);
  const kinds = new Map<CostKind, number>(), categories = new Map<string, number>(), suppliers = new Map<string, {netCents: number; invoices: number}>();
  const add = <K>(map: Map<K, number>, key: K, cents: number) => map.set(key, (map.get(key) ?? 0) + cents);
  for (const invoice of inRange) {
    // Items carry their own kind and category when the sender knows them; the rest of the invoice falls to the invoice's.
    let itemized = 0;
    for (const item of invoice.items) {
      add(kinds, item.kind ?? invoice.kind, item.netCents);
      add(categories, item.category ?? invoice.category ?? COST_KIND_NAMES[item.kind ?? invoice.kind], item.netCents);
      itemized += item.netCents;
    }
    const rest = invoice.netCents - itemized;
    if (rest) { add(kinds, invoice.kind, rest); add(categories, invoice.category ?? COST_KIND_NAMES[invoice.kind], rest); }
    const supplier = suppliers.get(invoice.supplier) ?? {netCents: 0, invoices: 0};
    supplier.netCents += invoice.netCents; supplier.invoices++;
    suppliers.set(invoice.supplier, supplier);
  }
  const netCents = inRange.reduce((sum, invoice) => sum + invoice.netCents, 0);
  const food = (kinds.get('food') ?? 0) + (kinds.get('beverage') ?? 0);
  const byLargest = <T extends {netCents: number; name: string}>(a: T, b: T) => b.netCents - a.netCents || a.name.localeCompare(b.name, 'cs');
  return {
    from, to, invoices: inRange.length, netCents, grossCents: inRange.reduce((sum, invoice) => sum + invoice.grossCents, 0),
    byKind: COST_KINDS.filter(kind => kinds.get(kind)).map(kind => ({kind, name: COST_KIND_NAMES[kind], netCents: kinds.get(kind)!})),
    byCategory: [...categories].map(([name, cents]) => ({name, netCents: cents})).filter(row => row.netCents).sort(byLargest),
    bySupplier: [...suppliers].map(([name, row]) => ({name, ...row})).sort(byLargest),
    foodCostPermille: revenue.revenueCents > 0 ? Math.round(food / revenue.revenueCents * 1000) : null,
    revenueCents: revenue.revenueCents, revenueDays: revenue.revenueDays,
  };
}

/** Items are the same when supplier, name (case and spaces aside) and unit match. */
const itemKey = (supplier: string, name: string, unit: string | null) => [supplier, name, unit ?? ''].map(part => part.trim().replace(/\s+/g, ' ').toLocaleLowerCase('cs')).join('|');

/**
 * Price rises bought in `from`–`to`: an item whose unit price is at least 5 % above its purchase before (from any
 * earlier invoice passed in). One line per item, its latest rise; the costliest rise first.
 */
export function priceRises(invoices: SupplierInvoice[], from: string, to: string, minPermille = PRICE_RISE_PERMILLE): PriceRise[] {
  const purchases = invoices.filter(invoice => invoice.businessDate <= to)
    .sort((a, b) => a.businessDate.localeCompare(b.businessDate) || a.id.localeCompare(b.id))
    .flatMap(invoice => invoice.items.filter(item => item.unitPriceCents > 0).map(item => ({invoice, item, key: itemKey(invoice.supplier, item.name, item.unit)})));
  const last = new Map<string, number>(), rises = new Map<string, PriceRise>();
  for (const {invoice, item, key} of purchases) {
    const before = last.get(key);
    last.set(key, item.unitPriceCents);
    if (before === undefined || invoice.businessDate < from) continue;
    const permille = Math.round((item.unitPriceCents / before - 1) * 1000);
    if (permille >= minPermille) {
      rises.set(key, {date: invoice.businessDate, supplier: invoice.supplier, name: item.name, unit: item.unit, oldCents: before, newCents: item.unitPriceCents, permille,
        extraCents: Math.round((item.unitPriceCents - before) * item.quantity)});
    } else rises.delete(key);
  }
  return [...rises.values()].sort((a, b) => b.extraCents - a.extraCents || b.permille - a.permille || a.name.localeCompare(b.name, 'cs'));
}

/** Unpaid invoices past their due date on `today` (a due date of today is not late yet), the oldest first. */
export function overdueInvoices(invoices: SupplierInvoice[], today: string): OverdueInvoice[] {
  return invoices.filter(invoice => invoice.dueDate && invoice.dueDate < today && !invoice.paidDate)
    .map(invoice => ({supplier: invoice.supplier, number: invoice.number, dueDate: invoice.dueDate!, grossCents: invoice.grossCents,
      days: Math.round((Date.parse(today) - Date.parse(invoice.dueDate!)) / 86400000)}))
    .sort((a, b) => a.dueDate.localeCompare(b.dueDate) || b.grossCents - a.grossCents);
}

/** The brief for a reported day: the month up to it, rises of the 7 days up to it, invoices overdue on the day that starts after it. */
export function supplyBrief(invoices: SupplierInvoice[], date: string, revenue: {revenueCents: number; revenueDays: number}): SupplyBrief | null {
  if (!invoices.length) return null;
  return {month: supplySummary(invoices, date.slice(0, 8) + '01', date, revenue), rises: priceRises(invoices, addDays(date, -6), date),
    overdue: overdueInvoices(invoices, addDays(date, 1)), sources: [...new Set(invoices.map(invoice => invoice.source))].sort()};
}

/** Whole crowns for totals, crowns with haléře for unit prices: "51,59 Kč". */
const group = (value: number) => String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
export const crownsTotal = (cents: number) => (cents < 0 ? '−' : '') + group(Math.round(Math.abs(cents) / 100)) + ' Kč';
export const unitPrice = (cents: number) => group(Math.floor(cents / 100)) + ',' + String(cents % 100).padStart(2, '0') + ' Kč';
const percent = (permille: number) => (Math.round(permille / 10)) + ' %';
const shortDate = (date: string) => `${Number(date.slice(8))}. ${Number(date.slice(5, 7))}.`;

/** "Borůvky 125 g (MAKRO) 40,70 → 51,59 Kč (+27 %)" */
export const riseText = (rise: PriceRise) => `${rise.name.trim()}${rise.unit ? ` / ${rise.unit}` : ''} (${rise.supplier}) ${unitPrice(rise.oldCents).slice(0, -3)} → ${unitPrice(rise.newCents)} (+${percent(rise.permille)})`;
/** "MAKRO č. 2026-118, 12 400 Kč, splatná 5. 10. (8 dní)" */
export const overdueText = (row: OverdueInvoice) => `${row.supplier}${row.number ? ` č. ${row.number}` : ''}, ${crownsTotal(row.grossCents)}, splatná ${shortDate(row.dueDate)} (${row.days} ${row.days === 1 ? 'den' : row.days <= 4 ? 'dny' : 'dní'})`;

/** Morning message: purchases of the month so far with food cost, the biggest price rises of the week and overdue invoices. */
export function renderSupplies(brief: SupplyBrief | null): string[] {
  if (!brief) return [];
  const lines: string[] = [], month = brief.month;
  if (month.invoices) {
    const kinds = month.byKind.map(row => `${row.name} ${crownsTotal(row.netCents)}`).join(' · ');
    lines.push(`Nákupy od ${shortDate(month.from)} do ${shortDate(month.to)} (faktury, bez DPH): ${crownsTotal(month.netCents)}${kinds ? ' · ' + kinds : ''}`
      + (month.foodCostPermille !== null ? ` · food cost ${String(month.foodCostPermille / 10).replace('.', ',')} % z tržeb s DPH` : ''));
  }
  if (brief.rises.length) lines.push(`⚠ Zdražení za 7 dní: ${brief.rises.slice(0, 3).map(riseText).join(' · ')}${brief.rises.length > 3 ? ` · … a další ${brief.rises.length - 3}` : ''}`);
  if (brief.overdue.length) {
    const total = brief.overdue.reduce((sum, row) => sum + row.grossCents, 0);
    lines.push(`⚠ Faktury po splatnosti: ${brief.overdue.length} za ${crownsTotal(total)} (nejstarší ${overdueText(brief.overdue[0])})`);
  }
  return lines;
}
