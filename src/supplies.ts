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
  /** Unpaid invoices due within the 7 days that start after the reported day. */
  dueSoon?: DueInvoice[];
  /** Food cost of the month over the venue's limit (from 7 days of revenue on). */
  foodCostAlert?: {permille: number; limitPermille: number} | null;
  /** New suppliers and unusually large invoices of the 7 days up to the day. */
  unusual?: UnusualPurchase[];
  /** Invoice-like attachments from the venue's mailbox of the 7 days up to the day that OKO1 could not read. */
  unreadable?: UnreadableMail[];
  /** Purchases of the month expected by its end (the month's pace on the revenue forecast for the rest of it). */
  outlook?: CostOutlook | null;
  /** On the last day of the month: the month closed. */
  closing?: MonthClosing | null;
  /** Before a payment day (Tuesday, Thursday): what to pay in that batch. */
  payments?: PaymentBatch | null;
  /** The same invoice (supplier and number) arrived with different amounts. */
  conflicts?: AmountConflict[];
  /** Invoices from the mailbox of the 7 days up to the day from a supplier never invoiced before (check before paying). */
  newFromMail?: NewMailSupplier[];
  /** Regular suppliers whose invoice of this month has not come by their usual day. */
  missing?: MissingInvoice[];
  /** Only in the Monday message (about Sunday): the week's rises per supplier, the drinks with the lowest margin and the categories growing most against the month before. */
  weekly?: {suppliers: SupplierRises[]; lowMargins: DrinkMargin[]; growing?: CategoryChange[]} | null};
/** An unpaid invoice due soon: `days` until the due date (0 = today). */
export type DueInvoice = {supplier: string; number: string | null; dueDate: string; days: number; grossCents: number};
/** A category's purchases of the month so far against the same days of the month before. */
export type CategoryChange = {name: string; netCents: number; previousCents: number; changeCents: number};
/** A document from the venue's mailbox that OKO1 could not read: the day of the message, who sent it and its subject. */
export type UnreadableMail = {date: string; sender: string; subject: string};
/** A purchase out of the ordinary: a supplier not bought from in the year before, or an invoice over 3× the supplier's usual (median). */
export type UnusualPurchase = {kind: 'new_supplier' | 'large'; supplier: string; date: string; number: string | null; netCents: number; usualCents: number | null};

/** Expected purchases of the month: what was bought so far plus the same share of the revenue forecast for its rest; and what is still to pay in it. */
export type CostOutlook = {month: string; purchasesCents: number; estimateCents: number; restRevenueCents: number;
  byKind: {kind: CostKind; name: string; estimateCents: number}[]; dueRestCents: number; dueRest: number};
/** The month closed: purchases without VAT by kind, food cost, the month before, invoices of the month not paid yet. */
export type MonthClosing = {month: string; summary: SupplySummary; previousNetCents: number; unpaidCents: number; unpaid: number};
/** One batch payment (MC's office pays on Tuesday and Thursday): unpaid invoices due before the next payment day. */
export type PaymentBatch = {payDay: string; nextPayDay: string; rows: {supplier: string; number: string | null; dueDate: string; grossCents: number; source: string}[]; totalCents: number};
/** An invoice from the mailbox by a supplier OKO1 has no earlier invoice of, with who e-mailed it. */
export type NewMailSupplier = {supplier: string; supplierId: string | null; number: string | null; date: string; grossCents: number; sender: string | null; id: string};
/** Invoices of one supplier with the same number but different amounts (a corrected invoice, or a mistake). */
export type AmountConflict = {supplier: string; number: string; amounts: number[]; dates: string[]};

/** Food cost limit when the venue sets none: 30 % of revenue with VAT (MC, 14. 10. 2026). */
export const FOOD_COST_LIMIT_PERMILLE = 300;
/** Food cost is judged only from this many days of revenue in the month, so the first days with few invoices do not alarm. */
const FOOD_COST_MIN_DAYS = 7;
/** An invoice is large when its amount without VAT is at least 3× the median of the supplier's earlier invoices (at least 3 of them). */
const LARGE_TIMES = 3, LARGE_MIN_HISTORY = 3;
/** A supplier counts as new only when the purchases reach at least 60 days before, so a fresh start does not make everyone new. */
const NEW_SUPPLIER_HISTORY_DAYS = 60;

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

