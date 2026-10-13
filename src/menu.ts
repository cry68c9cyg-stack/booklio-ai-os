/**
 * The venue's food and drink menu as the website publishes it (record `menu`, docs/ingest-v1.md). OKO1 keeps the latest
 * menu and every change of it (new item, removed item, new price), so the price of any item on any day is known: the base
 * for prices, food cost, menu engineering, simulated repricing and profit by item (spec, decision of MC 12. 10. 2026).
 */
import type {Menu, MenuItem} from './validate.ts';

export type MenuChange = {itemId: string; name: string; kind: 'added' | 'removed' | 'price'; oldCents: number | null; newCents: number | null; oldText: string | null; newText: string | null};

/** Prices as one text, the way the menu lists them: "225 / 255 Kč". */
export const priceText = (item: MenuItem) => item.pricesCents.map(cents => String(Math.round(cents / 100)).replace(/\B(?=(\d{3})+$)/g, ' ')).join(' / ') + ' Kč';

/** What changed from one menu to the next, by item id. A different price of any size counts as a price change. */
export function menuChanges(before: Menu, after: Menu): MenuChange[] {
  const old = new Map(before.items.map(item => [item.id, item]));
  const now = new Map(after.items.map(item => [item.id, item]));
  const changes: MenuChange[] = [];
  for (const item of after.items) {
    const was = old.get(item.id);
    if (!was) changes.push({itemId: item.id, name: item.name, kind: 'added', oldCents: null, newCents: item.pricesCents[0], oldText: null, newText: priceText(item)});
    else if (was.pricesCents.join() !== item.pricesCents.join()) {
      changes.push({itemId: item.id, name: item.name, kind: 'price', oldCents: was.pricesCents[0], newCents: item.pricesCents[0], oldText: priceText(was), newText: priceText(item)});
    }
  }
  for (const item of before.items) {
    if (!now.has(item.id)) changes.push({itemId: item.id, name: item.name, kind: 'removed', oldCents: item.pricesCents[0], newCents: null, oldText: priceText(item), newText: null});
  }
  return changes;
}

const PART_NAMES: Record<MenuItem['part'], string> = {food: 'Jídlo', cocktails: 'Koktejly', drinks: 'Nápoje'};

/** The dashboard's view of the menu: items per part and category with the lowest, highest and average base price. */
export function menuOverview(menu: Menu) {
  const parts = (Object.keys(PART_NAMES) as MenuItem['part'][]).map(part => {
    const items = menu.items.filter(item => item.part === part);
    const categories = [...new Set(items.map(item => item.category))].map(name => {
      const prices = items.filter(item => item.category === name).map(item => item.pricesCents[0]);
      return {name, items: prices.length, minCents: Math.min(...prices), maxCents: Math.max(...prices), avgCents: Math.round(prices.reduce((sum, cents) => sum + cents, 0) / prices.length)};
    });
    return {part, name: PART_NAMES[part], items: items.length, categories};
  }).filter(part => part.items);
  return {source: menu.source, items: menu.items.length, parts};
}

/** Rounds to a step (5 Kč = 500 haléřů by default), never below one step. */
const roundTo = (cents: number, step: number) => Math.max(step, Math.round(cents / step) * step);
/** The value at a quantile of sorted numbers, linearly between neighbours. */
function quantile(sorted: number[], q: number): number {
  const at = (sorted.length - 1) * q, low = Math.floor(at), high = Math.ceil(at);
  return sorted[low] + (sorted[high] - sorted[low]) * (at - low);
}
const kc = (cents: number) => String(Math.round(cents / 100)).replace(/\B(?=(\d{3})+$)/g, ' ') + ' Kč';

/**
 * A name reduced for comparing the menu with the POS: lower case, no accents, no punctuation and no volume
 * ("Coca-Cola 0,33 l" → "coca cola"). The volume is matched separately (`volumeOf`).
 */
