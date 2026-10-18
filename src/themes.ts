/**
 * Topics of "Report dne" (the manager's free text), found by words, so OKO1 sees what keeps coming back without
 * sending the text anywhere (MC, 18. 10. 2026: "jaké věci se opakují v těch reportech, co je potřeba řešit").
 * The text stays in the venue's database; only the topic keys and counts are worked out from it.
 */
export type Theme = {key: string; name: string; tip: string; warn: boolean};
type Rule = Theme & {match: RegExp};

/** Words are matched without diacritics and in lower case ("nešli" → "nesli"). */
const RULES: Rule[] = [
  {key: 'health', name: 'zdravotní incident', warn: true, match: /omdl|sanitk|zachrank|prvni pomoc|zranen|zranil|nevolnost|krvac|upadl/,
    tip: 'zapsat, co se stalo a kdo pomáhal, a zkontrolovat lékárničku'},
  {key: 'security', name: 'konflikt nebo bezpečnost', warn: true, match: /konflikt|rvack|bitk|agresiv|vyhozen|vyveden|polici|kradez|ukradl|ukradli/,
    tip: 'projít se security, kde a kdy se to děje, a zvážit posílení u vstupu'},
  {key: 'cash', name: 'chybí hotovost na výplaty', warn: true, match: /vyplat[^.]*(nestac|pockat|cekat|zbytek)|nestacil[ao]? (hotovost|penize)|chybi hotovost|malo hotovosti|(na uctu|v kase) uz (bylo|zbylo) jen/,
    tip: 'plánovat výplaty z kasy podle tržeb dopředu nebo část vyplácet převodem'},
  {key: 'tech', name: 'porucha', warn: true, match: /porouch|porucha|nefung|vypadek|nejde (terminal|pokladna|svetlo|zvuk)|zaseknut/,
    tip: 'nahlásit opravu a sledovat, jestli se porucha vrací'},
  {key: 'staff', name: 'chybí personál', warn: true, match: /neprisel|nedorazil[ao]?|omluvil[ao]? se|nemocn|chybel[ao]? (barman|cisni|kuchar|security|hosteska)|prisel pozde|prisla pozde/,
    tip: 'mít na každou směnu domluveného náhradníka'},
  {key: 'stock', name: 'došlo zboží', warn: true, match: /\bdosl[oaiy]?\b|\bdosel\b|nemeli jsme|chybel[ao]? (pivo|led|zbozi|limonad)/,
    tip: 'upravit objednávky u dodavatele, ať zboží nedochází'},
  {key: 'complaint', name: 'stížnost hosta', warn: true, match: /stiznost|reklamac|nespokojen|stezoval/,
    tip: 'projít stížnosti s vedoucím směny a odpovědět hostům'},
  {key: 'menu', name: 'položka se neprodává', warn: false, match: /\bnesl[aiy]?\b|neprodal[aiy]?|neprodava|nikdo nechtel/,
    tip: 'prověřit položku v lístku (cena, popis, místo v lístku) nebo ji vyřadit'},
  {key: 'slow', name: 'slabý provoz', warn: false, match: /pomal|slab|prazdn|malo lidi|malo hostu/,
    tip: 'na slabé dny chystat akci nebo kampaň (OKO1 je hlásí dopředu)'},
  {key: 'busy', name: 'plno', warn: false, match: /\bplno\b|narvan|fronta|vyprodan/,
    tip: 'na podobné dny posílit směnu'},
  {key: 'city', name: 'akce ve městě', warn: false, match: /akc[ei] po cel|festival|\bsignal\b|ve meste|zapas/,
    tip: 'akce ve městě brát do plánu směn a nabídky'},
];
export const THEMES: Theme[] = RULES.map(({match: _, ...theme}) => theme);

/** "bez problémů a konfliktů", "žádná stížnost": a topic said not to have happened does not count. */
const NEGATED = /(\bbez\b|\bzadn\w*|\bnebyl\w*|\bnikdo)[^.!?\n]*$/;
const plain = (value: string) => value.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/** Topics of one day's text, in the order of THEMES. Lines that are only the DJ of the day are not part of the text. */
export function noteThemes(text: string | null | undefined): string[] {
  if (!text) return [];
  const body = plain(text.split('\n').filter(entry => !/^DJ:/.test(entry)).join('\n'));
  return RULES.filter(rule => [...body.matchAll(new RegExp(rule.match.source, 'g'))].some(found => !NEGATED.test(body.slice(Math.max(0, found.index! - 25), found.index))))
    .map(rule => rule.key);
}

/** The DJ of the night as the daily report names it ("DJ: Pavel"). */
export function djOf(text: string | null | undefined): string | null {
  const found = text?.match(/(?:^|\n)DJ: ([^\n]+)/);
  const name = found?.[1].trim();
  return name ? name.slice(0, 40) : null;
}

export type ThemeSummary = {from: string; to: string; days: number; themes: {key: string; name: string; tip: string; warn: boolean; days: number; last: string}[]};
/** Over a stretch of days with a text: on how many days each topic came up, most frequent first. */
export function summarizeThemes(from: string, to: string, days: {date: string; themes: string[]}[]): ThemeSummary {
  const themes = THEMES.map(theme => {
    const hits = days.filter(day => day.themes.includes(theme.key)).map(day => day.date).sort();
    return {...theme, days: hits.length, last: hits.at(-1) ?? ''};
  }).filter(theme => theme.days > 0).sort((a, b) => b.days - a.days || THEMES.findIndex(t => t.key === a.key) - THEMES.findIndex(t => t.key === b.key));
  return {from, to, days: days.length, themes};
}

/** "Report dne za 4 týdny (12 dní s textem): slabý provoz 5×, chybí hotovost na výplaty 2× · Co řešit: …" */
export function renderThemes(summary: ThemeSummary | null | undefined): string[] {
  if (!summary?.themes.length) return [];
  const lines = [`Report dne za 4 týdny (${summary.days} ${summary.days === 1 ? 'den' : summary.days <= 4 ? 'dny' : 'dní'} s textem): ${summary.themes.map(theme => `${theme.name} ${theme.days}×`).join(', ')}`];
  // What to do: topics that need someone, the ones that came back first.
  const todo = summary.themes.filter(theme => theme.warn || theme.days >= 2).slice(0, 3);
  if (todo.length) lines.push(`Co řešit: ${todo.map(theme => `${theme.name} – ${theme.tip}`).join(' · ')}`);
  return lines;
}

export type DjNight = {date: string; dj: string; clubCents: number; usualCents: number | null};
export type DjRank = {dj: string; nights: number; averageCents: number; changePermille: number | null};
/** Club revenue by the DJ of the night: average, and against the usual club revenue of the same weekday (median of the ratios). */
export function rankDjs(nights: DjNight[]): DjRank[] {
  const by = new Map<string, DjNight[]>();
  for (const night of nights) by.set(night.dj, [...(by.get(night.dj) ?? []), night]);
  const median = (values: number[]) => { const sorted = [...values].sort((a, b) => a - b), middle = Math.floor(sorted.length / 2); return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2; };
  return [...by].filter(([, list]) => list.length >= 2).map(([dj, list]) => {
    const ratios = list.filter(night => night.usualCents).map(night => night.clubCents / night.usualCents!);
    return {dj, nights: list.length, averageCents: Math.round(list.reduce((sum, night) => sum + night.clubCents, 0) / list.length),
      changePermille: ratios.length >= 2 ? Math.round((median(ratios) - 1) * 1000) : null};
  }).sort((a, b) => (b.changePermille ?? -9999) - (a.changePermille ?? -9999) || b.averageCents - a.averageCents);
}