/**
 * Senders that cannot know when an invoice was paid (the mailbox sees the invoice, not the bank): their invoices are
 * never called overdue, only listed as due.
 */
export const PAYMENT_UNKNOWN_SOURCES: readonly string[] = ['posta'];

/** Unpaid invoices past their due date on `today` (a due date of today is not late yet), the oldest first. */
export function overdueInvoices(invoices: SupplierInvoice[], today: string): OverdueInvoice[] {
  return invoices.filter(invoice => invoice.dueDate && invoice.dueDate < today && !invoice.paidDate && !PAYMENT_UNKNOWN_SOURCES.includes(invoice.source))
    .map(invoice => ({supplier: invoice.supplier, number: invoice.number, dueDate: invoice.dueDate!, grossCents: invoice.grossCents,
      days: Math.round((Date.parse(today) - Date.parse(invoice.dueDate!)) / 86400000)}))
    .sort((a, b) => a.dueDate.localeCompare(b.dueDate) || b.grossCents - a.grossCents);
}

/** The brief for a reported day: the month up to it, rises of the 7 days up to it, invoices overdue on the day that starts after it. */
export function supplyBrief(invoices: SupplierInvoice[], date: string, revenue: {revenueCents: number; revenueDays: number},
  extra: {payoutsCents?: number; menu?: Menu | null; foodCostLimitPermille?: number | null; restRevenueCents?: number | null; withCancelled?: SupplierInvoice[]} = {}): SupplyBrief | null {
  if (!invoices.length) return null;
  const month = supplySummary(invoices, date.slice(0, 8) + '01', date, revenue), rises = priceRises(invoices, addDays(date, -6), date);
  const payoutsCents = extra.payoutsCents ?? 0;
  return {month, rises, overdue: overdueInvoices(invoices, addDays(date, 1)), sources: [...new Set(invoices.map(invoice => invoice.source))].sort(),
    dueSoon: dueSoon(invoices, addDays(date, 1)), foodCostAlert: foodCostAlert(month, extra.foodCostLimitPermille),
    unusual: unusualPurchases(invoices, addDays(date, -6), date),
    outlook: Number(date.slice(8)) >= 7 && !addDays(date, 1).endsWith('-01') ? costOutlook(invoices, month, date, extra.restRevenueCents ?? null) : null,
    closing: monthClosing(invoices, date, revenue), payments: paymentBatch(invoices, date), missing: missingInvoices(invoices, date),
    conflicts: amountConflicts((extra.withCancelled ?? invoices).filter(invoice => invoice.businessDate >= addDays(date, -34) && invoice.businessDate <= date)),
    duplicates: duplicateInvoices(invoices.filter(invoice => invoice.businessDate >= addDays(date, -34) && invoice.businessDate <= date)),
    result: revenue.revenueDays ? {revenueCents: revenue.revenueCents, purchasesCents: month.netCents, payoutsCents,
      resultCents: revenue.revenueCents - month.netCents - payoutsCents} : null,
    weekly: weekday(date) === 0 ? {suppliers: risesBySupplier(rises), lowMargins: extra.menu ? drinkMargins(extra.menu, invoices, date).margins.slice(0, LOW_MARGINS) : [],
      growing: monthOverMonth(invoices, date).filter(row => row.changeCents > 0).sort((a, b) => b.changeCents - a.changeCents).slice(0, 3)} : null};
}

