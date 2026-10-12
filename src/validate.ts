import {isDate} from './time.ts';

/** Thrown for any input that does not match the contract; the message is a stable error code. */
export class InputError extends Error {}

export type BillItem = {name: string; productId: string | null; category: string | null; quantity: number; totalCents: number};
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
  guest?: ReservationGuest;
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
export const RESERVATION_STATUSES = ['pending', 'confirmed', 'declined', 'expired', 'cancelled'] as const;
export type IngestRecord = Bill | CashClosing | BottleCheck | Reservation | WebTraffic | ReviewSummary;
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
      const row = object(item, ['name', 'quantity', 'totalCents'], ['productId', 'category']);
      if (typeof row.quantity !== 'number' || !Number.isFinite(row.quantity) || row.quantity <= 0 || row.quantity > 1e6) fail();
      return {name: text(row.name), productId: row.productId == null ? null : id(row.productId), category: optionalText(row.category, 60), quantity: row.quantity as number, totalCents: int(row.totalCents)};
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
  const value = object(raw, ['type', 'id', 'version', 'businessDate', 'startsAt', 'section', 'partySize', 'status'], ['arrival', 'source', 'guest']);
  if (!(RESERVATION_STATUSES as readonly unknown[]).includes(value.status)) fail();
  if (value.arrival != null && value.arrival !== 'arrived' && value.arrival !== 'no_show') fail();
  return {
    type: 'reservation', id: id(value.id), version: int(value.version, 1, Number.MAX_SAFE_INTEGER), businessDate: date(value.businessDate), startsAt: instant(value.startsAt),
    section: id(value.section), partySize: int(value.partySize, 1, 1000), status: value.status as Reservation['status'],
    arrival: (value.arrival ?? null) as Reservation['arrival'], source: value.source == null ? null : id(value.source),
    ...(value.guest === undefined ? {} : {guest: guest(value.guest)}),
  };
}

const COUNT_MAX = 10_000_000;
function webTraffic(raw: Obj): WebTraffic {
  const value = object(raw, ['type', 'id', 'version', 'businessDate', 'visits', 'visitsWithAction', 'origins', 'actions', 'reviewScans']);
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

export function validateConfig(raw: unknown): TenantConfig {
  const value = object(raw, ['name', 'timeZone', 'businessDayCutoffHour', 'sendHours', 'registers', 'sections', 'recipients'], ['bottleCheck', 'reportsLink', 'dashboardPhones', 'web', 'location']);
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
