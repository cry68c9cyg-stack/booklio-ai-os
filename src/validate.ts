import {isDate} from './time.ts';

/** Thrown for any input that does not match the contract; the message is a stable error code. */
export class InputError extends Error {}

/**
 * `vatRate` = the VAT rate of the product in whole percent (12, 21), from the POS; needed for revenue without VAT and profit by item.
 * `menuItemId` = the menu item (`MenuItem.id`) the POS product is linked to; OKO1 pairs by it before trying names.
 */
export type BillItem = {name: string; productId: string | null; category: string | null; quantity: number; totalCents: number; vatRate: number | null; menuItemId?: string};
export type Payment = {method: string; amountCents: number};
export type Void = {name: string; amountCents: number; reason: string; afterPayment: boolean; approvedBy: string | null};
export type Bill = {
  type: 'bill'; id: string; version: number; businessDate: string; closedAt: string;
  registerId: string; section: string; status: 'closed' | 'cancelled';
  tableId: string | null; guests: number | null; waiterId: string | null; reservationId: string | null;
  totalCents: number; discountCents: number; items: BillItem[]; payments: Payment[]; voids: Void[];
};
export type CashClosing = {
  type: 'cash_closing'; id: string; version: number; businessDate: string; closedAt: string;
  registerId: string; expectedCents: number; countedCents: number;
};
/** One watched bottle. Volumes in whole millilitres, purchase price per litre in haléře. */
export type BottleCheckItem = {itemId: string; name: string; countedMl: number; expectedMl: number; costPerLitreCents: number};
/** Morning bottle count; `expectedMl` is computed by the POS, AI OS only stores and renders. */
export type BottleCheck = {type: 'bottle_check'; id: string; version: number; businessDate: string; countedAt: string; items: BottleCheckItem[]};
/**
 * Guest details of a booking (decision of MC, 12 Oct 2026). Personal data: kept only in the venue's database, never in the R2
 * archive, the export or the morning message. `null` everywhere once the reservation system anonymises the booking.
 */
export type ReservationGuest = {
  code: string | null; name: string | null; contactType: 'phone' | 'email' | null; contact: string | null; milkshake: string | null;
  wish: string | null; note: string | null; reason: string | null; language: string | null; origin: string | null; tables: string[];
};
/** One table booking from the reservation system; `guest` is optional (a sender may send counts only). */
export type Reservation = {
  type: 'reservation'; id: string; version: number; businessDate: string; startsAt: string; section: string; partySize: number;
  status: 'pending' | 'confirmed' | 'declined' | 'expired' | 'cancelled'; arrival: 'arrived' | 'no_show' | null; source: string | null;
  /** When the booking was made (optional): how far ahead guests book. */
  createdAt?: string;
  guest?: ReservationGuest;
};
/**
 * A public event of the venue from the website (concert, party, sports night): when, where and its public name.
 * Nothing about guests. A cancelled event stays with `status: cancelled`; the higher `version` overwrites.
 */
export type VenueEvent = {
  type: 'event'; id: string; version: number; businessDate: string; startsAt: string; endsAt: string | null; section: string;
  title: string; status: 'published' | 'cancelled';
};
const GUEST_FIELDS = ['code', 'name', 'contactType', 'contact', 'milkshake', 'wish', 'note', 'reason', 'language', 'origin', 'tables'];
/** The record without guest details, for anything that leaves the venue's database (archive, export). */
export function withoutGuest<T extends IngestRecord>(record: T): T {
  if (record.type !== 'reservation' || !('guest' in record)) return record;
  const {guest: _guest, ...rest} = record as Reservation;
  return rest as T;
}
/**
 * The website's daily traffic summary (one Prague calendar day): totals only, nothing about single visitors.
 * Sent hourly for yesterday and today; the higher `version` overwrites.
 */