/** Purchases expected by the end of the month, from 7 days of revenue on and with a forecast for the rest. */
export function costOutlook(invoices: SupplierInvoice[], month: SupplySummary, date: string, restRevenueCents: number | null): CostOutlook | null {
  if (restRevenueCents === null || month.revenueDays < FOOD_COST_MIN_DAYS || month.revenueCents <= 0 || !month.invoices) return null;
  const share = (cents: number) => cents + Math.round(cents * restRevenueCents / month.revenueCents);
  const monthEnd = addDays(addDays(date.slice(0, 8) + '01', 32).slice(0, 8) + '01', -1);
  const due = invoices.filter(invoice => !invoice.paidDate && invoice.dueDate && invoice.dueDate > date && invoice.dueDate <= monthEnd);
  return {month: date.slice(0, 7), purchasesCents: month.netCents, estimateCents: share(month.netCents), restRevenueCents,
    byKind: month.byKind.map(row => ({kind: row.kind, name: row.name, estimateCents: share(row.netCents)})),
    dueRestCents: due.reduce((sum, invoice) => sum + invoice.grossCents, 0), dueRest: due.length};
}

/** The month of `date` closed, on its last day. */
export function monthClosing(invoices: SupplierInvoice[], date: string, revenue: {revenueCents: number; revenueDays: number}): MonthClosing | null {
  if (!addDays(date, 1).endsWith('-01')) return null;
  const first = date.slice(0, 8) + '01', summary = supplySummary(invoices, first, date, revenue);
  if (!summary.invoices) return null;
  const previousFirst = addDays(first, -1).slice(0, 8) + '01';
  const unpaid = invoices.filter(invoice => invoice.businessDate >= first && invoice.businessDate <= date && !invoice.paidDate && invoice.grossCents > 0);
  return {month: date.slice(0, 7), summary, previousNetCents: supplySummary(invoices, previousFirst, addDays(first, -1), {revenueCents: 0, revenueDays: 0}).netCents,
    unpaidCents: unpaid.reduce((sum, invoice) => sum + invoice.grossCents, 0), unpaid: unpaid.length};
}

/** Payment days of the office (Nancy, 17. 10. 2026: batch payment on Tuesday and Thursday). 2 = Tuesday, 4 = Thursday. */
export const PAYMENT_WEEKDAYS = [2, 4];

/** The batch of the payment day that starts after `date` (the morning message), or null when that is no payment day. */
export function paymentBatch(invoices: SupplierInvoice[], date: string): PaymentBatch | null {
  const payDay = addDays(date, 1);
  if (!PAYMENT_WEEKDAYS.includes(weekday(payDay))) return null;
  let nextPayDay = addDays(payDay, 1);
  while (!PAYMENT_WEEKDAYS.includes(weekday(nextPayDay))) nextPayDay = addDays(nextPayDay, 1);
  // Due before the next payment day; long overdue ones (over 30 days) are left to the overdue list.
  const rows = invoices.filter(invoice => !invoice.paidDate && invoice.dueDate && invoice.grossCents > 0 && invoice.dueDate < nextPayDay && invoice.dueDate >= addDays(payDay, -30))
    .map(invoice => ({supplier: invoice.supplier, number: invoice.number, dueDate: invoice.dueDate!, grossCents: invoice.grossCents, source: invoice.source}))
    .sort((a, b) => a.dueDate.localeCompare(b.dueDate) || b.grossCents - a.grossCents);
  return rows.length ? {payDay, nextPayDay, rows, totalCents: rows.reduce((sum, row) => sum + row.grossCents, 0)} : null;
}

const invoiceKey = (invoice: SupplierInvoice) => `${invoice.supplierId ?? invoice.supplier.trim().toLocaleLowerCase('cs').replace(/\s+/g, ' ')}|${(invoice.number ?? '').replace(/[\s/-]+/g, '').toLowerCase()}`;

/** The next batch from the day after `date` on (the dashboard and Claude): the first payment day within a week. */
export function nextPaymentBatch(invoices: SupplierInvoice[], date: string): PaymentBatch | null {
  for (let day = date; day <= addDays(date, 6); day = addDays(day, 1)) {
    if (PAYMENT_WEEKDAYS.includes(weekday(addDays(day, 1)))) return paymentBatch(invoices, day);
  }
  return null;
}

