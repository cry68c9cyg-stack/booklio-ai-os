/**
 * Supplier invoices (record `supplier_invoice`, docs/ingest-v1.md): what the venue buys, from whom and at what price.
 * The interim sender is Dishboard (decision of MC, 13. 10. 2026: a temporary input, later replaced, most likely by
 * Pexeso); any sender may use the same record, so the next source only fills the same place. Each sender has its
 * `source`, and the venue's `disabledSources` switches one off without touching the rest of OKO1.
 */
import {COST_KINDS, type Menu, type SupplierInvoice} from './validate.ts';
import {addDays, weekday} from './time.ts';

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
/** Invoices that look entered twice: same supplier, day and amount with VAT under different ids. */
export type DuplicateInvoice = {supplier: string; date: string; grossCents: number; count: number; numbers: string[]};
/** Price rises of a week summed per supplier: how many items and what the rises cost on those purchases. */
export type SupplierRises = {supplier: string; items: number; extraCents: number};
/** Operating result of the month so far: revenue with VAT − purchases without VAT − cash payouts (the cash book). A rough figure. */
export type MonthResultEstimate = {revenueCents: number; purchasesCents: number; payoutsCents: number; resultCents: number};
/** For the morning message, the to-do list and the dashboard: the month so far, recent price rises and overdue invoices. */
export type SupplyBrief = {month: SupplySummary; rises: PriceRise[]; overdue: OverdueInvoice[]; sources: string[];
  /** Possible duplicates over the 35 days up to the day. */
  duplicates?: DuplicateInvoice[];
  /** The month's operating result, when the month has revenue. */
  result?: MonthResultEstimate | null;
  /** Only in the Monday message (about Sunday): the week's rises per supplier and the drinks with the lowest margin. */
  weekly?: {suppliers: SupplierRises[]; lowMargins: DrinkMargin[]} | null};

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
export function supplyBrief(invoices: SupplierInvoice[], date: string, revenue: {revenueCents: number; revenueDays: number},
  extra: {payoutsCents?: number; menu?: Menu | null} = {}): SupplyBrief | null {
  if (!invoices.length) return null;
  const month = supplySummary(invoices, date.slice(0, 8) + '01', date, revenue), rises = priceRises(invoices, addDays(date, -6), date);
  const payoutsCents = extra.payoutsCents ?? 0;
  return {month, rises, overdue: overdueInvoices(invoices, addDays(date, 1)), sources: [...new Set(invoices.map(invoice => invoice.source))].sort(),
    duplicates: duplicateInvoices(invoices.filter(invoice => invoice.businessDate >= addDays(date, -34) && invoice.businessDate <= date)),
    result: revenue.revenueDays ? {revenueCents: revenue.revenueCents, purchasesCents: month.netCents, payoutsCents,
      resultCents: revenue.revenueCents - month.netCents - payoutsCents} : null,
    weekly: weekday(date) === 0 ? {suppliers: risesBySupplier(rises), lowMargins: extra.menu ? drinkMargins(extra.menu, invoices, date).margins.slice(0, LOW_MARGINS) : []} : null};
}

/** Same supplier (case and spaces aside), same day and amount with VAT, different ids: probably entered twice. Largest first. */
export function duplicateInvoices(invoices: SupplierInvoice[]): DuplicateInvoice[] {
  const groups = new Map<string, SupplierInvoice[]>();
  for (const invoice of invoices) {
    if (!invoice.grossCents) continue;
    const key = [invoice.supplier.trim().toLocaleLowerCase('cs'), invoice.businessDate, invoice.grossCents].join('|');
    groups.set(key, [...(groups.get(key) ?? []), invoice]);
  }
  return [...groups.values()].filter(group => group.length > 1)
    // Two invoices with different numbers from the supplier are two real invoices.
    .filter(group => new Set(group.map(invoice => invoice.number).filter(Boolean)).size <= 1)
    .map(group => ({supplier: group[0].supplier, date: group[0].businessDate, grossCents: group[0].grossCents, count: group.length,
      numbers: [...new Set(group.map(invoice => invoice.number).filter((number): number is string => !!number))]}))
    .sort((a, b) => b.grossCents - a.grossCents || a.date.localeCompare(b.date));
}

/** The rises summed per supplier, the costliest first. */
export function risesBySupplier(rises: PriceRise[]): SupplierRises[] {
  const suppliers = new Map<string, SupplierRises>();
  for (const rise of rises) {
    const row = suppliers.get(rise.supplier) ?? {supplier: rise.supplier, items: 0, extraCents: 0};
    row.items++; row.extraCents += rise.extraCents;
    suppliers.set(rise.supplier, row);
  }
  return [...suppliers.values()].sort((a, b) => b.extraCents - a.extraCents || b.items - a.items || a.supplier.localeCompare(b.supplier, 'cs'));
}

/** VAT on drinks served (21 %): the menu's prices include it, purchase prices do not. */
export const DRINK_VAT_PERMILLE = 210;
const LOW_MARGINS = 3;
/** A drink of the menu with the purchase it is paired with: price without VAT, cost of the poured volume and the margin. */
export type DrinkMargin = {itemId: string; name: string; volumeMl: number; priceCents: number; priceNetCents: number;
  purchase: {name: string; supplier: string; date: string; perLitreCents: number}; costCents: number; marginCents: number; marginPermille: number};

