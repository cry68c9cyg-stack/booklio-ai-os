/**
 * Batch „Nákup jídla a nápojů zvlášť“ (MC „jo“ 18. 10. 2026): on Monday what the week bought of food and of drinks by the
 * supplier invoices (without VAT), each as a share of the revenue without VAT, against the 4 weeks before, and which supplier
 * the rise came from. Invoices are dated by their issue, so one big delivery can lift a week: the supplier named says where to look.
 */
import type {SupplierInvoice} from './validate.ts';

const kc = (cents: number) => (cents < 0 ? '−' : '') + String(Math.round(Math.abs(cents) / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ') + ' Kč';
const percent = (permille: number) => `${String(Math.round(permille) / 10).replace('.', ',')} %`;
const shortDate = (date: string) => `${Number(date.slice(8))}. ${Number(date.slice(5, 7))}.`;

export const PURCHASE_KINDS = ['food', 'beverage'] as const;
export type PurchaseKind = typeof PURCHASE_KINDS[number];
const NAMES: Record<PurchaseKind, string> = {food: 'jídlo', beverage: 'nápoje'};

/** Food and drinks bought over a stretch, by supplier (items carry their own kind, the rest of an invoice falls to the invoice's). */
export type KindSums = Record<PurchaseKind, Map<string, number>>;
export function kindSums(invoices: SupplierInvoice[], from: string, to: string): KindSums {
  const sums: KindSums = {food: new Map(), beverage: new Map()};
  const add = (kind: string, supplier: string, cents: number) => {
    if (kind !== 'food' && kind !== 'beverage') return;
    sums[kind].set(supplier, (sums[kind].get(supplier) ?? 0) + cents);
  };
  for (const invoice of invoices.filter(entry => entry.businessDate >= from && entry.businessDate <= to)) {
    let itemized = 0;
    for (const item of invoice.items) { add(item.kind ?? invoice.kind, invoice.supplier, item.netCents); itemized += item.netCents; }
    if (invoice.netCents - itemized) add(invoice.kind, invoice.supplier, invoice.netCents - itemized);
  }
  return sums;
}
const total = (map: Map<string, number>) => [...map.values()].reduce((sum, cents) => sum + cents, 0);

export type PurchaseShareInput = {from: string; to: string; week: KindSums; before: KindSums;
  /** Revenue without VAT of the week and of the 4 weeks before, and their days with revenue. */
  weekRevenueNetCents: number; weekRevenueDays: number; beforeRevenueNetCents: number; beforeRevenueDays: number};
export type PurchaseShareRow = {kind: PurchaseKind; name: string; cents: number; sharePermille: number | null; beforeSharePermille: number | null; worse: boolean;
  /** The supplier with the most bought over its average week before, and by how much. */
  rise: {supplier: string; overCents: number} | null};

export function purchaseShares(input: PurchaseShareInput): PurchaseShareRow[] {
  const enough = input.beforeRevenueDays >= 21;
  return PURCHASE_KINDS.map(kind => {
    const cents = total(input.week[kind]), beforeCents = total(input.before[kind]);
    const sharePermille = input.weekRevenueNetCents > 0 ? cents * 1000 / input.weekRevenueNetCents : null;
    const beforeSharePermille = enough && beforeCents > 0 && input.beforeRevenueNetCents > 0 ? beforeCents * 1000 / input.beforeRevenueNetCents : null;
    // Worse: a fifth more of the revenue than before and at least 2 points more.
    const worse = sharePermille !== null && beforeSharePermille !== null && sharePermille >= beforeSharePermille * 1.2 && sharePermille - beforeSharePermille >= 20;
    const suppliers = new Set([...input.week[kind].keys()]);
    let rise: PurchaseShareRow['rise'] = null;
    for (const supplier of suppliers) {
      const overCents = (input.week[kind].get(supplier) ?? 0) - Math.round((input.before[kind].get(supplier) ?? 0) / 4);
      if (overCents > 0 && (!rise || overCents > rise.overCents)) rise = {supplier, overCents};
    }
    return {kind, name: NAMES[kind], cents, sharePermille, beforeSharePermille, worse, rise: enough ? rise : null};
  });
}

/** Monday, once the week has revenue on 5 days and some food or drink bought. */
export function renderPurchaseShares(input: PurchaseShareInput | null | undefined): string[] {
  if (!input || input.weekRevenueDays < 5) return [];
  const rows = purchaseShares(input).filter(row => row.cents > 0);
  if (!rows.length) return [];
  const text = (row: PurchaseShareRow) => `${row.worse ? '⚠ ' : ''}${row.name} ${kc(row.cents)}${row.sharePermille !== null ? ` = ${percent(row.sharePermille)}` : ''}` +
    `${row.beforeSharePermille !== null ? ` (předtím ${percent(row.beforeSharePermille)})` : ''}${row.worse && row.rise ? `, nejvíc navíc ${row.rise.supplier} +${kc(row.rise.overCents)}` : ''}`;
  return [`Nákup jídla a nápojů ${shortDate(input.from)}–${shortDate(input.to)} z tržby bez DPH (faktury bez DPH, proti průměru 4 týdnů): ${rows.map(text).join(' · ')}`];
}