const supplierName = (invoice: SupplierInvoice) => invoice.supplier.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '').replace(/[^a-z0-9]+/g, ' ').trim().split(' ').slice(0, 2).join(' ');
/** The same supplier: the same IČO, or (one of them without it) the same first two words of the name. */
const sameSupplier = (a: SupplierInvoice, b: SupplierInvoice) => a.supplierId && b.supplierId ? a.supplierId === b.supplierId : supplierName(a) === supplierName(b);

/** Invoices from the mailbox issued `from`–`to` by suppliers with no earlier invoice from any source. */
export function newSuppliersFromMail(invoices: SupplierInvoice[], from: string, to: string, senders: Map<string, string> = new Map()): NewMailSupplier[] {
  return invoices.filter(invoice => invoice.source === 'posta' && invoice.businessDate >= from && invoice.businessDate <= to)
    .filter(invoice => !invoices.some(other => other.id !== invoice.id && sameSupplier(other, invoice)
      && (other.businessDate < invoice.businessDate || other.businessDate === invoice.businessDate && other.id < invoice.id)))
    .map(invoice => ({supplier: invoice.supplier, supplierId: invoice.supplierId, number: invoice.number, date: invoice.businessDate, grossCents: invoice.grossCents,
      sender: senders.get(invoice.id) ?? null, id: invoice.id}))
    .sort((a, b) => b.date.localeCompare(a.date));
}

/** A supplier who invoiced every one of the last `MISSING_MONTHS` months, by their usual day of the month. */
export type MissingInvoice = {supplier: string; supplierId: string | null; usualDay: number; lastDate: string; lastGrossCents: number; since: string};
export const MISSING_MONTHS = 3, MISSING_GRACE_DAYS = 5;

/**
 * Regular suppliers whose invoice of this month has not come (Nancy's suppliers e-mail theirs; OKO1 learns who is
 * regular from the invoices themselves, from any source): each of the 3 months before had one, and `date` is more than
 * 5 days past the latest day on which the first invoice of the month came in those months.
 */
export function missingInvoices(invoices: SupplierInvoice[], date: string): MissingInvoice[] {
  const months: string[] = [];
  for (let month = date.slice(0, 7), n = 0; n < MISSING_MONTHS; n++) {
    month = addDays(month + '-01', -1).slice(0, 7);
    months.push(month);
  }
  const groups = new Map<string, SupplierInvoice[]>();
  for (const invoice of invoices.filter(row => row.status === 'active' && row.grossCents > 0 && row.businessDate <= date && row.businessDate >= months[MISSING_MONTHS - 1] + '-01')) {
    const key = invoice.supplierId ?? supplierName(invoice);
    if (!key) continue;
    groups.set(key, [...(groups.get(key) ?? []), invoice]);
  }
  const today = Number(date.slice(8)), out: MissingInvoice[] = [];
  for (const group of groups.values()) {
    if (group.some(invoice => invoice.businessDate.startsWith(date.slice(0, 7)))) continue;
    const firstDays = months.map(month => group.filter(invoice => invoice.businessDate.startsWith(month)).map(invoice => Number(invoice.businessDate.slice(8))).sort((a, b) => a - b)[0]);
    if (firstDays.some(day => day === undefined)) continue;
    const usualDay = Math.max(...firstDays);
    if (today <= usualDay + MISSING_GRACE_DAYS) continue;
    const last = [...group].sort((a, b) => b.businessDate.localeCompare(a.businessDate))[0];
    out.push({supplier: last.supplier, supplierId: last.supplierId, usualDay, lastDate: last.businessDate, lastGrossCents: last.grossCents,
      since: date.slice(0, 8) + String(usualDay + MISSING_GRACE_DAYS + 1).padStart(2, '0')});
  }
  return out.sort((a, b) => b.lastGrossCents - a.lastGrossCents);
}
export const missingText = (row: MissingInvoice) => `${row.supplier}${row.supplierId ? ` (IČO ${row.supplierId})` : ''}: faktura za tento měsíc nepřišla, obvykle chodí do ${row.usualDay}. dne, naposledy ${shortDate(row.lastDate)} ${crownsTotal(row.lastGrossCents)}`;

