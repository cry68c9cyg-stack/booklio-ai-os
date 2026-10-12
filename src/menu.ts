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