export type WebTraffic = {
  type: 'web_traffic'; id: string; version: number; businessDate: string; visits: number; visitsWithAction: number;
  origins: {key: string; name: string; visits: number; withAction: number}[]; actions: Record<string, number>; reviewScans: number;
  /** Interest in the menu that day: page views by part, visits that opened it, of them from abroad and with a sent reservation, and by language. */
  menu?: WebMenuInterest;
};
export type WebMenuInterest = {
  views: {food: number; drinks: number}; visits: number; abroad: number; reserved: number;
  languages: {key: string; visits: number; reserved: number}[];
};
/**
 * Reviews that reached the website's admin (Google, TripAdvisor) on one Prague calendar day, and how many wait there:
 * counts only, no author, title or text. Sent hourly for yesterday and today; the higher `version` overwrites.
 */
export type ReviewSummary = {
  type: 'review_summary'; id: string; version: number; businessDate: string;
  /** Per source: new reviews by stars (`stars[0]` = 1 ★ … `stars[4]` = 5 ★) and those without stars. */
  sources: {key: string; name: string; stars: [number, number, number, number, number]; unrated: number}[];
  /** All reviews in the admin now: waiting for a reply, handed to management, reply failed to send. */
  waiting: number; forManagement: number; failed: number;
};
/** Parts of the menu as the website shows them: the food menu, cocktails and the other drinks. */
export const MENU_PARTS = ['food', 'cocktails', 'drinks'] as const;
/**
 * One item of the menu. `pricesCents` holds the prices as listed, the base first (a burger "225 / 255 Kč" has two sizes).
 * `id` is the sender's stable key of the item; a new id means a new item.
 */
export type MenuItem = {
  id: string; part: typeof MENU_PARTS[number]; category: string; group: string | null; name: string; description: string | null;
  volume: string | null; volumeMl: number | null; pricesCents: number[]; tip: boolean;
};
/**
 * The whole food and drink menu as published (decision of MC, 12. 10. 2026): the base for prices, food cost, menu
 * engineering, simulated repricing and profit by item. Public data, nothing about guests. A higher `version` replaces it.
 */
export type Menu = {
  type: 'menu'; id: string; version: number; businessDate: string; source: string; items: MenuItem[];
  notes: {part: MenuItem['part']; category: string; text: string}[];
};
/** What a purchase is for: food, drinks (both make food cost) or anything else. */
export const COST_KINDS = ['food', 'beverage', 'other'] as const;
/** One line of a supplier invoice; prices without VAT in haléře, `unitPriceCents` per `unit` as the invoice states it. */
export type SupplierInvoiceItem = {name: string; quantity: number; unit: string | null; unitPriceCents: number; netCents: number;
  kind: typeof COST_KINDS[number] | null; category: string | null};
/**
 * A supplier invoice or receipt (decision of MC, 13. 10. 2026; interim sender Dishboard, later Pexeso). `businessDate` is
 * the day it was issued. Business data only, nothing about guests. A higher `version` replaces it; a cancelled invoice
 * stays with `status: cancelled`.
 */
export type SupplierInvoice = {
  type: 'supplier_invoice'; id: string; version: number; businessDate: string; source: string; supplier: string; supplierId: string | null;
  number: string | null; dueDate: string | null; paidDate: string | null; status: 'active' | 'cancelled';
  netCents: number; grossCents: number; kind: typeof COST_KINDS[number]; category: string | null; items: SupplierInvoiceItem[];
};
export const RESERVATION_STATUSES = ['pending', 'confirmed', 'declined', 'expired', 'cancelled'] as const;
export type IngestRecord = Bill | CashClosing | BottleCheck | Reservation | WebTraffic | ReviewSummary | VenueEvent | Menu | SupplierInvoice;
export type Batch = {batchId: string; installationId: string; records: IngestRecord[]};