export function nameKey(name: string): string {
  return name.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/\b\d+(?:[.,]\d+)?\s*(?:ml|cl|dl|l)\b/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim();
}
/** A volume written in a name ("0,04 l", "330 ml", "5 cl") in millilitres, or null. */
export function volumeOf(name: string): number | null {
  const found = name.toLowerCase().match(/(\d+(?:[.,]\d+)?)\s*(ml|cl|dl|l)\b/);
  if (!found) return null;
  return Math.round(Number(found[1].replace(',', '.')) * {ml: 1, cl: 10, dl: 100, l: 1000}[found[2] as 'ml' | 'cl' | 'dl' | 'l']);
}

/** One product sold over some days, as the POS bills have it (sum over all bills). */
export type ItemSale = {key: string; productId: string | null; name: string; quantity: number; grossCents: number;
  /** Revenue without VAT; null when some line came without the VAT rate. */
  netCents: number | null};
export type Pairing = {itemId: string; how: 'name' | 'similar'} | null;

/**
 * Which menu item a POS product is (OKO1 pairs them itself, the web's ids are not in the POS): the same name, and among
 * items of that name (sizes) the same volume, else the price closest to what the product sold for. A name that is not
 * the same is paired only when one menu item clearly shares the most words with it. Otherwise unpaired.
 */
export function pairSale(menu: Menu, sale: Pick<ItemSale, 'name' | 'quantity' | 'grossCents'>): Pairing {
  const key = nameKey(sale.name), volume = volumeOf(sale.name), unitCents = sale.quantity ? sale.grossCents / sale.quantity : 0;
  const closest = (items: MenuItem[]) => {
    const byVolume = volume === null ? [] : items.filter(item => item.volumeMl === volume);
    if (byVolume.length === 1) return byVolume[0];
    const pool = byVolume.length ? byVolume : items;
    const distance = (item: MenuItem) => Math.min(...item.pricesCents.map(cents => Math.abs(cents - unitCents)));
    return [...pool].sort((a, b) => distance(a) - distance(b) || a.id.localeCompare(b.id))[0];
  };
  const same = menu.items.filter(item => nameKey(item.name) === key);
  if (same.length) return {itemId: closest(same).id, how: 'name'};
  const words = new Set(key.split(' ').filter(word => word.length > 1));
  if (!words.size) return null;
  const scored = menu.items.map(item => {
    const own = new Set(nameKey(item.name).split(' ').filter(word => word.length > 1));
    const shared = [...own].filter(word => words.has(word)).length;
    return {item, score: own.size ? shared / new Set([...own, ...words]).size : 0};
  }).filter(row => row.score >= 0.5).sort((a, b) => b.score - a.score);
  if (!scored.length) return null;
  const best = scored.filter(row => row.score === scored[0].score).map(row => row.item);
  // Several items equally close by words are one dish in sizes only when they share the name; else it stays unpaired.
  return new Set(best.map(item => nameKey(item.name))).size === 1 ? {itemId: closest(best).id, how: 'similar'} : null;
}

/**
 * Profit by menu item over some days: what sold (POS bills paired to the menu), revenue with and without VAT, and,
 * once a food cost per piece exists (`unitCosts`, filled by the purchase prices and recipes), cost and profit =
 * revenue without VAT − food cost × pieces. Unpaired products are listed so nothing sold gets lost.
 */
