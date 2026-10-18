/**
 * Batch „Incidenty a personál“ (MC „jo“ 18. 10. 2026): a log of health incidents and security interventions from the
 * „Report dne“ texts (for the insurer and for checks), the staff meals of the month, and the foreign cash the till took in
 * (euros, dollars, pounds in the evening count) as a sign of guests from abroad. Everything stays in the venue's database.
 */
import {addDays} from './time.ts';

const plain = (value: string) => value.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const kc = (cents: number) => (cents < 0 ? '−' : '') + String(Math.round(Math.abs(cents) / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ') + ' Kč';
const MONTHS_IN = ['v lednu', 'v únoru', 'v březnu', 'v dubnu', 'v květnu', 'v červnu', 'v červenci', 'v srpnu', 'v září', 'v říjnu', 'v listopadu', 'v prosinci'];

/** The two kinds the log keeps; the words match the topics of src/themes.ts. */
const KINDS = [
  {kind: 'health', name: 'zdravotní', match: /omdl|sanitk|zachrank|prvni pomoc|zranen|zranil|nevolnost|krvac|upadl/},
  {kind: 'security', name: 'bezpečnost', match: /konflikt|rvack|bitk|agresiv|vyhozen|vyveden|polici|kradez|ukradl|ukradli/},
] as const;
export type IncidentKind = typeof KINDS[number]['kind'];
const NEGATED = /(\bbez\b|\bzadn\w*|\bnebyl\w*|\bnikdo)[^.!?\n]*$/;
const PLACES: [RegExp, string][] = [[/texac/, 'Texaco'], [/\b(club|klub)\w*|nahore|dole\b/, 'Klub'], [/\bbar\w*/, 'Bar'], [/restaurac|diner/, 'Restaurace'],
  [/vstup|vchod|dver|pred podnikem|na ulici/, 'Vstup'], [/teras|zahradk/, 'Terasa'], [/\bwc\b|toalet|zachod/, 'WC']];

export type Incident = {date: string; kind: IncidentKind; name: string; place: string | null; text: string};
/** Each sentence of the day's text that tells of an incident (not one said not to have happened), with the place it names. */
export function incidents(date: string, text: string | null | undefined): Incident[] {
  if (!text) return [];
  const found: Incident[] = [];
  const sentences = text.split('\n').filter(entry => !/^DJ:/.test(entry)).join('\n').split(/(?<=[.!?])\s+|\n+/).map(entry => entry.trim()).filter(Boolean);
  for (const sentence of sentences) {
    const body = plain(sentence);
    for (const {kind, name, match} of KINDS) {
      const hit = [...body.matchAll(new RegExp(match.source, 'g'))].some(entry => !NEGATED.test(body.slice(0, entry.index)));
      if (hit) found.push({date, kind, name, place: PLACES.find(([pattern]) => pattern.test(body))?.[1] ?? null, text: sentence.slice(0, 240)});
    }
  }
  return found;
}

/** On the last day of a month: "Incidenty v říjnu: 3 (zdravotní 2, bezpečnost 1), nejčastěji Texaco" */
export function renderIncidents(month: string, list: Incident[] | null | undefined): string[] {
  if (!list?.length) return [];
  const count = (kind: IncidentKind) => list.filter(entry => entry.kind === kind).length;
  const kinds = KINDS.map(entry => [entry.name, count(entry.kind)] as const).filter(([, n]) => n).map(([name, n]) => `${name} ${n}`);
  const places = new Map<string, number>();
  for (const entry of list) if (entry.place) places.set(entry.place, (places.get(entry.place) ?? 0) + 1);
  const top = [...places].sort((a, b) => b[1] - a[1])[0];
  return [`Incidenty ${MONTHS_IN[Number(month.slice(5)) - 1]}: ${list.length} (${kinds.join(', ')})${top && top[1] >= 2 ? `, nejčastěji ${top[0]}` : ''}`];
}

/** Staff meals ("Personál" discounts) of a stretch of days: bills, amount and share of the revenue. */
export type StaffMeals = {bills: number; cents: number; revenueCents: number};
export const staffMealsText = (meals: StaffMeals) =>
  `jídla personálu ${meals.bills ? `${meals.bills} účtů, ` : ''}${kc(meals.cents)}${meals.revenueCents > 0 ? ` (${String(Math.round(meals.cents / meals.revenueCents * 1000) / 10).replace('.', ',')} % tržby)` : ''}`;

/** Euros, dollars and pounds in the evening count (as the count values them in crowns), by day. */
export type ForeignCash = {date: string; byCurrency: Record<string, number>};
const CURRENCIES: [string, string][] = [['euro', 'eura'], ['dolar', 'dolary'], ['libra', 'libry']];
/** What the till took in foreign cash over 7 days: the rises from one evening count to the next, by currency, against the 7 days before. */
export type ForeignWeek = {from: string; to: string; cents: number; byCurrency: {name: string; cents: number}[]; previousCents: number | null};
export function foreignWeek(to: string, days: (ForeignCash | null)[]): ForeignWeek | null {
  // `days` = 15 consecutive days ending with the reported one; a rise counts only between two days that both have a count.
  if (days.length < 15) return null;
  const rises = (from: number, to: number) => {
    const sums = new Map<string, number>();
    let pairs = 0;
    for (let i = from; i <= to; i++) {
      const before = days[i - 1], now = days[i];
      if (!before || !now) continue;
      pairs++;
      for (const [key] of CURRENCIES) { const rise = (now.byCurrency[key] ?? 0) - (before.byCurrency[key] ?? 0); if (rise > 0) sums.set(key, (sums.get(key) ?? 0) + rise); }
    }
    return pairs >= 4 ? sums : null;
  };
  const now = rises(8, 14), before = rises(1, 7);
  if (!now) return null;
  const total = (sums: Map<string, number>) => [...sums.values()].reduce((sum, value) => sum + value, 0);
  return {from: addDays(to, -6), to, cents: total(now),
    byCurrency: CURRENCIES.map(([key, name]) => ({name, cents: now.get(key) ?? 0})).filter(row => row.cents > 0),
    previousCents: before ? total(before) : null};
}
/** Monday: "Cizí měny v kase za týden: přibylo 12 400 Kč (eura 9 000 Kč, dolary 2 400 Kč), týden předtím 8 000 Kč (+55 %)" */
export function renderForeignWeek(week: ForeignWeek | null | undefined): string[] {
  if (!week || !week.cents) return [];
  const change = week.previousCents ? ` (${week.cents >= week.previousCents ? '+' : '−'}${Math.round(Math.abs(week.cents / week.previousCents - 1) * 100)} %)` : '';
  return [`Cizí měny v kase za týden: přibylo ${kc(week.cents)} (${week.byCurrency.map(row => `${row.name} ${kc(row.cents)}`).join(', ')})` +
    `${week.previousCents !== null ? `, týden předtím ${kc(week.previousCents)}${change}` : ''}`];
}

export const isMonthEnd = (date: string) => addDays(date, 1).endsWith('-01');