export type TenantConfig = {
  name: string; timeZone: string; businessDayCutoffHour: number; sendHours: number[];
  registers: string[]; sections: Record<string, string>; recipients: string[];
  /** Set = the venue counts bottles every morning: show losses from `minLossCents` up and say when the count is missing. */
  bottleCheck: {minLossCents: number} | null;
  /** Read-only OneDrive share link to the managers' report folder (interim until Pexeso). Set from a GitHub secret, never in Git. */
  reportsLink: string | null;
  /** Phones that may log into the dashboard (the owner). Not set = only the first of `recipients`. */
  dashboardPhones: string[] | null;
  /**
   * The venue's website that OKO1 reads live when it needs it, guest names and contacts included, and never stores
   * (docs/web-v1.md, approved by MC on 12. 10. 2026). Only the origin; the read token is the Worker secret
   * WEB_TOKEN_<TENANT>, never part of the config.
   */
  web: {url: string} | null;
  /** Where the venue is, for the weather forecast (MET Norway); 4 decimals at most, as its terms ask. */
  location: {lat: number; lon: number} | null;
  /** Senders (`source` of their records) switched off: their data stays stored but OKO1 leaves it out, e.g. `dishboard`. */
  disabledSources: string[];
};
/** Websites OKO1 may read (docs/web-v1.md). Nothing else is ever fetched with a web token. */
export const WEB_HOSTS: readonly string[] = ['jamesdean.cz'];
/** Loss threshold when a check arrives but the venue has no `bottleCheck` setting. */
export const DEFAULT_BOTTLE_LOSS_CENTS = 10000;
export type HistoryRow = {businessDate: string; revenueCents: number; bills: number | null; guests: number | null};

type Obj = Record<string, unknown>;
const fail = (code = 'INVALID_REQUEST'): never => { throw new InputError(code); };

function object(value: unknown, required: string[], optional: string[] = []): Obj {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail();
  const keys = Object.keys(value as Obj);
  if (required.some(key => !keys.includes(key)) || keys.some(key => !required.includes(key) && !optional.includes(key))) fail();
  return value as Obj;
}
function text(value: unknown, max = 100): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) fail();
  return value as string;
}
function optionalText(value: unknown, max = 100): string | null {
  return value === undefined || value === null ? null : text(value, max);
}
function id(value: unknown): string {
  if (typeof value !== 'string' || !/^[\w.:-]{1,100}$/.test(value)) fail();
  return value as string;
}
function int(value: unknown, min = -1e12, max = 1e12): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) fail();
  return value as number;
}
function list<T>(value: unknown, max: number, each: (item: unknown) => T): T[] {
  if (!Array.isArray(value) || value.length > max) fail();
  return (value as unknown[]).map(each);
}
function instant(value: unknown): string {
  if (typeof value !== 'string' || value.length > 40 || Number.isNaN(Date.parse(value))) fail();
  return new Date(value as string).toISOString();
}
function date(value: unknown): string {
  if (!isDate(value)) fail();
  return value as string;
}

const billKeys = ['type', 'id', 'version', 'businessDate', 'closedAt', 'registerId', 'section', 'status', 'totalCents', 'discountCents', 'items', 'payments', 'voids'];
const billOptional = ['tableId', 'guests', 'waiterId', 'reservationId'];

