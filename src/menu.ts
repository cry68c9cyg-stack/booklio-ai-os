/**
 * The venue's food and drink menu as the website publishes it (record `menu`, docs/ingest-v1.md). OKO1 keeps the latest
 * menu and every change of it (new item, removed item, new price), so the price of any item on any day is known: the base
 * for prices, food cost, menu engineering, simulated repricing and profit by item (spec, decision of MC 12. 10. 2026).
 */
import type {Menu, MenuItem} from './validate.ts';

export type MenuChange = {itemId: string; name: string; kind: 'added' | 'removed' | 'price'; oldCents: number | null; newCents: number | null; oldText: string | null; newText: string | null};

/** Prices as one text, the way the menu lists them: "225 / 255 Kč". */
export const priceText = (item: MenuItem) => item.pricesCents.map(cents => String(Math.round(cents / 100)).replace(/\B(?=(\d{3})+$)/g, ' ')).join(' / ') + ' Kč';

/** The prices of a price text back in haléře ("225 / 1 255 Kč" → [22500, 125500]); none for anything else. */
export const pricesOfText = (text: string | null) => !text || !/^[\d \u00a0/]+ Kč$/.test(text) ? []
  : text.slice(0, -3).split('/').map(part => Number(part.replace(/[ \u00a0]/g, '')) * 100).filter(Number.isSafeInteger);

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

export const PART_NAMES: Record<MenuItem['part'], string> = {food: 'Jídlo', cocktails: 'Koktejly', drinks: 'Nápoje'};

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
    .replace(/\b\d+\s*\/\s*\d+\s*(?:ml|cl|dl|l)\b/g, ' ').replace(/\b\d+(?:[.,]\d+)?\s*(?:ml|cl|dl|l)\b/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim();
}
const UNIT_ML = {ml: 1, cl: 10, dl: 100, l: 1000};
/** A volume written in a name ("0,04 l", "330 ml", "5 cl", "1/8 l") in millilitres, or null. */
export function volumeOf(name: string): number | null {
  const lower = name.toLowerCase(), fraction = lower.match(/(\d+)\s*\/\s*(\d+)\s*(ml|cl|dl|l)\b/);
  if (fraction) return Number(fraction[2]) ? Math.round(Number(fraction[1]) / Number(fraction[2]) * UNIT_ML[fraction[3] as keyof typeof UNIT_ML]) : null;
  const found = lower.match(/(\d+(?:[.,]\d+)?)\s*(ml|cl|dl|l)\b/);
  return found ? Math.round(Number(found[1].replace(',', '.')) * UNIT_ML[found[2] as keyof typeof UNIT_ML]) : null;
}
/** Words of a drinks category, group or name that make it alcohol (21 % VAT). */
const ALCOHOL = /\b(vin[ao]?\b|wine|sumiv|destilat|lihovin|alkohol|spirit|piv[oa]\b|beer|cider|champagne|sampan|liker|rum\b|gin\b|vodk|tequil|whisk|bourbon|cognac|brandy|aperitiv|aperol|spritz|hugo\b|mojito|cuba libre|sekt\b|prosecco|absint|slivovic|fernet|becher|grog|svarak|irsk|irish)/;
/** Words that make a drink non-alcoholic whatever its category says. */
const SOFT = /\b(nealko|virgin|non alcoholic|alcohol free|bez alkoholu|0 0|zazvorove pivo|ginger beer|root beer)/;

/**
 * What kind of item it is for the POS and its Czech VAT rate in whole percent: food and non-alcoholic drinks 12 %
 * (catering), alcohol 21 %. A guess from the part, category, group and name of the menu; the POS shows it before using it.
 */
export function menuItemTax(item: Pick<MenuItem, 'part' | 'category' | 'group' | 'name'>): {kind: 'food' | 'soft' | 'alcohol'; vatRate: 12 | 21} {
  if (item.part === 'food') return {kind: 'food', vatRate: 12};
  const words = nameKey(`${item.category} ${item.group ?? ''} ${item.name}`);
  if (SOFT.test(words)) return {kind: 'soft', vatRate: 12};
  // A cocktail is alcohol unless said otherwise; other drinks only by their category, group or name.
  return item.part === 'cocktails' || ALCOHOL.test(words) ? {kind: 'alcohol', vatRate: 21} : {kind: 'soft', vatRate: 12};
}