/** The payment list for the office (MC, 18. 10. 2026: e-mailed to the accountant on Tuesday and Thursday morning). */
export function paymentMail(batch: PaymentBatch, venue: string, mailSources: string[]): {subject: string; text: string; csv: Uint8Array} {
  const exact = (cents: number) => unitPrice(cents);
  const lines = batch.rows.map(row => `${shortDate(row.dueDate)}  ${row.supplier}${row.number ? `, č. ${row.number}` : ''}  ${exact(row.grossCents)}${mailSources.includes(row.source) ? '  (z pošty)' : ''}`);
  const text = [`Dobrý den,`, ``,
    `faktury ${venue} k hromadné platbě na ${dayName(batch.payDay)} ${shortDate(batch.payDay)} (splatné do ${shortDate(addDays(batch.nextPayDay, -1))}): ${batch.rows.length}, celkem ${exact(batch.totalCents)}.`, ``,
    ...lines, ``,
    ...(batch.rows.some(row => mailSources.includes(row.source)) ? [`U faktur z pošty OKO1 nevidí, jestli už jsou zaplacené; zaplacené prosím přeskočte.`, ``] : []),
    `Seznam je i v příloze (CSV pro Excel). Co se nakonec platí, schvaluje provozovna jako dosud.`, ``,
    `OKO1, ${venue}`, `(automatická zpráva, odpovědi chodí na info@)`].join('\n');
  const quote = (value: string) => /[";\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
  const csv = ['Splatnost;Dodavatel;Číslo;Částka s DPH;Zdroj', ...batch.rows.map(row => [row.dueDate, quote(row.supplier), quote(row.number ?? ''),
    (row.grossCents / 100).toFixed(2).replace('.', ','), mailSources.includes(row.source) ? 'pošta' : row.source].join(';'))].join('\r\n') + '\r\n';
  return {subject: `Faktury k platbě ${dayName(batch.payDay)} ${shortDate(batch.payDay)}: ${batch.rows.length}× ${crownsTotal(batch.totalCents)}`, text,
    csv: new TextEncoder().encode('\ufeff' + csv)};
}

export const newSupplierText = (row: NewMailSupplier) => `${row.supplier}${row.supplierId ? ` (IČO ${row.supplierId})` : ''}${row.number ? ` č. ${row.number}` : ''}, ${crownsTotal(row.grossCents)}${row.sender ? `, poslal ${row.sender}` : ''}`;

/** Invoices with the same supplier and number but different amounts with VAT (from any source, cancelled copies included). */
export function amountConflicts(invoices: SupplierInvoice[]): AmountConflict[] {
  const groups = new Map<string, SupplierInvoice[]>();
  for (const invoice of invoices) {
    if (!invoice.number) continue;
    const key = invoiceKey(invoice);
    groups.set(key, [...(groups.get(key) ?? []), invoice]);
  }
  return [...groups.values()].filter(group => new Set(group.map(invoice => invoice.grossCents)).size > 1)
    .map(group => ({supplier: group[0].supplier, number: group[0].number!, amounts: [...new Set(group.map(invoice => invoice.grossCents))],
      dates: [...new Set(group.map(invoice => invoice.businessDate))].sort()}));
}

/** One unreadable document from the mailbox for the morning message and the to-do list. */
export function unreadableText(row: UnreadableMail): string {
  return `${row.sender}, ${shortDate(row.date)}${row.subject ? ` („${row.subject.slice(0, 60)}“)` : ''}`;
}

/** Unpaid invoices due on `today` or within the 6 days after it, the soonest first. */
export function dueSoon(invoices: SupplierInvoice[], today: string): DueInvoice[] {
  const last = addDays(today, 6);
  return invoices.filter(invoice => invoice.dueDate && invoice.dueDate >= today && invoice.dueDate <= last && !invoice.paidDate)
    .map(invoice => ({supplier: invoice.supplier, number: invoice.number, dueDate: invoice.dueDate!, grossCents: invoice.grossCents,
      days: Math.round((Date.parse(invoice.dueDate!) - Date.parse(today)) / 86400000)}))
    .sort((a, b) => a.dueDate.localeCompare(b.dueDate) || b.grossCents - a.grossCents);
}

/** Food cost of the month over the limit (the venue's, else 30 %), once the month has 7 days of revenue. */
export function foodCostAlert(month: SupplySummary, limitPermille: number | null | undefined): {permille: number; limitPermille: number} | null {
  const limit = limitPermille ?? FOOD_COST_LIMIT_PERMILLE;
  return month.foodCostPermille !== null && month.revenueDays >= FOOD_COST_MIN_DAYS && month.foodCostPermille > limit ? {permille: month.foodCostPermille, limitPermille: limit} : null;
}

/**
 * Purchases by category from the 1st of the month to `date` against the same days of the month before (the 31st against
 * a shorter month takes the month's end). Every category of either month; the biggest change first.
 */
export function monthOverMonth(invoices: SupplierInvoice[], date: string): CategoryChange[] {
  const first = date.slice(0, 8) + '01', previousFirst = addDays(first, -1).slice(0, 8) + '01', previousEnd = addDays(first, -1);
  const previousTo = [previousFirst.slice(0, 8) + date.slice(8), previousEnd].sort()[0];
  const now = supplySummary(invoices, first, date, {revenueCents: 0, revenueDays: 0}), before = supplySummary(invoices, previousFirst, previousTo, {revenueCents: 0, revenueDays: 0});
  const rows = new Map<string, CategoryChange>();
  for (const row of now.byCategory) rows.set(row.name, {name: row.name, netCents: row.netCents, previousCents: 0, changeCents: row.netCents});
  for (const row of before.byCategory) {
    const current = rows.get(row.name) ?? {name: row.name, netCents: 0, previousCents: 0, changeCents: 0};
    current.previousCents = row.netCents; current.changeCents = current.netCents - row.netCents;
    rows.set(row.name, current);
  }
  return [...rows.values()].sort((a, b) => Math.abs(b.changeCents) - Math.abs(a.changeCents) || a.name.localeCompare(b.name, 'cs'));
}

/**
 * Invoices of `from`–`to` from a supplier not bought from in the 365 days before (only when the purchases passed in reach
 * 60 days before `from`), or at least 3× the median of the supplier's earlier invoices. The largest first.
 */
export function unusualPurchases(invoices: SupplierInvoice[], from: string, to: string): UnusualPurchase[] {
  const key = (supplier: string) => supplier.trim().replace(/\s+/g, ' ').toLocaleLowerCase('cs');
  const earliest = invoices.reduce((min, invoice) => invoice.businessDate < min ? invoice.businessDate : min, to);
  const knowsHistory = earliest <= addDays(from, -NEW_SUPPLIER_HISTORY_DAYS);
  const result: UnusualPurchase[] = [];
  for (const invoice of invoices.filter(row => row.businessDate >= from && row.businessDate <= to && row.netCents > 0)) {
    const earlier = invoices.filter(row => key(row.supplier) === key(invoice.supplier) && row.netCents > 0 && row.id !== invoice.id
      && (row.businessDate < invoice.businessDate || (row.businessDate === invoice.businessDate && row.id < invoice.id)) && row.businessDate >= addDays(invoice.businessDate, -365));
    const base = {supplier: invoice.supplier, date: invoice.businessDate, number: invoice.number, netCents: invoice.netCents};
    if (!earlier.length) { if (knowsHistory) result.push({kind: 'new_supplier', ...base, usualCents: null}); continue; }
    if (earlier.length < LARGE_MIN_HISTORY) continue;
    const amounts = earlier.map(row => row.netCents).sort((a, b) => a - b), middle = Math.floor(amounts.length / 2);
    const usualCents = amounts.length % 2 ? amounts[middle] : Math.round((amounts[middle - 1] + amounts[middle]) / 2);
    if (invoice.netCents >= usualCents * LARGE_TIMES) result.push({kind: 'large', ...base, usualCents});
  }
  return result.sort((a, b) => b.netCents - a.netCents || a.date.localeCompare(b.date));
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

/** "MAKRO č. 2026-130, 8 200 Kč, splatná 16. 10. (za 2 dny)" */
export const dueText = (row: DueInvoice) => `${row.supplier}${row.number ? ` č. ${row.number}` : ''}, ${crownsTotal(row.grossCents)}, splatná ${shortDate(row.dueDate)} (${row.days === 0 ? 'dnes' : row.days === 1 ? 'zítra' : `za ${row.days} ${row.days <= 4 ? 'dny' : 'dní'}`})`;
/** "nový dodavatel Řeznictví Novák 12 400 Kč (12. 10.)" or "Makro 45 000 Kč (12. 10.), obvykle 8 000 Kč" (without VAT) */
export const unusualText = (row: UnusualPurchase) => row.kind === 'new_supplier'
  ? `nový dodavatel ${row.supplier} ${crownsTotal(row.netCents)} (${shortDate(row.date)})`
  : `${row.supplier} ${crownsTotal(row.netCents)} (${shortDate(row.date)}), obvykle ${crownsTotal(row.usualCents ?? 0)}`;
const signed = (cents: number) => (cents > 0 ? '+' : '') + crownsTotal(cents);
/** "Food cost 34,2 % z tržeb s DPH je nad hranicí 30 %" */
export const foodCostText = (alert: {permille: number; limitPermille: number}) =>
  `Food cost ${String(alert.permille / 10).replace('.', ',')} % z tržeb s DPH je nad hranicí ${String(alert.limitPermille / 10).replace('.', ',')} %`;

/** Morning message: purchases of the month so far with food cost, the biggest price rises of the week and overdue invoices. */
const dayName = (date: string) => ['neděle', 'pondělí', 'úterý', 'středa', 'čtvrtek', 'pátek', 'sobota'][weekday(date)];
const monthName = (month: string) => ['leden', 'únor', 'březen', 'duben', 'květen', 'červen', 'červenec', 'srpen', 'září', 'říjen', 'listopad', 'prosinec'][Number(month.slice(5)) - 1];
export const conflictText = (row: AmountConflict) => `${row.supplier} č. ${row.number}: ${row.amounts.map(crownsTotal).join(' / ')}`;
export const paymentText = (batch: PaymentBatch) => `${dayName(batch.payDay)} ${shortDate(batch.payDay)}: ${batch.rows.length} ${batch.rows.length === 1 ? 'faktura' : batch.rows.length <= 4 ? 'faktury' : 'faktur'} za ${crownsTotal(batch.totalCents)}`;

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
  if (brief.foodCostAlert) lines.push(`⚠ ${foodCostText(brief.foodCostAlert)}`);
  if (brief.dueSoon?.length) {
    const total = brief.dueSoon.reduce((sum, row) => sum + row.grossCents, 0);
    lines.push(`Splatné do 7 dní: ${brief.dueSoon.length} za ${crownsTotal(total)} (nejbližší ${dueText(brief.dueSoon[0])})`);
  }
  if (brief.unusual?.length) lines.push(`⚠ Neobvyklý nákup: ${brief.unusual.slice(0, 3).map(unusualText).join(' · ')}${brief.unusual.length > 3 ? ` · … a další ${brief.unusual.length - 3}` : ''}`);
  if (brief.unreadable?.length) lines.push(`Z pošty nešlo přečíst ${brief.unreadable.length === 1 ? '1 doklad' : `${brief.unreadable.length} ${brief.unreadable.length <= 4 ? 'doklady' : 'dokladů'}`}: ${brief.unreadable.slice(0, 3).map(unreadableText).join(' · ')}`);
  if (brief.duplicates?.length) lines.push(`⚠ Možná duplicitní faktury: ${brief.duplicates.slice(0, 3).map(duplicateText).join(' · ')}`);
  if (brief.conflicts?.length) lines.push(`⚠ Stejná faktura s jinou částkou: ${brief.conflicts.slice(0, 3).map(conflictText).join(' · ')}`);
  // Missing invoices: on the day one is first missed and in the Monday message, not every morning (the to-do list keeps them).
  const missing = (brief.missing ?? []).filter(row => row.since === brief.month.to || weekday(brief.month.to) === 0);
  if (missing.length) lines.push(`⚠ Nepřišla obvyklá faktura: ${missing.slice(0, 3).map(missingText).join(' · ')}${missing.length > 3 ? ` · … a další ${missing.length - 3}` : ''}`);
  if (brief.newFromMail?.length) lines.push(`⚠ Faktura z pošty od dodavatele, kterého ještě neznáme (ověřit, než se zaplatí): ${brief.newFromMail.slice(0, 3).map(newSupplierText).join(' · ')}`);
  if (brief.payments) lines.push(`Hromadná platba ${paymentText(brief.payments)} (splatné do ${shortDate(addDays(brief.payments.nextPayDay, -1))}): ` +
    brief.payments.rows.slice(0, 5).map(row => `${row.supplier} ${crownsTotal(row.grossCents)}`).join(' · ') + (brief.payments.rows.length > 5 ? ` · … a další ${brief.payments.rows.length - 5}` : ''));
  if (brief.outlook) {
    const o = brief.outlook;
    lines.push(`Výhled nákupů za ${monthName(o.month)}: ${crownsTotal(o.estimateCents)} bez DPH (zatím ${crownsTotal(o.purchasesCents)}, podle odhadu tržeb na zbytek měsíce)` +
      (o.dueRest ? ` · do konce měsíce zaplatit ještě ${o.dueRest}× za ${crownsTotal(o.dueRestCents)}` : ''));
  }
  if (brief.closing) {
    const c = brief.closing, m = c.summary;
    lines.push(`Uzávěrka ${monthName(c.month)}: nákupy ${crownsTotal(m.netCents)} bez DPH (${m.byKind.map(row => `${row.name} ${crownsTotal(row.netCents)}`).join(', ')})` +
      (m.foodCostPermille !== null ? ` · food cost ${String(m.foodCostPermille / 10).replace('.', ',')} %` : '') +
      (c.previousNetCents ? ` · proti minulému měsíci ${signed(m.netCents - c.previousNetCents)}` : '') + (c.unpaid ? ` · nezaplaceno ${c.unpaid}× za ${crownsTotal(c.unpaidCents)}` : ''));
  }
  if (brief.result) {
    const r = brief.result;
    lines.push(`Provozní výsledek od ${shortDate(month.from)}: tržby ${crownsTotal(r.revenueCents)} − nákupy ${crownsTotal(r.purchasesCents)}`
      + (r.payoutsCents ? ` − výplaty z kasy ${crownsTotal(r.payoutsCents)}` : '') + ` = ${crownsTotal(r.resultCents)} (hrubý odhad, bez mezd mimo kasu a režií)`);
  }
  if (brief.weekly?.suppliers.length) lines.push(`Zdražení za týden podle dodavatelů: ${brief.weekly.suppliers.slice(0, 3).map(row => `${row.supplier} ${row.items}× (+${crownsTotal(row.extraCents)})`).join(' · ')}`);
  if (brief.weekly?.lowMargins.length) lines.push(`Nejnižší marže nápojů: ${brief.weekly.lowMargins.map(marginText).join(' · ')}`);
  if (brief.weekly?.growing?.length) lines.push(`Nejvíc rostou proti minulému měsíci (stejné dny): ${brief.weekly.growing.map(row => `${row.name} ${signed(row.changeCents)}`).join(' · ')}`);
  return lines;
}