function bill(raw: Obj): Bill {
  const value = object(raw, billKeys, billOptional);
  if (value.status !== 'closed' && value.status !== 'cancelled') fail();
  return {
    type: 'bill', id: id(value.id), version: int(value.version, 1), businessDate: date(value.businessDate), closedAt: instant(value.closedAt),
    registerId: id(value.registerId), section: id(value.section), status: value.status as Bill['status'],
    tableId: value.tableId == null ? null : id(value.tableId), guests: value.guests == null ? null : int(value.guests, 0, 1000),
    waiterId: value.waiterId == null ? null : id(value.waiterId), reservationId: value.reservationId == null ? null : id(value.reservationId),
    totalCents: int(value.totalCents), discountCents: int(value.discountCents, 0),
    items: list(value.items, 500, item => {
      const row = object(item, ['name', 'quantity', 'totalCents'], ['productId', 'category', 'vatRate', 'menuItemId']);
      if (typeof row.quantity !== 'number' || !Number.isFinite(row.quantity) || row.quantity <= 0 || row.quantity > 1e6) fail();
      return {name: text(row.name), productId: row.productId == null ? null : id(row.productId), category: optionalText(row.category, 60), quantity: row.quantity as number, totalCents: int(row.totalCents),
        vatRate: row.vatRate == null ? null : int(row.vatRate, 0, 100),
        // Only when sent: a batch from before the field resent unchanged keeps its hash (idempotent replay).
        ...(row.menuItemId == null ? {} : {menuItemId: id(row.menuItemId)})};
    }),
    payments: list(value.payments, 20, item => {
      const row = object(item, ['method', 'amountCents']);
      return {method: id(row.method), amountCents: int(row.amountCents)};
    }),
    voids: list(value.voids, 200, item => {
      const row = object(item, ['name', 'amountCents', 'reason', 'afterPayment'], ['approvedBy']);
      if (typeof row.afterPayment !== 'boolean') fail();
      return {name: text(row.name), amountCents: int(row.amountCents, 0), reason: text(row.reason, 200), afterPayment: row.afterPayment as boolean, approvedBy: row.approvedBy == null ? null : id(row.approvedBy)};
    }),
  };
}

function cashClosing(raw: Obj): CashClosing {
  const value = object(raw, ['type', 'id', 'version', 'businessDate', 'closedAt', 'registerId', 'expectedCents', 'countedCents']);
  return {
    type: 'cash_closing', id: id(value.id), version: int(value.version, 1), businessDate: date(value.businessDate), closedAt: instant(value.closedAt),
    registerId: id(value.registerId), expectedCents: int(value.expectedCents), countedCents: int(value.countedCents),
  };
}

function bottleCheck(raw: Obj): BottleCheck {
  const value = object(raw, ['type', 'id', 'version', 'businessDate', 'countedAt', 'items']);
  const items = list(value.items, 50, item => {
    const row = object(item, ['itemId', 'name', 'countedMl', 'expectedMl', 'costPerLitreCents']);
    return {itemId: id(row.itemId), name: text(row.name), countedMl: int(row.countedMl, 0, 1e7), expectedMl: int(row.expectedMl, 0, 1e7), costPerLitreCents: int(row.costPerLitreCents, 0, 1e8)};
  });
  if (new Set(items.map(item => item.itemId)).size !== items.length) fail();
  return {type: 'bottle_check', id: id(value.id), version: int(value.version, 1), businessDate: date(value.businessDate), countedAt: instant(value.countedAt), items};
}

/** Free text from guests or staff: an empty string counts as missing. */
function guestText(value: unknown, max: number): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || value.length > max) fail();
  return value as string;
}
function guest(raw: unknown): ReservationGuest {
  const value = object(raw, [], GUEST_FIELDS);
  if (value.contactType != null && value.contactType !== 'phone' && value.contactType !== 'email') fail();
  return {
    code: guestText(value.code, 40), name: guestText(value.name, 200), contactType: (value.contactType ?? null) as ReservationGuest['contactType'],
    contact: guestText(value.contact, 200), milkshake: guestText(value.milkshake, 200), wish: guestText(value.wish, 2000),
    note: guestText(value.note, 2000), reason: guestText(value.reason, 2000), language: guestText(value.language, 10),
    origin: guestText(value.origin, 100), tables: value.tables == null ? [] : list(value.tables, 50, id),
  };
}

