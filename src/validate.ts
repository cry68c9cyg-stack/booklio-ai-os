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
/** One table booking from the reservation system. No guest names or contacts, only counts. */
export type Reservation = {
  type: 'reservation'; id: string; version: number; businessDate: string; startsAt: string; section: string; partySize: number;
  status: 'pending' | 'confirmed' | 'declined' | 'expired' | 'cancelled'; arrival: 'arrived' | 'no_show' | null; source: string | null;
};
export const RESERVATION_STATUSES = ['pending', 'confirmed', 'declined', 'expired', 'cancelled'] as const;
export type IngestRecord = Bill | CashClosing | BottleCheck | Reservation;
export type Batch = {batchId: string; installationId: string; records: IngestRecord[]};

export type TenantConfig = {
  name: string; timeZone: string; businessDayCutoffHour: number; sendHours: number[];
  registers: string[]; sections: Record<string, string>; recipients: string[];
  /** Set = the venue counts bottles every morning: show losses from `minLossCents` up and say when the count is missing. */
  bottleCheck: {minLossCents: number} | null;
};
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

function reservation(raw: Obj): Reservation {
  const value = object(raw, ['type', 'id', 'version', 'businessDate', 'startsAt', 'section', 'partySize', 'status'], ['arrival', 'source']);
  if (!(RESERVATION_STATUSES as readonly unknown[]).includes(value.status)) fail();
  if (value.arrival != null && value.arrival !== 'arrived' && value.arrival !== 'no_show') fail();
  return {
    type: 'reservation', id: id(value.id), version: int(value.version, 1), businessDate: date(value.businessDate), startsAt: instant(value.startsAt),
    section: id(value.section), partySize: int(value.partySize, 1, 1000), status: value.status as Reservation['status'],
    arrival: (value.arrival ?? null) as Reservation['arrival'], source: value.source == null ? null : id(value.source),
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
      return fail();
    }),
  };
}

export function validateConfig(raw: unknown): TenantConfig {
  const value = object(raw, ['name', 'timeZone', 'businessDayCutoffHour', 'sendHours', 'registers', 'sections', 'recipients'], ['bottleCheck']);
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
    recipients: list(value.recipients, 10, item => {
      if (typeof item !== 'string' || !/^\+\d{8,15}$/.test(item)) fail();
      return item as string;
    }),
    bottleCheck: value.bottleCheck == null ? null : {minLossCents: int(object(value.bottleCheck, ['minLossCents']).minLossCents, 0, 1e7)},
  };
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
