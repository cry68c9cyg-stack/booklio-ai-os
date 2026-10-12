/**
 * Live views over the website's tables for the MCP tools and the dashboard (docs/web-v1.md): bookings with their
 * tables, one booking in detail, one guest, today's card. Everything is read at the moment of the question and only
 * returned, never stored.
 */
import {addDays, businessDate, localTime} from './time.ts';
import {MAX_ROWS, webTable, webVisits, type Fetched, type TableFilter, type WebRow, type WebSite} from './web-client.ts';

/** Bookings that still hold a table: waiting for the staff or confirmed. */
export const ACTIVE_BOOKINGS = ['nova', 'potvrzena'];
/** Reviews waiting for a reply in the admin. */
export const WAITING_REVIEWS = ['nova', 'ke_kontrole', 'pro_vedeni'];
/** A guest is on the blacklist from three no-shows on confirmed bookings, unless the staff removed them since. */
const BLACKLIST = 3;
/** Up to this many bookings their tables are read one by one; more read the whole (small) table at once. */
const TABLES_ONE_BY_ONE = 30;

const key = (value: unknown) => typeof value === 'number' || typeof value === 'string' ? String(value) : '';

/** Runs `work` for every item, at most `size` at a time. */
async function inBatches<T, R>(items: T[], size: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = [];
  for (let i = 0; i < items.length; i += size) results.push(...await Promise.all(items.slice(i, i + size).map(work)));
  return results;
}

/** Table IDs (p4 = ground floor 4, kA = club box A) of the given bookings. */
export async function tablesOf(site: WebSite, ids: string[]): Promise<Fetched<Map<string, string[]>>> {
  const tables = new Map<string, string[]>();
  const add = (rows: WebRow[]) => { for (const row of rows) { const id = key(row.rezervace_id); if (ids.includes(id)) tables.set(id, [...tables.get(id) ?? [], key(row.stul)]); } };
  if (!ids.length) return {ok: true, value: tables};
  if (ids.length <= TABLES_ONE_BY_ONE) {
    const reads = await inBatches(ids, 6, id => webTable(site, 'rezervace_stoly', {rovno: [['rezervace_id', id]]}));
    for (const read of reads) { if (!read.ok) return read; add(read.value.rows); }
    return {ok: true, value: tables};
  }
  const read = await webTable(site, 'rezervace_stoly', {}, 50000);
  if (!read.ok) return read;
  add(read.value.rows);
  return read.value.truncated ? {ok: false, error: 'stolů je víc, než jde najednou přečíst'} : {ok: true, value: tables};
}

/** Bookings narrowed on the web, each with its tables (`stoly`). Tables that cannot be read are a warning, not a failure. */
export async function bookings(site: WebSite, filter: TableFilter, maxRows = MAX_ROWS): Promise<Fetched<{rows: WebRow[]; truncated: boolean; warnings: string[]}>> {
  const read = await webTable(site, 'rezervace', filter, maxRows);
  if (!read.ok) return read;
  const tables = await tablesOf(site, read.value.rows.map(row => key(row.id)));
  const warnings = tables.ok ? [] : [`Stoly rezervací se nepodařilo načíst: ${tables.error}.`];
  const rows = read.value.rows.map(row => ({...row, stoly: tables.ok ? tables.value.get(key(row.id)) ?? [] : null}));
  return {ok: true, value: {rows, truncated: read.value.truncated, warnings}};
}

/** A contact the way the web stores it: a phone as +420606123456 (nine digits = Czech), an e-mail in lower case. */
export function normaliseContact(value: string): string | null {
  const text = value.trim();
  if (text.includes('@')) return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(text) && text.length <= 254 ? text.toLowerCase() : null;
  const number = text.replace(/[\s().\/-]/g, '');
  const international = number.startsWith('+') ? number.slice(1) : number.startsWith('00') ? number.slice(2) : null;
  if (international !== null) return /^[1-9]\d{7,14}$/.test(international) ? `+${international}` : null;
  if (/^\d{9}$/.test(number)) return `+420${number}`;
  return /^420\d{9}$/.test(number) ? `+${number}` : null;
}

/** One guest by contact: entries in the guest database, bookings, no-shows, blacklist state and invitation consent. */
export async function guest(site: WebSite, contact: string) {
  const value = normaliseContact(contact);
  if (!value) return {ok: false, error: 'Kontakt není telefon ani e-mail.'} as const;
  const by = (table: string) => webTable(site, table, {rovno: [['kontakt', value]]}, 1000);
  const [guests, stays, noShows, removed, invitations] = await Promise.all([by('hoste'), by('rezervace'), by('nedorazeni'), by('cerna_listina_vyrazeni'), by('hoste_pozvanky')]);
  for (const read of [guests, stays, noShows, removed, invitations]) if (!read.ok) return read;
  const count = noShows.ok ? noShows.value.rows.length : 0;
  const removedAt = removed.ok ? removed.value.rows.map(row => Number(row.pocet)).find(Number.isFinite) ?? null : null;
  return {ok: true, value: {
    kontakt: value,
    hoste: guests.ok ? guests.value.rows : [], rezervace: stays.ok ? stays.value.rows : [], nedorazeni: noShows.ok ? noShows.value.rows : [],
    cernaListina: {pocetNedorazeni: count, vyrazenoPriPoctu: removedAt, naListine: count >= BLACKLIST && (removedAt === null || count > removedAt)},
    pozvanky: invitations.ok ? invitations.value.rows : [],
  }} as const;
}