function reservation(raw: Obj): Reservation {
  const value = object(raw, ['type', 'id', 'version', 'businessDate', 'startsAt', 'section', 'partySize', 'status'], ['arrival', 'source', 'createdAt', 'guest']);
  if (!(RESERVATION_STATUSES as readonly unknown[]).includes(value.status)) fail();
  if (value.arrival != null && value.arrival !== 'arrived' && value.arrival !== 'no_show') fail();
  return {
    type: 'reservation', id: id(value.id), version: int(value.version, 1, Number.MAX_SAFE_INTEGER), businessDate: date(value.businessDate), startsAt: instant(value.startsAt),
    section: id(value.section), partySize: int(value.partySize, 1, 1000), status: value.status as Reservation['status'],
    arrival: (value.arrival ?? null) as Reservation['arrival'], source: value.source == null ? null : id(value.source),
    ...(value.createdAt == null ? {} : {createdAt: instant(value.createdAt)}),
    ...(value.guest === undefined ? {} : {guest: guest(value.guest)}),
  };
}

function venueEvent(raw: Obj): VenueEvent {
  const value = object(raw, ['type', 'id', 'version', 'businessDate', 'startsAt', 'section', 'title', 'status'], ['endsAt']);
  if (value.status !== 'published' && value.status !== 'cancelled') fail();
  return {
    type: 'event', id: id(value.id), version: int(value.version, 1, Number.MAX_SAFE_INTEGER), businessDate: date(value.businessDate),
    startsAt: instant(value.startsAt), endsAt: value.endsAt == null ? null : instant(value.endsAt), section: id(value.section),
    title: text(value.title, 200), status: value.status as VenueEvent['status'],
  };
}

const COUNT_MAX = 10_000_000;
function webTraffic(raw: Obj): WebTraffic {
  const value = object(raw, ['type', 'id', 'version', 'businessDate', 'visits', 'visitsWithAction', 'origins', 'actions', 'reviewScans'], ['menu']);
  const actions = object(value.actions, [], Object.keys((value.actions ?? {}) as Obj));
  if (Object.keys(actions).length > 100) fail();
  return {
    type: 'web_traffic', id: id(value.id), version: int(value.version, 1, Number.MAX_SAFE_INTEGER), businessDate: date(value.businessDate),
    visits: int(value.visits, 0, COUNT_MAX), visitsWithAction: int(value.visitsWithAction, 0, COUNT_MAX),
    origins: list(value.origins, 50, item => {
      const origin = object(item, ['key', 'name', 'visits', 'withAction']);
      return {key: id(origin.key), name: text(origin.name, 100), visits: int(origin.visits, 0, COUNT_MAX), withAction: int(origin.withAction, 0, COUNT_MAX)};
    }),
    actions: Object.fromEntries(Object.entries(actions).map(([key, count]) => [id(key), int(count, 0, COUNT_MAX)])),
    reviewScans: int(value.reviewScans, 0, COUNT_MAX),
    ...(value.menu == null ? {} : {menu: webMenuInterest(value.menu)}),
  };
}

function webMenuInterest(raw: unknown): WebMenuInterest {
  const value = object(raw, ['views', 'visits', 'abroad', 'reserved', 'languages']);
  const views = object(value.views, ['food', 'drinks']);
  return {
    views: {food: int(views.food, 0, COUNT_MAX), drinks: int(views.drinks, 0, COUNT_MAX)},
    visits: int(value.visits, 0, COUNT_MAX), abroad: int(value.abroad, 0, COUNT_MAX), reserved: int(value.reserved, 0, COUNT_MAX),
    languages: list(value.languages, 10, item => {
      const language = object(item, ['key', 'visits', 'reserved']);
      return {key: id(language.key), visits: int(language.visits, 0, COUNT_MAX), reserved: int(language.reserved, 0, COUNT_MAX)};
    }),
  };
}