export function itemProfit(menu: Menu, sales: ItemSale[], unitCosts: Map<string, number>) {
  const items = new Map(menu.items.map(item => [item.id, item]));
  const rows = new Map<string, {itemId: string; name: string; part: MenuItem['part']; category: string; menuPrice: string; quantity: number; grossCents: number; netCents: number | null;
    unitCostCents: number | null; costCents: number | null; profitCents: number | null; posNames: string[]}>();
  const unpaired: {name: string; productId: string | null; quantity: number; grossCents: number}[] = [];
  for (const sale of sales) {
    const pairing = pairSale(menu, sale);
    const item = pairing && items.get(pairing.itemId);
    if (!item) { unpaired.push({name: sale.name, productId: sale.productId, quantity: sale.quantity, grossCents: sale.grossCents}); continue; }
    const row = rows.get(item.id) ?? {itemId: item.id, name: item.name, part: item.part, category: item.category, menuPrice: priceText(item), quantity: 0, grossCents: 0, netCents: 0,
      unitCostCents: unitCosts.get(item.id) ?? null, costCents: null, profitCents: null, posNames: []};
    row.quantity += sale.quantity; row.grossCents += sale.grossCents;
    row.netCents = row.netCents === null || sale.netCents === null ? null : row.netCents + sale.netCents;
    if (!row.posNames.includes(sale.name)) row.posNames.push(sale.name);
    rows.set(item.id, row);
  }
  const list = [...rows.values()].map(row => {
    const costCents = row.unitCostCents === null ? null : Math.round(row.unitCostCents * row.quantity);
    return {...row, costCents, profitCents: costCents === null || row.netCents === null ? null : row.netCents - costCents};
  }).sort((a, b) => b.grossCents - a.grossCents || a.name.localeCompare(b.name));
  const grossCents = sales.reduce((sum, sale) => sum + sale.grossCents, 0), pairedCents = list.reduce((sum, row) => sum + row.grossCents, 0);
  return {
    items: list, unpaired: unpaired.sort((a, b) => b.grossCents - a.grossCents),
    totals: {grossCents, pairedCents, pairedPermille: grossCents ? Math.round(pairedCents / grossCents * 1000) : null,
      profitCents: list.length && list.every(row => row.profitCents !== null) ? list.reduce((sum, row) => sum + (row.profitCents ?? 0), 0) : null},
    missing: [
      ...(list.some(row => row.netCents === null) ? ['sazba DPH u položek pokladny'] : []),
      ...(list.some(row => row.unitCostCents === null) ? ['food cost za kus (nákupní ceny a receptury)'] : []),
    ],
  };
}

export type RepricingInput = {part?: MenuItem['part']; category?: string; query?: string; percent?: number; deltaCents?: number; stepCents?: number};

/**
 * Virtual repricing: new prices of the chosen items (part, category, words of the name) by a percentage or a fixed amount,
 * rounded to a step (5 Kč unless said). Nothing changes on the web or in the POS. With sales of the last days, also the
 * revenue at the same number of pieces sold (OKO1 does not guess how many guests a new price would win or lose).
 */
export function repricing(menu: Menu, input: RepricingInput, sold: Map<string, {quantity: number; grossCents: number}>) {
  const step = input.stepCents ?? 500, category = input.category ? nameKey(input.category) : null, query = input.query ? nameKey(input.query) : null;
  const chosen = menu.items.filter(item => (!input.part || item.part === input.part) && (!category || nameKey(item.category).includes(category))
    && (!query || nameKey(`${item.name} ${item.group ?? ''}`).includes(query)));
  const change = (cents: number) => roundTo(cents * (1 + (input.percent ?? 0) / 100) + (input.deltaCents ?? 0), step);
  const items = chosen.map(item => {
    const newPricesCents = item.pricesCents.map(change), sale = sold.get(item.id);
    return {itemId: item.id, name: item.name, part: item.part, category: item.category, volume: item.volume, oldPricesCents: item.pricesCents, newPricesCents,
      oldText: priceText(item), newText: priceText({...item, pricesCents: newPricesCents}),
      ...(sale ? {quantity: sale.quantity, grossCents: sale.grossCents, newGrossCents: Math.round(sale.grossCents * newPricesCents[0] / Math.max(1, item.pricesCents[0]))} : {})};
  });
  const withSales = items.filter(item => item.grossCents !== undefined);
  const before = withSales.reduce((sum, item) => sum + (item.grossCents ?? 0), 0), after = withSales.reduce((sum, item) => sum + (item.newGrossCents ?? 0), 0);
  const avg = (key: 'oldPricesCents' | 'newPricesCents') => items.length ? Math.round(items.reduce((sum, item) => sum + item[key][0], 0) / items.length) : 0;
  return {
    items, count: items.length, avgOldCents: avg('oldPricesCents'), avgNewCents: avg('newPricesCents'),
    sales: withSales.length ? {items: withSales.length, grossCents: before, newGrossCents: after, differenceCents: after - before} : null,
  };
}

