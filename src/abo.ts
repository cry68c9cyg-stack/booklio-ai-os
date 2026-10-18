/**
 * The batch payment file for the bank in the ABO format (KPC), which Czech banks import (MC, 18. 10. 2026: the office
 * pays on Tuesday and Thursday; Nancy checks the file and forwards it to the accountant). OKO1 never sends money: it
 * prepares the file. The venue's own account, client name and bank come from the last ABO file the venue e-mailed
 * (made by Dishboard), so the new file looks exactly like the ones the bank already takes. Suppliers' accounts come
 * only from what is exact: an ISDOC invoice, or a supplier paid by one of those earlier files.
 */

export type AboItem = {account: string; bankCode: string; amountCents: number; variableSymbol: string | null; constantSymbol: string | null; specificSymbol: string | null};
/** An ABO file as read: its client line, the bank line, the payer's account and the payments. */
export type AboFile = {clientLine: string; bankLine: string; payerAccount: string; padded: boolean; items: AboItem[]};
/** Where to pay an invoice: the account, bank code and symbols, and where they come from. */
export type PayTo = {account: string; bankCode: string; variableSymbol: string; constantSymbol: string | null; specificSymbol: string | null; from: 'isdoc' | 'abo'};
export type AboInvoice = {id: string; supplier: string; number: string | null; grossCents: number; dueDate: string};
export type AboPlan = {rows: (AboInvoice & {payTo: PayTo})[]; missing: (AboInvoice & {reason: string})[]; totalCents: number};

const ACCOUNT = /^(?:(\d{1,6})-)?(\d{2,16})$/;
/** "000019-0002000145399" and "19-2000145399" are the same account: "19-2000145399" (no prefix: "2000145399"). */
export function normalAccount(account: string): string | null {
  const match = account.replace(/\s/g, '').match(ACCOUNT);
  if (!match) return null;
  const prefix = (match[1] ?? '').replace(/^0+/, ''), number = match[2].replace(/^0+(?=\d)/, '');
  if (number.length > 10 || /^0+$/.test(number)) return null;
  return prefix ? `${prefix}-${number}` : number;
}
const symbolOf = (value: string | undefined) => value && /^\d{1,10}$/.test(value) && Number(value) > 0 ? value.replace(/^0+/, '') : null;
/** The variable symbol of an invoice number: its digits, when there are 1 to 10 of them. */
export function symbolFromNumber(number: string | null): string | null {
  const digits = (number ?? '').replace(/\D/g, '').replace(/^0+/, '');
  return digits.length >= 1 && digits.length <= 10 ? digits : null;
}

/** Reads an ABO file (bytes as the bank gets them); null when it is not one. */
export function parseAbo(bytes: Uint8Array): AboFile | null {
  const lines = new TextDecoder('latin1').decode(bytes).split(/\r?\n/).map(line => line.replace(/\s+$/, ''));
  const clientLine = lines.find(line => line.startsWith('UHL1')), bankLine = lines.find(line => /^1 1501 /.test(line));
  const group = lines.find(line => /^2 /.test(line));
  if (!clientLine || !bankLine || !group) return null;
  const payer = group.split(/\s+/)[1] ?? '', payerAccount = normalAccount(payer);
  if (!payerAccount || !/^1 1501 \d{6} \d{4}$/.test(bankLine)) return null;
  const items: AboItem[] = [];
  for (const line of lines) {
    const match = line.match(/^((?:\d{1,6}-)?\d{2,10}) (\d{1,15}) (\d{1,10}) (\d{4})(\d{4}) (\d{1,10})/);
    if (!match) continue;
    const account = normalAccount(match[1]);
    if (account) items.push({account, bankCode: match[4], amountCents: Number(match[2]), variableSymbol: symbolOf(match[3]), constantSymbol: symbolOf(match[5]), specificSymbol: symbolOf(match[6])});
  }
  return {clientLine, bankLine, payerAccount, padded: /^\d{6}-\d{10}$/.test(payer), items};
}

