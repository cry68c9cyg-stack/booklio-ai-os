/**
 * A small reader of e-mail messages (RFC 5322 with MIME parts), enough for what OKO1 takes from the venue's mailbox:
 * the sender, recipients, subject, date, the plain text and the attachments. Nested multiparts, base64,
 * quoted-printable, encoded words in headers (RFC 2047) and file names (RFC 2231) are understood; anything odd is
 * read as well as it goes instead of failing. No dependency, so nothing outside this repository runs on the mail.
 */

export type MailAddress = {name: string | null; address: string};
export type MailAttachment = {filename: string; contentType: string; data: Uint8Array};
export type Mail = {
  messageId: string | null; inReplyTo: string | null; references: string[]; date: string | null; subject: string;
  from: MailAddress | null; to: MailAddress[]; cc: MailAddress[]; text: string; attachments: MailAttachment[];
};

/** Most parts a message may have; a message beyond it is read up to there. */
const MAX_PARTS = 200;
const MAX_DEPTH = 8;

type Headers = Map<string, string>;

const latin1 = new TextDecoder('latin1');

function decodeCharset(bytes: Uint8Array, charset: string | undefined): string {
  const name = (charset ?? 'utf-8').trim().toLowerCase().replace(/^"|"$/g, '');
  try { return new TextDecoder(name === 'utf8' ? 'utf-8' : name).decode(bytes); } catch { return new TextDecoder('utf-8').decode(bytes); }
}

function base64Bytes(text: string): Uint8Array {
  const clean = text.replace(/[^A-Za-z0-9+/]/g, '');
  const padded = clean.length % 4 === 1 ? clean.slice(0, -1) : clean;
  try {
    const binary = atob(padded + '='.repeat((4 - padded.length % 4) % 4));
    return Uint8Array.from(binary, char => char.charCodeAt(0));
  } catch { return new Uint8Array(); }
}

function quotedPrintableBytes(text: string, inHeader = false): Uint8Array {
  const source = (inHeader ? text.replace(/_/g, ' ') : text).replace(/=\r?\n/g, '');
  const out: number[] = [];
  for (let index = 0; index < source.length; index++) {
    const char = source[index];
    if (char === '=' && /^[0-9A-Fa-f]{2}$/.test(source.slice(index + 1, index + 3))) {
      out.push(parseInt(source.slice(index + 1, index + 3), 16));
      index += 2;
    } else {
      const code = source.charCodeAt(index);
      out.push(code > 255 ? 63 : code);
    }
  }
  return Uint8Array.from(out);
}

/** Encoded words in a header (=?utf-8?B?...?= and =?iso-8859-2?Q?...?=). */
export function decodeWords(value: string): string {
  return value.replace(/\?=\s+=\?/g, '?==?').replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (_, charset: string, encoding: string, text: string) =>
    decodeCharset(encoding.toUpperCase() === 'B' ? base64Bytes(text) : quotedPrintableBytes(text, true), charset.split('*')[0]));
}

function parseHeaders(block: string): Headers {
  const headers: Headers = new Map();
  for (const line of block.replace(/\r?\n[ \t]+/g, ' ').split(/\r?\n/)) {
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    const name = line.slice(0, colon).trim().toLowerCase();
    if (!headers.has(name)) headers.set(name, line.slice(colon + 1).trim());
  }
  return headers;
}

function percentBytes(text: string): Uint8Array {
  const out: number[] = [];
  for (let index = 0; index < text.length; index++) {
    if (text[index] === '%' && /^[0-9A-Fa-f]{2}$/.test(text.slice(index + 1, index + 3))) {
      out.push(parseInt(text.slice(index + 1, index + 3), 16));
      index += 2;
    } else out.push(text.charCodeAt(index) & 255);
  }
  return Uint8Array.from(out);
}