export type PriceFinding = {
  kind: 'cheap' | 'expensive' | 'gap'; part: MenuItem['part']; category: string; itemId: string | null; name: string | null;
  priceText: string; suggestedCents: number; text: string;
};

/**
 * Prices to look at within each category of at least 4 items: an item under half or over twice the category's middle
 * price (per litre when the drinks of the category come in different volumes), with a price at the category's lower or
 * upper quartile as the suggestion; and in a category of at least 5 items a gap in the price ladder (the next price
 * 1.5× the one before and at least 50 Kč more), with a price in the middle. Only for a look, a price may be on purpose.
 */
export function priceCheck(menu: Menu, step = 500): PriceFinding[] {
  const findings: PriceFinding[] = [];
  const groups = new Map<string, MenuItem[]>();
  for (const item of menu.items) groups.set(`${item.part}\u0000${item.category}`, [...(groups.get(`${item.part}\u0000${item.category}`) ?? []), item]);
  for (const items of groups.values()) {
    if (items.length < 4) continue;
    const {part, category} = items[0];
    const perLitre = items.every(item => item.volumeMl) && new Set(items.map(item => item.volumeMl)).size > 1;
    const metric = (item: MenuItem) => perLitre ? item.pricesCents[0] * 1000 / (item.volumeMl as number) : item.pricesCents[0];
    const back = (item: MenuItem, value: number) => roundTo(perLitre ? value * (item.volumeMl as number) / 1000 : value, step);
    const sorted = items.map(metric).sort((a, b) => a - b), median = quantile(sorted, 0.5);
    const unit = perLitre ? ' za litr' : '';
    for (const item of items) {
      const value = metric(item);
      if (value < median / 2) {
        const suggested = Math.max(back(item, quantile(sorted, 0.25)), roundTo(item.pricesCents[0] + step, step));
        findings.push({kind: 'cheap', part, category, itemId: item.id, name: item.name, priceText: priceText(item), suggestedCents: suggested,
          text: `pod polovinou běžné ceny kategorie (${kc(median)}${unit}); návrh ${kc(suggested)}`});
      } else if (value > median * 2) {
        const suggested = Math.min(back(item, quantile(sorted, 0.75)), roundTo(item.pricesCents[0] - step, step));
        findings.push({kind: 'expensive', part, category, itemId: item.id, name: item.name, priceText: priceText(item), suggestedCents: suggested,
          text: `přes dvojnásobek běžné ceny kategorie (${kc(median)}${unit}); jestli to není záměr, návrh ${kc(suggested)}`});
      }
    }
    if (items.length < 5) continue;
    const ladder = [...new Set(items.map(item => item.pricesCents[0]))].sort((a, b) => a - b);
    for (let index = 1; index < ladder.length; index++) {
      const low = ladder[index - 1], high = ladder[index];
      if (high >= low * 1.5 && high - low >= 5000) {
        const suggested = roundTo((low + high) / 2, step);
        findings.push({kind: 'gap', part, category, itemId: null, name: null, priceText: `${kc(low)} – ${kc(high)}`, suggestedCents: suggested,
          text: `mezera v cenách mezi ${kc(low)} a ${kc(high)}; chybí položka kolem ${kc(suggested)}`});
      }
    }
  }
  return findings;
}