/** Short words that say nothing about the dish ("Kuře na grilu" and "Kuře na pepři" share only "kuře"). */
const FILLER = new Set(['na', 'se', 'ze', 'po', 'do', 'od', 'pro', 'bez', 'and', 'with', 'the']);
const wordsOf = (key: string) => new Set(key.split(' ').filter(word => word.length > 1 && !FILLER.has(word)));

/** One product sold over some days, as the POS bills have it (sum over all bills). */
export type ItemSale = {key: string; productId: string | null; name: string; quantity: number; grossCents: number;
  /** The menu item the POS linked the product to (docs/ingest-v1.md), else null. */
  menuItemId?: string | null;
  /** Revenue without VAT; null when some line came without the VAT rate. */
  netCents: number | null};
export type Pairing = {itemId: string; how: 'id' | 'name' | 'similar'} | null;

/**
 * Which menu item a POS product is. A POS that knows the menu (Pexeso takes it over from OKO1) sends the item's id with
 * each line; an id still on the menu wins. Otherwise OKO1 pairs by name: the same name, and among
 * items of that name (sizes) the same volume, else the price closest to what the product sold for. A name that is not
 * the same is paired only when all words of one name are in the other, they share at least 60 % of their words and
 * no other dish comes within 0.2 of that. Otherwise unpaired: a wrong pair is worse than none.
 */
