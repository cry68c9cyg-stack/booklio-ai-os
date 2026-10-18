/**
 * The venue's accountant, found in its own mailbox (MC, 18. 10. 2026: the accountant is Dvořák of Infotax, Klára is an
 * assistant): the address the month's invoices and receipts go to until iÚčto takes over the accounting. The address
 * stays in the venue's database; nothing of it is in Git.
 */

export type AccountantMail = {direction: 'in' | 'out'; sender: string; senderName: string | null; recipients: string[]};
export type Accountant = {address: string; messages: number};

const plain = (value: string) => value.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
/** The firm's name or the accountant's surname, in an address or a sender's name. */
export const ACCOUNTANT_WORDS = /infotax|dvorak/;

/**
 * The address the venue writes with most about its accounts: one of the firm (infotax) first, else one with the
 * accountant's name. Addresses of the venue's own domain are left out. Null when the mailbox has none.
 */
export function findAccountant(rows: AccountantMail[], ownDomain: string): Accountant | null {
  const counts = new Map<string, {messages: number; firm: boolean}>();
  const count = (address: string, name: string | null) => {
    const key = address.trim().toLowerCase();
    if (!key.includes('@') || (ownDomain && key.endsWith('@' + ownDomain.toLowerCase()))) return;
    const text = plain(`${key} ${name ?? ''}`);
    if (!ACCOUNTANT_WORDS.test(text)) return;
    const value = counts.get(key) ?? {messages: 0, firm: key.includes('infotax')};
    value.messages++;
    counts.set(key, value);
  };
  for (const row of rows) {
    if (row.direction === 'in') count(row.sender, row.senderName);
    else for (const address of row.recipients) count(address, null);
  }
  const best = [...counts.entries()].sort((a, b) => Number(b[1].firm) - Number(a[1].firm) || b[1].messages - a[1].messages || a[0].localeCompare(b[0]))[0];
  return best ? {address: best[0], messages: best[1].messages} : null;
}