/**
 * Where to pay each invoice of a batch: the ISDOC account (exact), else the account the supplier was paid to in an
 * earlier ABO file, matched by an invoice number of that supplier as its variable symbol. Without either, or without
 * a variable symbol, the invoice is listed to pay by hand.
 */
export function aboPlan(invoices: AboInvoice[], exact: Map<string, PayTo>, known: Map<string, Omit<PayTo, 'variableSymbol' | 'from'>>, supplierKey: (id: string) => string): AboPlan {
  const rows: AboPlan['rows'] = [], missing: AboPlan['missing'] = [];
  for (const invoice of invoices) {
    const fromIsdoc = exact.get(invoice.id);
    if (fromIsdoc) { rows.push({...invoice, payTo: fromIsdoc}); continue; }
    const earlier = known.get(supplierKey(invoice.id)), symbol = symbolFromNumber(invoice.number);
    if (!earlier) missing.push({...invoice, reason: 'účet dodavatele zatím OKO1 nezná'});
    else if (!symbol) missing.push({...invoice, reason: 'číslo faktury nejde použít jako variabilní symbol'});
    else rows.push({...invoice, payTo: {...earlier, variableSymbol: symbol, from: 'abo'}});
  }
  return {rows, missing, totalCents: rows.reduce((sum, row) => sum + row.grossCents, 0)};
}

/** The accounts of suppliers from earlier ABO files: an item whose variable symbol is a number of a supplier's invoice. */
export function knownAccounts(files: AboFile[], invoices: {id: string; number: string | null}[], supplierKey: (id: string) => string) {
  const bySymbol = new Map<string, string>();
  for (const invoice of invoices) {
    const symbol = symbolFromNumber(invoice.number);
    if (symbol) bySymbol.set(symbol, supplierKey(invoice.id));
  }
  const known = new Map<string, Omit<PayTo, 'variableSymbol' | 'from'>>();
  // Files oldest first, so the latest account of a supplier wins.
  for (const file of files) for (const item of file.items) {
    const key = item.variableSymbol ? bySymbol.get(item.variableSymbol) : undefined;
    if (key) known.set(key, {account: item.account, bankCode: item.bankCode, constantSymbol: item.constantSymbol, specificSymbol: item.specificSymbol});
  }
  return known;
}

const ddmmyy = (date: string) => date.slice(8, 10) + date.slice(5, 7) + date.slice(2, 4);
const padded = (account: string) => {
  const [prefix, number] = account.includes('-') ? account.split('-') : ['0', account];
  return prefix.padStart(6, '0') + '-' + number.padStart(10, '0');
};

/** The ABO file of a plan, in the layout of `template` (its client and bank lines, its payer account), due on `payDay`. */
export function buildAbo(template: AboFile, plan: AboPlan, payDay: string, today: string, sequence: number): Uint8Array {
  const account = (value: string) => template.padded ? padded(value) : value;
  const client = template.clientLine.slice(0, 4) + ddmmyy(today) + template.clientLine.slice(10);
  const bank = `1 1501 ${String(sequence % 1000).padStart(3, '0')}000 ${template.bankLine.slice(-4)}`;
  const lines = [client, bank, `2 ${account(template.payerAccount)} ${String(plan.totalCents).padStart(14, '0')} ${ddmmyy(payDay)}`,
    ...plan.rows.map(row => `${account(row.payTo.account)} ${String(row.grossCents).padStart(12, '0')} ${row.payTo.variableSymbol.padStart(10, '0')} ` +
      `${row.payTo.bankCode}${(row.payTo.constantSymbol ?? '0').padStart(4, '0')} ${(row.payTo.specificSymbol ?? '0').padStart(10, '0')}`),
    '3 +', '5 +'];
  const text = lines.join('\r\n') + '\r\n';
  const out = new Uint8Array(text.length);
  for (let index = 0; index < text.length; index++) out[index] = text.charCodeAt(index) & 0xff;
  return out;
}