function reviewSummary(raw: Obj): ReviewSummary {
  const value = object(raw, ['type', 'id', 'version', 'businessDate', 'sources', 'waiting', 'forManagement', 'failed']);
  return {
    type: 'review_summary', id: id(value.id), version: int(value.version, 1, Number.MAX_SAFE_INTEGER), businessDate: date(value.businessDate),
    sources: list(value.sources, 10, item => {
      const source = object(item, ['key', 'name', 'stars', 'unrated']);
      const stars = list(source.stars, 5, count => int(count, 0, COUNT_MAX));
      if (stars.length !== 5) fail();
      return {key: id(source.key), name: text(source.name, 100), stars: stars as ReviewSummary['sources'][number]['stars'], unrated: int(source.unrated, 0, COUNT_MAX)};
    }),
    waiting: int(value.waiting, 0, COUNT_MAX), forManagement: int(value.forManagement, 0, COUNT_MAX), failed: int(value.failed, 0, COUNT_MAX),
  };
}

function menuPart(value: unknown): MenuItem['part'] {
  if (!(MENU_PARTS as readonly unknown[]).includes(value)) fail();
  return value as MenuItem['part'];
}

function menu(raw: Obj): Menu {
  const value = object(raw, ['type', 'id', 'version', 'businessDate', 'source', 'items', 'notes']);
  const items = list(value.items, 2000, item => {
    const row = object(item, ['id', 'part', 'category', 'name', 'pricesCents'], ['group', 'description', 'volume', 'volumeMl', 'tip']);
    const pricesCents = list(row.pricesCents, 5, cents => int(cents, 0, 1e8));
    if (!pricesCents.length || (row.tip !== undefined && typeof row.tip !== 'boolean')) fail();
    return {
      id: id(row.id), part: menuPart(row.part), category: text(row.category, 100), group: optionalText(row.group, 100), name: text(row.name, 200),
      description: guestText(row.description, 1000), volume: guestText(row.volume, 40), volumeMl: row.volumeMl == null ? null : int(row.volumeMl, 1, 100000),
      pricesCents, tip: row.tip === true,
    };
  });
  if (new Set(items.map(item => item.id)).size !== items.length) fail();
  return {
    type: 'menu', id: id(value.id), version: int(value.version, 1, Number.MAX_SAFE_INTEGER), businessDate: date(value.businessDate), source: id(value.source), items,
    notes: list(value.notes, 100, item => {
      const note = object(item, ['part', 'category', 'text']);
      return {part: menuPart(note.part), category: text(note.category, 100), text: text(note.text, 500)};
    }),
  };
}

function costKind(value: unknown): SupplierInvoice['kind'] {
  if (!(COST_KINDS as readonly unknown[]).includes(value)) fail();
  return value as SupplierInvoice['kind'];
}

function supplierInvoice(raw: Obj): SupplierInvoice {
  const value = object(raw, ['type', 'id', 'version', 'businessDate', 'source', 'supplier', 'netCents', 'grossCents', 'kind', 'items'],
    ['supplierId', 'number', 'dueDate', 'paidDate', 'status', 'category']);
  if (value.status != null && value.status !== 'active' && value.status !== 'cancelled') fail();
  return {
    type: 'supplier_invoice', id: id(value.id), version: int(value.version, 1, Number.MAX_SAFE_INTEGER), businessDate: date(value.businessDate), source: id(value.source),
    supplier: text(value.supplier, 200), supplierId: value.supplierId == null ? null : id(value.supplierId), number: optionalText(value.number, 60),
    dueDate: value.dueDate == null ? null : date(value.dueDate), paidDate: value.paidDate == null ? null : date(value.paidDate),
    status: (value.status ?? 'active') as SupplierInvoice['status'], netCents: int(value.netCents, -1e10, 1e10), grossCents: int(value.grossCents, -1e10, 1e10),
    kind: costKind(value.kind), category: optionalText(value.category, 100),
    items: list(value.items, 500, item => {
      const row = object(item, ['name', 'quantity', 'unitPriceCents', 'netCents'], ['unit', 'kind', 'category']);
      if (typeof row.quantity !== 'number' || !Number.isFinite(row.quantity) || row.quantity <= 0 || row.quantity > 1e7) fail();
      return {name: text(row.name, 200), quantity: row.quantity as number, unit: optionalText(row.unit, 20), unitPriceCents: int(row.unitPriceCents, 0, 1e9),
        netCents: int(row.netCents, -1e10, 1e10), kind: row.kind == null ? null : costKind(row.kind), category: optionalText(row.category, 100)};
    }),
  };
}

