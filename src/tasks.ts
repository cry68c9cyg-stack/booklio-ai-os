/**
 * Batch „Úkoly lidem“ (MC „jo“ 18. 10. 2026): each person gets at the morning send hour only their items of "K vyřízení",
 * by the money at stake; what nobody switched to "Vyřízeno" carries over to the next days with the day it first appeared;
 * on Monday who handled how many in the week and what has been open for more than 3 days.
 * Addresses only in the Worker secret STAFF_MAIL_<TENANT> ("Matěj=matej@jamesdean.cz; Nancy=nancy@jamesdean.cz"), never in Git;
 * a person without an address gets their list in the venue's mailbox (info@), which Nancy and the managers read.
 */
import type {TodoItem} from './todo.ts';
import {addDays} from './time.ts';

/** How far back an item that is still open carries over. */
export const CARRY_DAYS = 7;
/** Open for more than this many days = in the Monday overview as hanging. */
export const HANGING_DAYS = 3;

/** Signals of the current state: they come again by themselves while they hold, so an old copy does not carry over. */
const STATE = /^(Report za den chybí|Hotovost na dnešek|Dluhy ve výčetce|Výplaty|Riziko mank|No-show|Recenze klesají|Slabé recenze|Recenze čekají|Odpovědi na recenze|.* neposílá data|Doplnit chybějící data|Rezervace na dnešek|Na příštích 7 dní|Slabší výhled|Web:|Ranní kontrola lahví|Food cost|Cena v pokladně nesedí)/;

/** One item as stored with the day's message. */
export type StoredTodo = {date: string; key: string; level: TodoItem['level']; text: string; amountCents: number | null; owner: string | null};
export type CarriedTodo = TodoItem & {key: string; since: string};

/**
 * Warnings of the CARRY_DAYS days before `day` not switched to "Vyřízeno" since they first appeared and not in today's list again,
 * each once with its first day, the latest copy's text, by the money at stake.
 */
export function carriedTodos(day: string, stored: StoredTodo[], doneSince: (key: string, since: string) => boolean, todayKeys: Set<string>): CarriedTodo[] {
  const first = new Map<string, StoredTodo & {since: string}>();
  for (const row of [...stored].sort((a, b) => a.date.localeCompare(b.date))) {
    if (row.level !== 'warn' || row.date >= day || row.date < addDays(day, -CARRY_DAYS) || STATE.test(row.text) || todayKeys.has(row.key)) continue;
    const seen = first.get(row.key);
    first.set(row.key, {...row, since: seen?.since ?? row.date});
  }
  return [...first.values()].filter(row => !doneSince(row.key, row.since))
    .sort((a, b) => Math.abs(b.amountCents ?? -1) - Math.abs(a.amountCents ?? -1) || a.since.localeCompare(b.since))
    .map(row => ({level: row.level, text: row.text, amountCents: row.amountCents, owner: row.owner, key: row.key, since: row.since}));
}

/** "Matěj=matej@jamesdean.cz; Nancy=nancy@jamesdean.cz, n2@jamesdean.cz" → person → addresses (at most 5 each). */
export function parseStaff(raw: string, valid: (address: string) => boolean): Map<string, string[]> {
  const staff = new Map<string, string[]>();
  for (const part of raw.split(/[;\n]+/)) {
    const [name, addresses] = part.split('=');
    if (!name?.trim() || !addresses) continue;
    const list = [...new Set(addresses.split(/[,\s]+/).map(address => address.trim().toLowerCase()).filter(valid))].slice(0, 5);
    if (list.length) staff.set(name.trim().toLocaleLowerCase('cs'), list);
  }
  return staff;
}

const dayMonth = (date: string) => `${Number(date.slice(8))}. ${Number(date.slice(5, 7))}.`;

export type WeekRow = {owner: string; done: number; hanging: number};
/** Monday: per person the items switched to "Vyřízeno" in the 7 days to `day` and the ones open for more than HANGING_DAYS days. */
export function todoWeek(day: string, stored: StoredTodo[], done: {date: string; key: string}[], open: CarriedTodo[]): WeekRow[] {
  const owners = new Map<string, string>();
  for (const row of stored) if (row.owner) owners.set(row.key, row.owner);
  const rows = new Map<string, WeekRow>();
  const row = (owner: string) => rows.get(owner) ?? rows.set(owner, {owner, done: 0, hanging: 0}).get(owner)!;
  for (const entry of new Map(done.filter(entry => entry.date > addDays(day, -7) && entry.date <= day).map(entry => [entry.key, entry])).values()) {
    const owner = owners.get(entry.key);
    if (owner) row(owner).done++;
  }
  for (const item of open) if (item.owner && item.since < addDays(day, -HANGING_DAYS)) row(item.owner).hanging++;
  return [...rows.values()].sort((a, b) => a.owner.localeCompare(b.owner, 'cs'));
}

export function renderTodoWeek(rows: WeekRow[]): string[] {
  if (!rows.length) return [];
  return [`Úkoly za týden: ${rows.map(row => `${row.owner} ${row.done} vyřízeno${row.hanging ? `, ${row.hanging} visí přes ${HANGING_DAYS} dny` : ''}`).join(' · ')}`];
}

/** The e-mail with one person's items: today's by the money at stake, then the ones carried over, the Monday line, the link. */
export function todoMail(owner: string, day: string, venue: string, today: TodoItem[], carried: CarriedTodo[], week: WeekRow | null, link: string | null): {subject: string; text: string} {
  const count = today.length + carried.length;
  const line = (item: TodoItem, i: number) => `${i + 1}. ${item.level === 'warn' ? '⚠ ' : ''}${item.text}`;
  const text = [
    `Dobrý den,`, ``,
    count ? `k vyřízení za ${dayMonth(day)} (${venue}), seřazeno podle částky, o kterou jde:` : `za ${dayMonth(day)} nemáte nic k vyřízení.`,
    ...today.map(line),
    ...(carried.length ? [``, `Visí z předchozích dnů:`, ...carried.map((item, i) => `${line(item, today.length + i)} (od ${dayMonth(item.since)})`)] : []),
    ...(week ? [``, `Za týden vyřízeno ${week.done}${week.hanging ? `, déle než ${HANGING_DAYS} dny visí ${week.hanging}` : ''}.`] : []),
    ``, `Co je hotové, odškrtněte na dashboardu tlačítkem „Vyřízeno“${link ? `: ${link}` : '.'}`,
    `Když něco vyřešit nejde, odpovězte na tento e-mail a napište proč.`, ``, `OKO1`,
  ].join('\n');
  return {subject: `K vyřízení ${dayMonth(day)}: ${count} ${count === 1 ? 'bod' : count >= 2 && count <= 4 ? 'body' : 'bodů'} – ${owner}`, text};
}
