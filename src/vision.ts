/**
 * Reading a photo or a scanned PDF of a document (a paper invoice, a small receipt without a header) with Claude,
 * which reads printed and handwritten amounts from an image (MC, 18. 10. 2026: receipts photographed once a month).
 * Returns the fields of `EXTRACTION_SCHEMA`; the worker checks them with `parseExtraction`. Throws on any failure.
 * Only supplier documents go here, nothing about guests.
 */
import {EXTRACTION_SCHEMA, extractionPrompt} from './mail-invoices.ts';

const MODEL = 'claude-sonnet-5-5';
/** The API takes images up to 5 MB in base64; bigger photos stay unread (they still go to the accountant). */
export const MAX_PHOTO_BYTES = 3_700_000;
export const MAX_SCAN_BYTES = 15 * 1024 * 1024;

const base64 = (bytes: Uint8Array) => {
  let binary = '';
  for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  return btoa(binary);
};

export async function readDocumentScan(apiKey: string, venue: string, mediaType: string, data: Uint8Array): Promise<unknown> {
  const pdf = mediaType === 'application/pdf';
  if (data.length > (pdf ? MAX_SCAN_BYTES : MAX_PHOTO_BYTES)) throw new Error('TOO_BIG');
  const source = {type: 'base64', media_type: mediaType, data: base64(data)};
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json'},
    body: JSON.stringify({
      model: MODEL, max_tokens: 4096, tool_choice: {type: 'auto'},
      tools: [{name: 'doklad', description: 'Údaje z dokladu dodavatele.', input_schema: EXTRACTION_SCHEMA}],
      system: extractionPrompt(venue) + ' Odpověz jediným voláním nástroje doklad.',
      messages: [{role: 'user', content: [{type: pdf ? 'document' : 'image', source}, {type: 'text', text: 'Doklad je v příloze.'}]}],
    }),
    signal: AbortSignal.timeout(60000),
  });
  if (!response.ok) throw new Error(`ANTHROPIC_${response.status}`);
  const body = await response.json() as {content?: {type: string; input?: unknown; text?: string}[]};
  const input = body.content?.find(part => part.type === 'tool_use')?.input;
  if (input) return input;
  const text = body.content?.find(part => part.type === 'text')?.text?.match(/\{[\s\S]*\}/)?.[0];
  if (!text) throw new Error('ANTHROPIC_BAD_OUTPUT');
  return JSON.parse(text);
}