/** The value and the parameters of a header such as Content-Type or Content-Disposition. */
function headerParams(value: string | undefined): {value: string; params: Map<string, string>} {
  const params = new Map<string, string>();
  if (!value) return {value: '', params};
  const parts = value.match(/(?:[^;"]+|"(?:[^"\\]|\\.)*")+/g) ?? [];
  const continued = new Map<string, string[]>();
  for (const part of parts.slice(1)) {
    const equals = part.indexOf('=');
    if (equals < 0) continue;
    const key = part.slice(0, equals).trim().toLowerCase();
    let raw = part.slice(equals + 1).trim();
    if (raw.startsWith('"')) raw = raw.slice(1, -1).replace(/\\(.)/g, '$1');
    // RFC 2231: name*0*=utf-8''..., name*1*=...
    const split = key.match(/^([^*]+)\*(\d+)?\*?$/);
    if (split) {
      const list = continued.get(split[1]) ?? [];
      list[Number(split[2] ?? 0)] = raw;
      continued.set(split[1], list);
    } else params.set(key, raw);
  }
  for (const [key, list] of continued) {
    const joined = list.join('');
    const match = joined.match(/^([^']*)'[^']*'(.*)$/);
    try {
      params.set(key, match ? decodeCharset(percentBytes(match[2]), match[1] || 'utf-8') : decodeURIComponent(joined));
    } catch { params.set(key, joined); }
  }
  return {value: (parts[0] ?? '').trim().toLowerCase(), params};
}

/** Addresses of a header: `Jan Novák <jan@example.cz>, info@example.cz`. */
export function parseAddresses(value: string | undefined): MailAddress[] {
  if (!value) return [];
  const out: MailAddress[] = [];
  for (const part of decodeWords(value).match(/(?:[^,"]+|"(?:[^"\\]|\\.)*")+/g) ?? []) {
    const angle = part.match(/^(.*)<([^>]+)>\s*$/);
    const address = (angle ? angle[2] : part).trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+$/.test(address)) continue;
    const name = angle ? angle[1].trim().replace(/^"|"$/g, '').replace(/\\(.)/g, '$1').trim() : '';
    out.push({name: name || null, address});
  }
  return out;
}

function bodyBytes(body: string, encoding: string | undefined): Uint8Array {
  const kind = (encoding ?? '').trim().toLowerCase();
  if (kind === 'base64') return base64Bytes(body);
  if (kind === 'quoted-printable') return quotedPrintableBytes(body);
  return Uint8Array.from(body, char => char.charCodeAt(0) & 255);
}

/** Text of an HTML part, good enough for reading: tags out, entities of the usual kind decoded. */
export function htmlText(html: string): string {
  return html.replace(/<(script|style|head)[^>]*>[\s\S]*?<\/\1>/gi, ' ').replace(/<br\s*\/?>|<\/(p|div|tr|li|h\d)>/gi, '\n').replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n\n').trim();
}

type Walk = {texts: string[]; htmls: string[]; attachments: MailAttachment[]; parts: number};

function walk(raw: string, walkState: Walk, depth: number) {
  if (walkState.parts++ >= MAX_PARTS || depth > MAX_DEPTH) return;
  const split = raw.search(/\r?\n\r?\n/);
  const headers = parseHeaders(split < 0 ? raw : raw.slice(0, split));
  const body = split < 0 ? '' : raw.slice(split).replace(/^\r?\n\r?\n/, '');
  const type = headerParams(headers.get('content-type'));
  const contentType = type.value || 'text/plain';
  if (contentType.startsWith('multipart/')) {
    const boundary = type.params.get('boundary');
    if (!boundary) return;
    const marker = '--' + boundary;
    const sections = body.split(new RegExp(`\\r?\\n?${marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    for (const section of sections.slice(1)) {
      if (section.startsWith('--')) break;
      walk(section.replace(/^[ \t]*\r?\n/, ''), walkState, depth + 1);
    }
    return;
  }
  if (contentType === 'message/rfc822') {
    walk(body, walkState, depth + 1);
    return;
  }
  const disposition = headerParams(headers.get('content-disposition'));
  const filename = decodeWords(disposition.params.get('filename') ?? type.params.get('name') ?? '').trim();
  const bytes = bodyBytes(body, headers.get('content-transfer-encoding'));
  if (filename || disposition.value === 'attachment' || !contentType.startsWith('text/')) {
    walkState.attachments.push({filename: filename || 'priloha', contentType, data: bytes});
    return;
  }
  const text = decodeCharset(bytes, type.params.get('charset'));
  (contentType === 'text/html' ? walkState.htmls : walkState.texts).push(text);
}

/** Reads a whole message (the bytes as they came from the server). */
export function parseMail(bytes: Uint8Array): Mail {
  const raw = latin1.decode(bytes);
  const split = raw.search(/\r?\n\r?\n/);
  const headers = parseHeaders(split < 0 ? raw : raw.slice(0, split));
  const state: Walk = {texts: [], htmls: [], attachments: [], parts: 0};
  walk(raw, state, 0);
  // Headers came as bytes; UTF-8 written into them without encoded words is read as UTF-8.
  const header = (name: string) => {
    const value = headers.get(name);
    if (value === undefined) return undefined;
    const asBytes = Uint8Array.from(value, char => char.charCodeAt(0) & 255);
    return decodeWords(/[\x80-\xff]/.test(value) ? decodeCharset(asBytes, 'utf-8') : value);
  };
  const id = (value: string | undefined) => value?.match(/<[^>]+>/)?.[0] ?? null;
  const parsedDate = headers.get('date') ? Date.parse(headers.get('date')!.replace(/\s*\([^)]*\)\s*$/, '')) : NaN;
  return {
    messageId: id(headers.get('message-id')), inReplyTo: id(headers.get('in-reply-to')),
    references: headers.get('references')?.match(/<[^>]+>/g) ?? [],
    date: Number.isFinite(parsedDate) ? new Date(parsedDate).toISOString() : null,
    subject: (header('subject') ?? '').trim(),
    from: parseAddresses(header('from'))[0] ?? null, to: parseAddresses(header('to')), cc: parseAddresses(header('cc')),
    text: (state.texts.length ? state.texts.join('\n\n') : state.htmls.map(htmlText).join('\n\n')).trim(),
    attachments: state.attachments,
  };
}