/** Words of a name without accents, case and punctuation; volume and pack sizes ("0,7 l", "6x") are left out for pairing. */
const words = (name: string) => name.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
  .replace(/\d+([.,]\d+)?\s*(ml|cl|l|x|ks|%)\b/g, ' ').split(/[^a-z0-9]+/).filter(word => word.length >= 2 && !/^\d+$/.test(word));

/** Litres in one unit of a purchase: the unit itself ("l"), or a volume in the name ("Rum X 0,7 l", "Pivo 50L", "700 ml"). */
export function litresPerUnit(name: string, unit: string | null): number | null {
  const u = (unit ?? '').trim().toLowerCase();
  if (u === 'l' || u === 'litr' || u === 'lt') return 1;
  if (u === 'ml') return 0.001;
  if (u === 'cl') return 0.01;
  const match = /(\d+(?:[.,]\d+)?)\s*(ml|cl|l)\b/i.exec(name);
  if (!match) return null;
  const value = Number(match[1].replace(',', '.')), size = match[2].toLowerCase();
  const litres = size === 'ml' ? value / 1000 : size === 'cl' ? value / 100 : value;
  return litres > 0 && litres <= 100 ? litres : null;
}

/**
 * Margins of the menu's drinks that have a poured volume, against the latest purchase up to `date` whose name holds every
 * word of the drink's name (accents and volume aside). Pairing by name is a guess; the dashboard shows which purchase was used.
 * Lowest margin first.
 */
export function drinkMargins(menu: Menu, invoices: SupplierInvoice[], date: string): {margins: DrinkMargin[]; unpaired: number} {
  const purchases = invoices.filter(invoice => invoice.businessDate <= date).sort((a, b) => b.businessDate.localeCompare(a.businessDate) || b.id.localeCompare(a.id))
    .flatMap(invoice => invoice.items.map(item => ({invoice, item, litres: litresPerUnit(item.name, item.unit), words: new Set(words(item.name))})))
    .filter(row => row.litres && row.item.unitPriceCents > 0);
  const margins: DrinkMargin[] = [];
  let unpaired = 0;
  for (const item of menu.items.filter(entry => entry.part !== 'food' && entry.volumeMl && entry.pricesCents[0] > 0)) {
    const wanted = words(item.name);
    const purchase = wanted.length ? purchases.find(row => wanted.every(word => row.words.has(word))) : undefined;
    if (!purchase) { unpaired++; continue; }
    const perLitreCents = Math.round(purchase.item.unitPriceCents / purchase.litres!);
    const priceNetCents = Math.round(item.pricesCents[0] * 1000 / (1000 + DRINK_VAT_PERMILLE));
    const costCents = Math.round(perLitreCents * item.volumeMl! / 1000);
    margins.push({itemId: item.id, name: item.name, volumeMl: item.volumeMl!, priceCents: item.pricesCents[0], priceNetCents,
      purchase: {name: purchase.item.name, supplier: purchase.invoice.supplier, date: purchase.invoice.businessDate, perLitreCents},
      costCents, marginCents: priceNetCents - costCents, marginPermille: priceNetCents ? Math.round((priceNetCents - costCents) / priceNetCents * 1000) : 0});
  }
  return {margins: margins.sort((a, b) => a.marginPermille - b.marginPermille || a.name.localeCompare(b.name, 'cs')), unpaired};
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

/** "MAKRO 2× 12 400 Kč (12. 10.)" */
export const duplicateText = (row: DuplicateInvoice) => `${row.supplier} ${row.count}× ${crownsTotal(row.grossCents)} (${shortDate(row.date)})`;
/** "Vodka X 0,04 l: 55 % (prodej 74 Kč bez DPH, nákup 33 Kč)" */
export const marginText = (row: DrinkMargin) => `${row.name} ${String(row.volumeMl / 1000).replace('.', ',')} l: ${Math.round(row.marginPermille / 10)} % (prodej ${crownsTotal(row.priceNetCents)} bez DPH, nákup ${crownsTotal(row.costCents)})`;

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
  if (brief.duplicates?.length) lines.push(`⚠ Možná duplicitní faktury: ${brief.duplicates.slice(0, 3).map(duplicateText).join(' · ')}`);
  if (brief.result) {
    const r = brief.result;
    lines.push(`Provozní výsledek od ${shortDate(month.from)}: tržby ${crownsTotal(r.revenueCents)} − nákupy ${crownsTotal(r.purchasesCents)}`
      + (r.payoutsCents ? ` − výplaty z kasy ${crownsTotal(r.payoutsCents)}` : '') + ` = ${crownsTotal(r.resultCents)} (hrubý odhad, bez mezd mimo kasu a režií)`);
  }
  if (brief.weekly?.suppliers.length) lines.push(`Zdražení za týden podle dodavatelů: ${brief.weekly.suppliers.slice(0, 3).map(row => `${row.supplier} ${row.items}× (+${crownsTotal(row.extraCents)})`).join(' · ')}`);
  if (brief.weekly?.lowMargins.length) lines.push(`Nejnižší marže nápojů: ${brief.weekly.lowMargins.map(marginText).join(' · ')}`);
  return lines;
}
