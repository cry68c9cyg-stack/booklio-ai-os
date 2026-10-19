/**
 * Sending one e-mail through the venue's own mail server (SMTP over TLS, RFC 5321 and RFC 4954 AUTH PLAIN), with the
 * same account OKO1 reads the mailbox with. Used only for the messages MC approved (the list of invoices for the batch
 * payment to the office, 18. 10. 2026). The password goes only into AUTH over TLS and never into a log or an error text.
 */

export type SmtpAccount = {host: string; port: number; user: string; password: string};
export type OutgoingMail = {
  from: {name: string; address: string}; to: string[]; subject: string; text: string;
  attachments: {filename: string; contentType: string; data: Uint8Array}[];
  /** Marked as high priority in mail clients (Importance, X-Priority). */
  important?: boolean;
};
export type Sent = {ok: true} | {ok: false; error: string};

const encoder = new TextEncoder();
const latin1 = new TextDecoder('latin1');
const ADDRESS = /^[^\s@<>"(),;:]+@[a-z0-9-]+(\.[a-z0-9-]+)+$/i;

class SmtpError extends Error {}

export const validAddress = (address: string) => address.length <= 200 && ADDRESS.test(address);

const base64 = (bytes: Uint8Array) => {
  let binary = '';
  for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  return btoa(binary);
};
const wrapped = (bytes: Uint8Array) => base64(bytes).replace(/.{1,76}/g, line => line + '\r\n');
/** A header value in UTF-8 (RFC 2047), split so no encoded word is over 75 characters. */
export function encodedWord(value: string): string {
  if (/^[\x20-\x7e]*$/.test(value)) return value;
  const words: string[] = [];
  let part = '';
  for (const char of value) {
    if (encoder.encode(part + char).length > 42) { words.push(part); part = ''; }
    part += char;
  }
  if (part) words.push(part);
  return words.map(word => `=?UTF-8?B?${base64(encoder.encode(word))}?=`).join('\r\n ');
}

/** The whole message, CRLF line ends, ready for DATA (dot-stuffing is done by `sendMail`). */
export function mailMessage(mail: OutgoingMail, now: Date, id: string): string {
  if (!validAddress(mail.from.address) || !mail.to.length || !mail.to.every(validAddress)) throw new SmtpError('address');
  const boundary = `oko1-${id}`;
  const headers = [
    `From: ${encodedWord(mail.from.name)} <${mail.from.address}>`, `To: ${mail.to.join(', ')}`, `Subject: ${encodedWord(mail.subject)}`,
    `Date: ${now.toUTCString().replace('GMT', '+0000')}`, `Message-ID: <${id}@oko1>`, 'MIME-Version: 1.0', 'Auto-Submitted: auto-generated',
    ...(mail.important ? ['Importance: high', 'X-Priority: 1'] : []),
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
  ];
  const parts = [
    `--${boundary}\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${wrapped(encoder.encode(mail.text.replace(/\r?\n/g, '\r\n')))}`,
    ...mail.attachments.map(file => `--${boundary}\r\nContent-Type: ${file.contentType}; name="${file.filename}"\r\nContent-Disposition: attachment; filename="${file.filename}"\r\n` +
      `Content-Transfer-Encoding: base64\r\n\r\n${wrapped(file.data)}`),
  ];
  return headers.join('\r\n') + '\r\n\r\n' + parts.join('') + `--${boundary}--\r\n`;
}

/** Lines starting with a dot get one more (RFC 5321 4.5.2), then the end of DATA. */
export const dotStuffed = (message: string) => message.replace(/^\./gm, '..') + '.\r\n';

/** Reads SMTP replies: "250-…" lines continue, "250 …" ends one; the code of the reply. */
export class SmtpReader {
  private buffer = '';
  private read: () => Promise<Uint8Array | null>;
  constructor(read: () => Promise<Uint8Array | null>) { this.read = read; }

  async reply(): Promise<number> {
    for (;;) {
      const end = this.buffer.indexOf('\n');
      if (end >= 0) {
        const line = this.buffer.slice(0, end).replace(/\r$/, '');
        this.buffer = this.buffer.slice(end + 1);
        const match = line.match(/^(\d{3})([ -])/);
        if (!match) throw new SmtpError('reply');
        if (match[2] === ' ') return Number(match[1]);
        continue;
      }
      if (this.buffer.length > 65536) throw new SmtpError('reply');
      const chunk = await this.read();
      if (!chunk) throw new SmtpError('closed');
      this.buffer += latin1.decode(chunk);
    }
  }
}

/** Sends `mail`; with null only logs in and out (the deploy's check). Never throws: a failure is a short Czech text without the password. */
export async function sendMail(account: SmtpAccount, mail: OutgoingMail | null, now = new Date(), budgetMs = 30000): Promise<Sent> {
  let socket: {readable: ReadableStream<Uint8Array>; writable: WritableStream<Uint8Array>; close(): Promise<void>} | null = null;
  const deadline = Date.now() + budgetMs;
  try {
    const message = mail ? mailMessage(mail, now, crypto.randomUUID()) : null;
    const sockets = await import('cloudflare:sockets');
    socket = sockets.connect({hostname: account.host, port: account.port}, {secureTransport: 'on', allowHalfOpen: false});
    const streamReader = socket.readable.getReader(), writer = socket.writable.getWriter();
    const reader = new SmtpReader(async () => {
      const left = deadline - Date.now();
      if (left <= 0) throw new SmtpError('timeout');
      let timer: ReturnType<typeof setTimeout> | undefined;
      const result = await Promise.race([streamReader.read(), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new SmtpError('timeout')), left); })]);
      clearTimeout(timer);
      return result.done ? null : result.value;
    });
    const step = async (line: string | null, expected: number, failure = 'refused') => {
      if (line !== null) await writer.write(encoder.encode(line + '\r\n'));
      if (await reader.reply() !== expected) throw new SmtpError(failure);
    };
    await step(null, 220, 'greeting');
    await step('EHLO oko1', 250);
    await step(`AUTH PLAIN ${base64(encoder.encode(`\0${account.user}\0${account.password}`))}`, 235, 'login');
    if (mail && message) {
      await step(`MAIL FROM:<${mail.from.address}>`, 250);
      for (const to of mail.to) await step(`RCPT TO:<${to}>`, 250, 'recipient');
      await step('DATA', 354);
      await writer.write(encoder.encode(dotStuffed(message)));
      await step(null, 250);
    }
    await writer.write(encoder.encode('QUIT\r\n')).catch(() => undefined);
    return {ok: true};
  } catch (error) {
    const reason = error instanceof SmtpError ? error.message : '';
    const texts: Record<string, string> = {login: 'odeslání: přihlášení odmítnuto (heslo schránky)', timeout: 'odeslání: server neodpověděl včas',
      greeting: 'odeslání: server se neozval', closed: 'odeslání: spojení se přerušilo', recipient: 'odeslání: server odmítl adresu příjemce',
      address: 'odeslání: neplatná adresa', refused: 'odeslání: server zprávu odmítl', reply: 'odeslání: nesrozumitelná odpověď serveru'};
    return {ok: false, error: texts[reason] ?? 'odeslání není dostupné'};
  } finally {
    await socket?.close().catch(() => undefined);
  }
}