export function validateBatch(raw: unknown): Batch {
  const value = object(raw, ['batchId', 'installationId', 'records']);
  if (typeof value.batchId !== 'string' || !/^[\w-]{8,128}$/.test(value.batchId)) fail();
  return {
    batchId: value.batchId as string, installationId: id(value.installationId),
    records: list(value.records, 500, item => {
      const row = item as Obj;
      if (row?.type === 'bill') return bill(row);
      if (row?.type === 'cash_closing') return cashClosing(row);
      if (row?.type === 'bottle_check') return bottleCheck(row);
      if (row?.type === 'reservation') return reservation(row);
      if (row?.type === 'web_traffic') return webTraffic(row);
      if (row?.type === 'review_summary') return reviewSummary(row);
      if (row?.type === 'event') return venueEvent(row);
      if (row?.type === 'menu') return menu(row);
      if (row?.type === 'supplier_invoice') return supplierInvoice(row);
      return fail();
    }),
  };
}

function phone(item: unknown): string {
  if (typeof item !== 'string' || !/^\+\d{8,15}$/.test(item)) fail();
  return item as string;
}

/** Only OneDrive / SharePoint share links over HTTPS. */
function shareLink(value: unknown): string {
  if (typeof value !== 'string' || value.length > 1000) fail();
  let url: URL;
  try { url = new URL((value as string).trim()); } catch { return fail(); }
  if (url.protocol !== 'https:' || !/(^|\.)(1drv\.ms|onedrive\.live\.com|sharepoint\.com)$/.test(url.hostname)) fail();
  return url.toString();
}

/** Only the bare HTTPS origin of an allowed website: no path, query, port or credentials. */
function website(raw: unknown): {url: string} {
  const value = object(raw, ['url']);
  if (typeof value.url !== 'string' || value.url.length > 200) fail();
  let url: URL;
  try { url = new URL((value.url as string).trim()); } catch { return fail(); }
  if (url.protocol !== 'https:' || !WEB_HOSTS.includes(url.hostname) || url.port || url.username || url.password
    || url.pathname !== '/' || url.search || url.hash) fail();
  return {url: url.origin};
}

/**
 * Prices of comparable venues nearby, read by Claude from their public menus (decision of MC, 14. 10. 2026): public
 * market data, nothing about guests. A basket of comparable items, with the menu item of ours each one is compared with;
 * prices in whole crowns as published, volumes in millilitres.
 */
export type CompetitorPrices = {
  checkedOn: string;
  basket: {item: string; label: string; volumeMl: number | null; ours: {name: string; category: string | null; group: string | null; priceIndex: number} | null}[];
  venues: {key: string; name: string; area: string | null; url: string; items: {item: string; name: string; priceCzk: number; volumeMl: number | null; note: string | null; approx: boolean}[]}[];
};
const VOLUME_MAX_ML = 5000;
export function validateCompetitorPrices(raw: unknown): CompetitorPrices {
  const value = object(raw, ['checkedOn', 'basket', 'venues']);
  const volume = (ml: unknown) => ml == null ? null : int(ml, 1, VOLUME_MAX_ML);
  const basket = list(value.basket, 30, entry => {
    const row = object(entry, ['item', 'label'], ['volumeMl', 'ours']);
    const ours = row.ours == null ? null : object(row.ours, ['name'], ['category', 'group', 'priceIndex']);
    return {item: id(row.item), label: text(row.label, 60), volumeMl: volume(row.volumeMl),
      ours: ours && {name: text(ours.name, 200), category: optionalText(ours.category, 100), group: optionalText(ours.group, 100), priceIndex: ours.priceIndex == null ? 0 : int(ours.priceIndex, 0, 4)}};
  });
  const items = new Set(basket.map(row => row.item));
  if (items.size !== basket.length) fail();
  const venues = list(value.venues, 30, entry => {
    const row = object(entry, ['key', 'name', 'url', 'items'], ['area']);
    if (typeof row.url !== 'string' || !/^https:\/\/[^\s]{1,500}$/.test(row.url)) fail();
    return {key: id(row.key), name: text(row.name, 100), area: optionalText(row.area, 60), url: row.url as string,
      items: list(row.items, 50, item => {
        const price = object(item, ['item', 'name', 'priceCzk'], ['volumeMl', 'note', 'approx']);
        if (price.approx !== undefined && typeof price.approx !== 'boolean') fail();
        if (!items.has(price.item as string)) fail();
        return {item: price.item as string, name: text(price.name, 200), priceCzk: int(price.priceCzk, 1, 100000), volumeMl: volume(price.volumeMl), note: optionalText(price.note, 200), approx: price.approx === true};
      })};
  });
  if (new Set(venues.map(row => row.key)).size !== venues.length) fail();
  return {checkedOn: date(value.checkedOn), basket, venues};
}