/** One booking by code (JD-7KQ2, also without "JD-") or id, with its tables, messages and payments. Null = not found. */
export async function bookingDetail(site: WebSite, by: {kod?: string; id?: number}): Promise<Fetched<Record<string, unknown> | null>> {
  const code = by.kod?.trim().toUpperCase();
  const filter: TableFilter = code ? {rovno: [['kod', code.startsWith('JD-') ? code : `JD-${code}`]]} : {rovno: [['id', by.id ?? -1]]};
  const read = await webTable(site, 'rezervace', filter, 2);
  if (!read.ok) return read;
  const booking = read.value.rows[0];
  if (!booking) return {ok: true, value: null};
  const of = (table: string) => webTable(site, table, {rovno: [['rezervace_id', key(booking.id)]]}, 1000);
  const [tables, messages, payments] = await Promise.all([of('rezervace_stoly'), of('zpravy'), of('platby')]);
  for (const part of [tables, messages, payments]) if (!part.ok) return part;
  return {ok: true, value: {
    rezervace: booking,
    stoly: tables.ok ? tables.value.rows.map(row => key(row.stul)) : [],
    zpravy: messages.ok ? messages.value.rows : [], platby: payments.ok ? payments.value.rows : [],
  }};
}

export type VisitDay = {den: string; navstevy: number; sAkci: number; skenyHodnoceni: number};

/** One day from the web's visits (`statistiky.dny`); a day missing there had no visits. Null when the shape is unknown. */
export function visitsDay(visits: Record<string, unknown>, date: string): VisitDay | null {
  const stats = visits.statistiky as {dny?: unknown} | undefined;
  if (!stats || !Array.isArray(stats.dny)) return null;
  const entry = (stats.dny as Record<string, unknown>[]).find(item => item?.den === date);
  const number = (value: unknown) => typeof value === 'number' ? value : 0;
  return {den: date, navstevy: number(entry?.navstevy), sAkci: number(entry?.sAkci), skenyHodnoceni: number(entry?.skenyHodnoceni)};
}

export type VenueClock = {name: string; timeZone: string; businessDayCutoffHour: number};
const text = (value: unknown) => typeof value === 'string' ? value : typeof value === 'number' ? String(value) : null;

/**
 * The dashboard card "Web {venue}", read live: today's bookings with names and contacts (the venue's business day),
 * bookings waiting for the staff, visits today and yesterday and reviews waiting for a reply.
 */
export async function dashboardWeb(site: WebSite, venue: VenueClock, now: Date) {
  const today = businessDate(now, venue.timeZone, venue.businessDayCutoffHour);
  const calendar = localTime(now, venue.timeZone).date;
  const [day, pending, visits, ...reviews] = await Promise.all([
    bookings(site, {od: today, do: today}, 1000),
    webTable(site, 'rezervace', {rovno: [['stav', 'nova']]}, 1000),
    webVisits(site, addDays(calendar, -1)),
    ...WAITING_REVIEWS.map(stav => webTable(site, 'recenze', {rovno: [['stav', stav]]}, 200)),
  ]);
  if (!day.ok) return day;
  if (!pending.ok) return pending;
  const warnings = [...day.value.warnings];
  const waiting: WebRow[] = [];
  for (const read of reviews) { if (read.ok) waiting.push(...read.value.rows); else warnings.push(`Recenze se nepodařilo načíst: ${read.error}.`); }
  if (!visits.ok) warnings.push(`Návštěvnost se nepodařilo načíst: ${visits.error}.`);
  const active = day.value.rows.filter(row => ACTIVE_BOOKINGS.includes(String(row.stav)))
    .sort((a, b) => String(a.zacatek ?? '').localeCompare(String(b.zacatek ?? '')) || String(a.cas ?? '').localeCompare(String(b.cas ?? '')));
  waiting.sort((a, b) => String(b.datum ?? '').localeCompare(String(a.datum ?? '')));
  const visitsToday = visits.ok ? visitsDay(visits.value, calendar) : null;
  return {ok: true, value: {
    name: `Web ${venue.name}`, readAt: now.toISOString(), timeZone: venue.timeZone, today, warnings,
    reservations: active.map(row => ({
      cas: text(row.cas), jmeno: text(row.jmeno), osoby: text(row.osoby), prostor: text(row.prostor), stoly: (row.stoly as string[] | null) ?? [],
      stav: text(row.stav), kontakt: text(row.kontakt), poznamka: text(row.poznamka),
    })),
    otherReservations: day.value.rows.length - active.length, pending: pending.value.rows.length,
    visits: visits.ok && visitsToday ? {today: visitsToday, yesterday: visitsDay(visits.value, addDays(calendar, -1))} : null,
    reviews: waiting.slice(0, 10).map(row => ({zdroj: text(row.zdroj), hvezdicky: text(row.hvezdicky), autor: text(row.autor), datum: text(row.datum),
      stav: text(row.stav), text: text(row.text)?.slice(0, 300) ?? null})),
    reviewsWaiting: waiting.length,
  }} as const;
}
