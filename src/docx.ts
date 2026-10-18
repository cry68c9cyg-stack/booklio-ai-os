/** Plain text of a Word document (.docx): one line per paragraph, tabs and line breaks kept. No formatting. */
import {unzip} from './zip.ts';

const entities: Record<string, string> = {amp: '&', lt: '<', gt: '>', quot: '"', apos: "'"};
const decodeXml = (value: string) => value.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, code: string) =>
  code[0] === '#' ? String.fromCodePoint(code[1] === 'x' || code[1] === 'X' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10)) : entities[code.toLowerCase()]);

export async function readDocx(bytes: Uint8Array): Promise<string> {
  const files = await unzip(bytes, name => name === 'word/document.xml');
  const xml = files.get('word/document.xml');
  if (!xml) throw new Error('NOT_A_DOCX');
  const body = new TextDecoder().decode(xml);
  const paragraphs = [...body.matchAll(/<w:p[\s>][\s\S]*?<\/w:p>|<w:p\/>/g)].map(match => match[0]
    .replace(/<w:tab\/>/g, '\t').replace(/<w:(?:br|cr)\/>/g, '\n')
    .replace(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<[^>]+>/g, (_, text: string | undefined) => text === undefined ? '' : decodeXml(text)));
  return paragraphs.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}
