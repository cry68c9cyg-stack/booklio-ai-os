/**
 * Reading the venue's mailbox over IMAP (RFC 9051 / 3501), only ever read-only: folders are opened with EXAMINE and
 * messages fetched with BODY.PEEK, so nothing is deleted, moved or marked as read. The password is a Worker secret;
 * it goes only into the LOGIN command over TLS and never into a log or an error text. Same guards as the other
 * readers: a time budget for the whole session, a size limit per message, errors as short Czech texts.
 */

export type ImapAccount = {host: string; port: number; user: string; password: string};
export type Fetched<T> = {ok: true; value: T} | {ok: false; error: string};
/** One untagged response: its text (literals left out as `{n}`) and the literals in order. */
export type ImapResponse = {text: string; literals: Uint8Array[]};

/** Biggest message OKO1 reads; bigger ones (videos, scans of whole folders) are skipped. */
export const MAX_MESSAGE_BYTES = 15 * 1024 * 1024;
const MAX_LINE = 1024 * 1024;

const encoder = new TextEncoder();
const latin1 = new TextDecoder('latin1');

class ImapError extends Error {}

/** Reads IMAP responses from a byte stream: lines, and literals `{n}` of exactly n bytes inside them. */
export class ImapReader {
  private buffer = new Uint8Array(0);
  private read: () => Promise<Uint8Array | null>;
  constructor(read: () => Promise<Uint8Array | null>) { this.read = read; }

  private async fill(): Promise<boolean> {
    const chunk = await this.read();
    if (!chunk) return false;
    const next = new Uint8Array(this.buffer.length + chunk.length);
    next.set(this.buffer);
    next.set(chunk, this.buffer.length);
    this.buffer = next;
    return true;
  }

  private async line(): Promise<string> {
    for (;;) {
      const end = this.buffer.indexOf(10);
      if (end >= 0) {
        const line = latin1.decode(this.buffer.subarray(0, end)).replace(/\r$/, '');
        this.buffer = this.buffer.slice(end + 1);
        return line;
      }
      if (this.buffer.length > MAX_LINE) throw new ImapError('too-big');
      if (!await this.fill()) throw new ImapError('closed');
    }
  }

  private async bytes(count: number): Promise<Uint8Array> {
    while (this.buffer.length < count) if (!await this.fill()) throw new ImapError('closed');
    const out = this.buffer.slice(0, count);
    this.buffer = this.buffer.slice(count);
    return out;
  }

  /** The next whole response: a line with every literal it announces read in. */
  async response(): Promise<ImapResponse> {
    let text = '';
    const literals: Uint8Array[] = [];
    for (;;) {
      const line = await this.line();
      text += line;
      const literal = line.match(/\{(\d+)\+?\}$/);
      if (!literal) return {text, literals};
      const size = Number(literal[1]);
      if (size > MAX_MESSAGE_BYTES + 65536) throw new ImapError('too-big');
      literals.push(await this.bytes(size));
    }
  }
}

/** A quoted IMAP string; CR and LF can never be in one. */
export function quoted(value: string): string {
  if (/[\r\n]/.test(value)) throw new ImapError('bad-string');
  return `"${value.replace(/[\\"]/g, char => '\\' + char)}"`;
}

/** IMAP date for SEARCH SINCE: 1-Apr-2026. */
export function imapDate(date: string): string {
  const [year, month, day] = date.split('-').map(Number);
  return `${day}-${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][month - 1]}-${year}`;
}

/** Folder names from LIST responses, with the special use (\Sent, \Trash…) when the server tells it. */
export function parseList(responses: ImapResponse[]): {name: string; flags: string[]}[] {
  const out: {name: string; flags: string[]}[] = [];
  for (const response of responses) {
    const match = response.text.match(/^\* LIST \(([^)]*)\) (?:"[^"]*"|NIL) (.*)$/i);
    if (!match) continue;
    let name = match[2].trim();
    if (/^\{\d+\}$/.test(name) && response.literals[0]) name = latin1.decode(response.literals[0]);
    else if (name.startsWith('"')) name = name.slice(1, -1).replace(/\\(.)/g, '$1');
    out.push({name, flags: match[1].split(/\s+/).filter(Boolean).map(flag => flag.toLowerCase())});
  }
  return out;
}

/** The sent folder: the one marked \Sent, otherwise one with a usual name. */
export function sentFolder(folders: {name: string; flags: string[]}[]): string | null {
  const marked = folders.find(folder => folder.flags.includes('\\sent'));
  if (marked) return marked.name;
  const usual = folders.find(folder => /^(inbox[./])?(sent|sent items|sent messages|odeslan[aá]|odeslan[aá] po[sš]ta|odoslan[aá] po[sš]ta)$/i.test(folder.name));
  return usual?.name ?? null;
}

export type ImapSession = {
  /** Opens a folder read-only; its UIDVALIDITY and number of messages. */
  examine(folder: string): Promise<{uidValidity: number; exists: number}>;
  /** UIDs of the messages with an internal date on or after `date` (YYYY-MM-DD), ascending. */
  since(date: string): Promise<number[]>;
  /** The whole message by UID, or null when it is gone or over the size limit. */
  message(uid: number): Promise<{bytes: Uint8Array; size: number} | null>;
  folders(): Promise<{name: string; flags: string[]}[]>;
  /** The MIME structure of each message (as text, file names included), to fetch only those with a document. */
  structures(uids: number[]): Promise<Map<number, string>>;
};