export function validateConfig(raw: unknown): TenantConfig {
  const value = object(raw, ['name', 'timeZone', 'businessDayCutoffHour', 'sendHours', 'registers', 'sections', 'recipients'], ['bottleCheck', 'reportsLink', 'dashboardPhones', 'web', 'location', 'disabledSources']);
  const timeZone = text(value.timeZone, 60);
  try { new Intl.DateTimeFormat('en', {timeZone}); } catch { fail(); }
  const sendHours = list(value.sendHours, 6, hour => int(hour, 0, 23));
  if (!sendHours.length || new Set(sendHours).size !== sendHours.length) fail();
  const sections = object(value.sections, Object.keys(value.sections ?? {}));
  if (Object.keys(sections).length > 20) fail();
  return {
    name: text(value.name, 80), timeZone, businessDayCutoffHour: int(value.businessDayCutoffHour, 0, 12), sendHours: [...sendHours].sort((a, b) => a - b),
    registers: list(value.registers, 20, id),
    sections: Object.fromEntries(Object.entries(sections).map(([key, label]) => [id(key), text(label, 40)])),
    recipients: list(value.recipients, 10, phone),
    dashboardPhones: value.dashboardPhones == null ? null : list(value.dashboardPhones, 3, phone),
    bottleCheck: value.bottleCheck == null ? null : {minLossCents: int(object(value.bottleCheck, ['minLossCents']).minLossCents, 0, 1e7)},
    reportsLink: value.reportsLink == null || value.reportsLink === '' ? null : shareLink(value.reportsLink),
    web: value.web == null ? null : website(value.web),
    location: value.location == null ? null : coordinates(value.location),
    disabledSources: value.disabledSources == null ? [] : list(value.disabledSources, 20, id),
  };
}

function coordinates(raw: unknown): {lat: number; lon: number} {
  const value = object(raw, ['lat', 'lon']);
  const degree = (input: unknown, limit: number) => {
    if (typeof input !== 'number' || !Number.isFinite(input) || Math.abs(input) > limit) fail();
    return Math.round((input as number) * 10000) / 10000;
  };
  return {lat: degree(value.lat, 90), lon: degree(value.lon, 180)};
}

/** Daily totals imported from a previous POS (for example a one-off rkeeper export), used for the plan. */
export function validateHistory(raw: unknown): HistoryRow[] {
  const value = object(raw, ['rows']);
  return list(value.rows, 1000, item => {
    const row = object(item, ['businessDate', 'revenueCents'], ['bills', 'guests']);
    return {
      businessDate: date(row.businessDate), revenueCents: int(row.revenueCents, 0),
      bills: row.bills == null ? null : int(row.bills, 0, 1e6), guests: row.guests == null ? null : int(row.guests, 0, 1e6),
    };
  });
}