export function pairSale(menu: Menu, sale: Pick<ItemSale, 'name' | 'quantity' | 'grossCents' | 'menuItemId'>): Pairing {
  if (sale.menuItemId && menu.items.some(item => item.id === sale.menuItemId)) return {itemId: sale.menuItemId, how: 'id'};
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
  const words = wordsOf(key);
  if (!words.size) return null;
  const scored = menu.items.map(item => {
    const own = wordsOf(nameKey(item.name)), shared = [...own].filter(word => words.has(word)).length;
    const contained = own.size > 0 && (shared === own.size || shared === words.size);
    return {item, name: nameKey(item.name), score: contained ? shared / new Set([...own, ...words]).size : 0};
  }).filter(row => row.score > 0).sort((a, b) => b.score - a.score);
  if (!scored.length || scored[0].score < 0.6) return null;
  // Sizes of one dish share the name; any other dish close behind leaves the product unpaired.
  const best = scored.filter(row => row.name === scored[0].name), rival = scored.find(row => row.name !== scored[0].name);
  return rival && rival.score > scored[0].score - 0.2 ? null : {itemId: closest(best.map(row => row.item)).id, how: 'similar'};
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
    if (!item) {
      // Lines of one product sent with and without a menu item id are still one unpaired product.
      const same = unpaired.find(row => (row.productId ?? row.name) === (sale.productId ?? sale.name));
      if (same) { same.quantity += sale.quantity; same.grossCents += sale.grossCents; } else unpaired.push({name: sale.name, productId: sale.productId, quantity: sale.quantity, grossCents: sale.grossCents});
      continue;
    }
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
export function repricing(menu: Menu, input: RepricingInput, sold: Map<string, {quantity: number; grossCents: number; netCents?: number | null}>) {
  const step = input.stepCents ?? 500, category = input.category ? nameKey(input.category) : null, query = input.query ? nameKey(input.query) : null;
  const chosen = menu.items.filter(item => (!input.part || item.part === input.part) && (!category || nameKey(item.category).includes(category))
    && (!query || nameKey(`${item.name} ${item.group ?? ''}`).includes(query)));
  // A free item stays free; a price that would drop under one step stays at one step and says so.
  const raw = (cents: number) => cents * (1 + (input.percent ?? 0) / 100) + (input.deltaCents ?? 0);
  const change = (cents: number) => cents === 0 ? 0 : roundTo(raw(cents), step);
  const items = chosen.map(item => {
    const newPricesCents = item.pricesCents.map(change), sale = sold.get(item.id), atMinimum = item.pricesCents.some(cents => cents > 0 && raw(cents) < step / 2);
    return {itemId: item.id, name: item.name, part: item.part, category: item.category, volume: item.volume, oldPricesCents: item.pricesCents, newPricesCents,
      oldText: priceText(item), newText: priceText({...item, pricesCents: newPricesCents}), ...(atMinimum ? {atMinimum: true} : {}),
      ...(sale ? {quantity: sale.quantity, grossCents: sale.grossCents, newGrossCents: Math.round(sale.grossCents * newPricesCents[0] / Math.max(1, item.pricesCents[0])),
        netCents: sale.netCents ?? null, newNetCents: sale.netCents == null ? null : Math.round(sale.netCents * newPricesCents[0] / Math.max(1, item.pricesCents[0]))} : {})};
  });
  const withSales = items.filter(item => item.grossCents !== undefined);
  const before = withSales.reduce((sum, item) => sum + (item.grossCents ?? 0), 0), after = withSales.reduce((sum, item) => sum + (item.newGrossCents ?? 0), 0);
  const avg = (key: 'oldPricesCents' | 'newPricesCents') => items.length ? Math.round(items.reduce((sum, item) => sum + item[key][0], 0) / items.length) : 0;
  // The food cost of a piece does not change with its price, so at the same pieces the profit changes by the revenue without VAT.
  const net = withSales.every(item => item.netCents !== null && item.newNetCents !== null)
    ? {netCents: withSales.reduce((sum, item) => sum + (item.netCents ?? 0), 0), newNetCents: withSales.reduce((sum, item) => sum + (item.newNetCents ?? 0), 0)} : null;
  return {
    items, count: items.length, avgOldCents: avg('oldPricesCents'), avgNewCents: avg('newPricesCents'),
    sales: withSales.length ? {items: withSales.length, grossCents: before, newGrossCents: after, differenceCents: after - before,
      profitDifferenceCents: net ? net.newNetCents - net.netCents : null,
      // How many fewer pieces the new prices bear before the revenue falls under today's, and the revenue with 5 and 10 % fewer.
      breakEvenDropPermille: after > before ? Math.floor((after - before) * 1000 / after) : null,
      ifFewer: [5, 10].map(percent => ({percent, newGrossCents: Math.round(after * (1 - percent / 100))}))} : null,
  };
}

/** Something the website's menu should say and does not (or says twice differently), for the website's admin to fix. */
export type MenuGap = {kind: 'description' | 'volume' | 'price'; part: MenuItem['part']; category: string; group: string | null; itemId: string; name: string; text: string};
export const GAP_NAMES: Record<MenuGap['kind'], string> = {description: 'bez popisu', volume: 'bez objemu', price: 'dvě ceny'};
/** Sides, sauces and extras need no description; coffee and tea are served in their cup, so no volume. */
const NO_DESCRIPTION = /\b(priloh|omack|dresink|priplat|extra)/;
const NO_VOLUME = /\b(kav|caj|horke|coffee|tea\b)/;

/**
 * What to fix in the menu on the website: a dish or cocktail without a description (guests ask what is in it; a
 * cocktail lists its ingredients), a drink without its volume, and the same item (name, volume and description) at
 * two prices. Where an item of the same name elsewhere has a description, the finding says where to copy it from.
 */
export function menuGaps(menu: Menu): MenuGap[] {
  const found: MenuGap[] = [];
  const where = (item: MenuItem) => item.group ? `${item.category} › ${item.group}` : item.category;
  const gap = (item: MenuItem, kind: MenuGap['kind'], text: string) =>
    found.push({kind, part: item.part, category: item.category, group: item.group, itemId: item.id, name: item.name, text});
  for (const item of menu.items) {
    const category = nameKey(`${item.category} ${item.group ?? ''}`);
    // "Dorty – dle nabídky" changes every day: nothing fixed to describe.
    if (!item.description?.trim() && !/\bdle (denni )?nabidky\b/.test(nameKey(item.name)) && (item.part === 'cocktails' || (item.part === 'food' && !NO_DESCRIPTION.test(category)))) {
      const twin = menu.items.find(other => other !== item && other.description?.trim() && nameKey(other.name) === nameKey(item.name));
      gap(item, 'description', `${item.part === 'cocktails' ? 'chybí složení' : 'chybí popis'}${twin ? ` (je u ${where(twin)}: „${twin.description!.trim().slice(0, 80)}“)` : ''}`);
    }
    if (item.part === 'drinks' && item.volumeMl === null && !item.volume?.trim() && !NO_VOLUME.test(category)) gap(item, 'volume', 'chybí objem');
  }
  // The same item twice (same name, volume and description) with other prices: one of them is a typo.
  const same = new Map<string, MenuItem[]>();
  for (const item of menu.items) {
    const key = JSON.stringify([item.part, nameKey(item.name), item.volumeMl ?? item.volume ?? null, (item.description ?? '').trim().toLowerCase()]);
    same.set(key, [...(same.get(key) ?? []), item]);
  }
  for (const items of same.values()) {
    if (new Set(items.map(item => item.pricesCents.join('/'))).size < 2) continue;
    for (const item of items.slice(1)) gap(item, 'price', `stejná položka za ${priceText(items[0])} v ${where(items[0])} a za ${priceText(item)} v ${where(item)}`);
  }
  const order = {price: 0, description: 1, volume: 2};
  return found.sort((a, b) => order[a.kind] - order[b.kind] || menu.items.findIndex(item => item.id === a.itemId) - menu.items.findIndex(item => item.id === b.itemId));
}

export type PriceFinding = {
  kind: 'cheap' | 'expensive' | 'gap' | 'ending'; part: MenuItem['part']; category: string; itemId: string | null; name: string | null;
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
    // Free items (water, tap) say nothing about the price level. Drinks in different volumes are compared per litre,
    // only those with a volume; a ladder of prices across sizes is no gap, so per litre there is no gap check.
    const priced = items.filter(item => item.pricesCents[0] > 0), withVolume = priced.filter(item => item.volumeMl);
    const perLitre = withVolume.length >= 4 && new Set(withVolume.map(item => item.volumeMl)).size > 1;
    const pool = perLitre ? withVolume : priced;
    if (pool.length < 4) continue;
    const {part, category} = pool[0];
    const metric = (item: MenuItem) => perLitre ? item.pricesCents[0] * 1000 / (item.volumeMl as number) : item.pricesCents[0];
    const back = (item: MenuItem, value: number) => roundTo(perLitre ? value * (item.volumeMl as number) / 1000 : value, step);
    const sorted = pool.map(metric).sort((a, b) => a - b), median = quantile(sorted, 0.5);
    const unit = perLitre ? ' za litr' : '';
    for (const item of pool) {
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
    const flagged = new Set(findings.map(finding => finding.itemId));
    findings.push(...endingFindings(priced).filter(finding => !flagged.has(finding.itemId)));
    if (perLitre || pool.length < 5) continue;
    const ladder = [...new Set(pool.map(item => item.pricesCents[0]))].sort((a, b) => a - b);
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

/**
 * A price whose last crown digit stands out in its category of at least 5 priced items: when at least three quarters of the category's prices end
 * in a few digits (each on at least a quarter of the prices, at least 2), an item ending otherwise gets the nearest price
 * with one of those endings (the higher one on a tie). A tip for a tidy menu, not an error.
 */
function endingFindings(items: MenuItem[]): PriceFinding[] {
  if (items.length < 5) return [];
  const crowns = (item: MenuItem) => Math.round(item.pricesCents[0] / 100), counts = new Map<number, number>();
  for (const item of items) counts.set(crowns(item) % 10, (counts.get(crowns(item) % 10) ?? 0) + 1);
  const usual = [...counts].filter(([, count]) => count >= Math.max(2, items.length / 4)).map(([digit]) => digit).sort((a, b) => a - b);
  if (!usual.length || usual.reduce((sum, digit) => sum + (counts.get(digit) ?? 0), 0) * 4 < items.length * 3) return [];
  return items.filter(item => !usual.includes(crowns(item) % 10)).map(item => {
    const price = crowns(item);
    const candidates = usual.flatMap(digit => [price - (((price - digit) % 10) + 10) % 10, price + (((digit - price) % 10) + 10) % 10]).filter(value => value > 0);
    const suggested = candidates.sort((a, b) => Math.abs(a - price) - Math.abs(b - price) || b - a)[0] * 100;
    return {kind: 'ending' as const, part: item.part, category: item.category, itemId: item.id, name: item.name, priceText: priceText(item), suggestedCents: suggested,
      text: `cena končí na ${price % 10}, ostatní v kategorii na ${usual.join(' nebo ')}; návrh ${kc(suggested)}`};
  });
}

/** A product the POS charged at a price the menu did not have that day (most pieces of the day at that price). */
export type PriceMismatch = {itemId: string; name: string; posName: string; posCents: number; menuText: string;
  /** The menu's price closest to what the POS charged. */
  menuCents: number; quantity: number};

/**
 * The POS charges a different price than the menu: a product of the day of which no piece was sold at any price of the
 * paired menu item (or a price it had that day, `earlierCents`, when it changed later), shown with the unit price most
 * pieces were sold at. Less than 1 Kč apart counts as the same, so happy hour, staff prices and extras next to the
 * menu price raise nothing; a discount on the whole bill is not part of the line's price.
 */
export function priceMismatches(menu: Menu, lines: {name: string; menuItemId?: string | null; unitCents: number; quantity: number}[], earlierCents: Map<string, number[]>): PriceMismatch[] {
  // One product = its name and the menu item the POS linked it to (none when the POS does not link).
  const byName = new Map<string, {posName: string; menuItemId: string | null; prices: Map<number, number>}>();
  for (const line of lines) {
    const key = JSON.stringify([line.name, line.menuItemId ?? null]);
    const product = byName.get(key) ?? {posName: line.name, menuItemId: line.menuItemId ?? null, prices: new Map<number, number>()};
    product.prices.set(line.unitCents, (product.prices.get(line.unitCents) ?? 0) + line.quantity);
    byName.set(key, product);
  }
  const items = new Map(menu.items.map(item => [item.id, item])), found: PriceMismatch[] = [];
  for (const {posName, menuItemId, prices} of byName.values()) {
    const [posCents] = [...prices].sort((a, b) => b[1] - a[1] || b[0] - a[0])[0];
    const quantity = [...prices.values()].reduce((sum, count) => sum + count, 0);
    const pairing = pairSale(menu, {name: posName, menuItemId, quantity: 1, grossCents: posCents}), item = pairing && items.get(pairing.itemId);
    if (!item || !posCents) continue;
    const known = [...item.pricesCents, ...(earlierCents.get(item.id) ?? [])];
    if ([...prices.keys()].every(unit => known.every(cents => Math.abs(cents - unit) >= 100))) {
      const menuCents = [...item.pricesCents].sort((a, b) => Math.abs(a - posCents) - Math.abs(b - posCents))[0];
      // The same product sent with and without its menu item id is one row.
      const same = found.find(row => row.itemId === item.id && row.posName === posName);
      if (same) { same.quantity += quantity; if (Math.abs(posCents - menuCents) > Math.abs(same.posCents - same.menuCents)) Object.assign(same, {posCents, menuCents}); }
      else found.push({itemId: item.id, name: item.name, posName, posCents, menuText: priceText(item), menuCents, quantity});
    }
  }
  const weight = (row: PriceMismatch) => row.quantity * Math.abs(row.posCents - row.menuCents);
  return found.sort((a, b) => weight(b) - weight(a) || a.posName.localeCompare(b.posName));
}

export type MatrixClass = 'star' | 'plowhorse' | 'puzzle' | 'dog';
export const MATRIX_NAMES: Record<MatrixClass, {name: string; advice: string}> = {
  star: {name: 'Hvězdy', advice: 'prodávají se a vydělávají: držet, zvýraznit na lístku, snesou mírné zdražení'},
  plowhorse: {name: 'Tahouni', advice: 'prodávají se, ale vydělávají málo: zkusit zdražit o 5–10 % nebo zlevnit recepturu či porci'},
  puzzle: {name: 'Hádanky', advice: 'vydělávají, ale málo se prodávají: lepší místo na lístku, popis, doporučení obsluhy'},
  dog: {name: 'Slabé kusy', advice: 'málo se prodávají i vydělávají: zvážit vyřazení nebo nahrazení'},
};

/**
 * Menu engineering (Kasavana–Smith) per part of the menu over the days of `profit`: popular = at least 70 % of an equal
 * share of the pieces sold in its part; profitable = contribution per piece at least the part's average weighted by pieces.
 * Contribution is revenue without VAT − food cost per piece where every sold item of the part has both, otherwise the
 * price per piece with VAT (`basis: 'price'`) until the food cost exists. Items on the menu not sold at all are weak;
 * items added within the days compared (`newItems`) are left out.
 */
export function menuMatrix(menu: Menu, profit: ReturnType<typeof itemProfit>, newItems: Set<string> = new Set()) {
  const sold = new Map(profit.items.filter(row => row.quantity > 0).map(row => [row.itemId, row]));
  return (Object.keys(PART_NAMES) as MenuItem['part'][]).map(part => {
    // Items added within the days compared have had fewer days to sell: listed apart, not judged.
    const fresh = menu.items.filter(item => item.part === part && newItems.has(item.id)).map(item => item.name);
    const items = menu.items.filter(item => item.part === part && item.pricesCents[0] > 0 && !newItems.has(item.id));
    const rows = items.map(item => sold.get(item.id)).filter(row => row !== undefined);
    const units = rows.reduce((sum, row) => sum + row.quantity, 0);
    if (!items.length || !units) return null;
    const basis: 'margin' | 'price' = rows.every(row => row.profitCents !== null) ? 'margin' : 'price';
    const contribution = (row: NonNullable<typeof rows[number]>) => (basis === 'margin' ? row.profitCents as number : row.grossCents) / row.quantity;
    const average = rows.reduce((sum, row) => sum + contribution(row) * row.quantity, 0) / units, popular = 0.7 * units / items.length;
    const classified = items.map(item => {
      const row = sold.get(item.id);
      const perPiece = row ? Math.round(contribution(row)) : null, quantity = row?.quantity ?? 0;
      const kind: MatrixClass = quantity >= popular ? (perPiece !== null && perPiece >= average ? 'star' : 'plowhorse') : (perPiece !== null && perPiece >= average ? 'puzzle' : 'dog');
      return {itemId: item.id, name: item.name, category: item.category, quantity, contributionCents: perPiece, kind};
    });
    return {
      part, name: PART_NAMES[part], basis, units, averageContributionCents: Math.round(average), newItems: fresh,
      classes: (Object.keys(MATRIX_NAMES) as MatrixClass[]).map(kind => ({kind, ...MATRIX_NAMES[kind],
        items: classified.filter(row => row.kind === kind).sort((a, b) => b.quantity - a.quantity || a.name.localeCompare(b.name))})),
    };
  }).filter(part => part !== null);
}

/** How a price change went: pieces and revenue per day in the 28 days before against the days after (up to 28). */
export type PriceExperiment = {
  date: string; itemId: string; name: string; oldText: string | null; newText: string | null;
  before: {days: number; quantity: number; grossCents: number}; after: {days: number; quantity: number; grossCents: number};
  /** Change per day in per mille; null without sales before. */
  quantityPermille: number | null; revenuePermille: number | null;
  /** no_history = fewer than 7 days of POS bills before the change; waiting = fewer than 7 days after it so far; done = 28 days after; running = in between. */
  status: 'no_history' | 'waiting' | 'running' | 'done';
};
export function priceExperiment(change: {date: string; itemId: string; name: string; oldText: string | null; newText: string | null},
  before: {days: number; quantity: number; grossCents: number}, after: {days: number; quantity: number; grossCents: number}): PriceExperiment {
  const perDay = (value: number, days: number) => days ? value / days : 0;
  const delta = (key: 'quantity' | 'grossCents') => before.days >= 7 && before[key] > 0 && after.days
    ? Math.round((perDay(after[key], after.days) / perDay(before[key], before.days) - 1) * 1000) : null;
  return {...change, before, after, quantityPermille: delta('quantity'), revenuePermille: delta('grossCents'),
    status: before.days < 7 ? 'no_history' : after.days < 7 ? 'waiting' : after.days < 28 ? 'running' : 'done'};
}