/**
 * Runs `work` in one logged-in session. Never throws: any failure is a short Czech text without the account's
 * password; the session is always logged out and closed.
 */
export async function withMailbox<T>(account: ImapAccount, work: (session: ImapSession) => Promise<T>, budgetMs = 25000): Promise<Fetched<T>> {
  let socket: {readable: ReadableStream<Uint8Array>; writable: WritableStream<Uint8Array>; close(): Promise<void>; opened?: Promise<unknown>} | null = null;
  const deadline = Date.now() + budgetMs;
  try {
    const sockets = await import('cloudflare:sockets');
    socket = sockets.connect({hostname: account.host, port: account.port}, {secureTransport: 'on', allowHalfOpen: false});
    const streamReader = socket.readable.getReader(), writer = socket.writable.getWriter();
    const read = async () => {
      const left = deadline - Date.now();
      if (left <= 0) throw new ImapError('timeout');
      let timer: ReturnType<typeof setTimeout> | undefined;
      const result = await Promise.race([streamReader.read(), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new ImapError('timeout')), left); })]);
      clearTimeout(timer);
      return result.done ? null : result.value;
    };
    const reader = new ImapReader(read);
    let counter = 0;
    const command = async (line: string): Promise<ImapResponse[]> => {
      const tag = `K${++counter}`;
      await writer.write(encoder.encode(`${tag} ${line}\r\n`));
      const untagged: ImapResponse[] = [];
      for (;;) {
        const response = await reader.response();
        if (response.text.startsWith(tag + ' ')) {
          if (!/^\S+ OK/i.test(response.text)) throw new ImapError(line.startsWith('LOGIN') ? 'login' : 'no');
          return untagged;
        }
        untagged.push(response);
      }
    };
    const greeting = await reader.response();
    if (!/^\* (OK|PREAUTH)/i.test(greeting.text)) throw new ImapError('greeting');
    await command(`LOGIN ${quoted(account.user)} ${quoted(account.password)}`);
    const session: ImapSession = {
      async examine(folder) {
        const responses = await command(`EXAMINE ${quoted(folder)}`);
        let uidValidity = 0, exists = 0;
        for (const response of responses) {
          const validity = response.text.match(/\[UIDVALIDITY (\d+)\]/i);
          if (validity) uidValidity = Number(validity[1]);
          const count = response.text.match(/^\* (\d+) EXISTS/i);
          if (count) exists = Number(count[1]);
        }
        return {uidValidity, exists};
      },
      async since(date) {
        const responses = await command(`UID SEARCH SINCE ${imapDate(date)}`);
        const uids = responses.flatMap(response => /^\* SEARCH/i.test(response.text) ? response.text.replace(/^\* SEARCH\s*/i, '').split(/\s+/).filter(Boolean).map(Number) : []);
        return [...new Set(uids.filter(Number.isSafeInteger))].sort((a, b) => a - b);
      },
      async message(uid) {
        const sizes = await command(`UID FETCH ${uid} (RFC822.SIZE)`);
        const size = Number(sizes.map(response => response.text.match(/RFC822\.SIZE (\d+)/i)?.[1]).find(Boolean) ?? NaN);
        if (!Number.isFinite(size)) return null;
        if (size > MAX_MESSAGE_BYTES) return {bytes: new Uint8Array(0), size};
        const responses = await command(`UID FETCH ${uid} (BODY.PEEK[])`);
        const bytes = responses.find(response => /FETCH/i.test(response.text) && response.literals.length)?.literals[0];
        return bytes ? {bytes, size} : null;
      },
      async folders() {
        return parseList(await command('LIST "" "*"'));
      },
      async structures(uids) {
        const out = new Map<number, string>();
        if (!uids.length) return out;
        for (const response of await command(`UID FETCH ${uids.join(',')} (UID BODYSTRUCTURE)`)) {
          const uid = Number(response.text.match(/\bUID (\d+)/i)?.[1]);
          if (Number.isSafeInteger(uid)) out.set(uid, response.text + ' ' + response.literals.map(literal => latin1.decode(literal)).join(' '));
        }
        return out;
      },
    };
    const value = await work(session);
    await command('LOGOUT').catch(() => undefined);
    return {ok: true, value};
  } catch (error) {
    const reason = error instanceof ImapError ? error.message : '';
    const texts: Record<string, string> = {login: 'pošta: přihlášení odmítnuto (heslo schránky)', timeout: 'pošta neodpověděla včas',
      greeting: 'pošta: server se neozval', closed: 'pošta: spojení se přerušilo', 'too-big': 'pošta: zpráva je příliš velká', no: 'pošta: server příkaz odmítl'};
    return {ok: false, error: texts[reason] ?? 'pošta není dostupná'};
  } finally {
    await socket?.close().catch(() => undefined);
  }
}
