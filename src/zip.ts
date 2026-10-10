/** Minimal ZIP reader for .xlsx files: stored and deflated entries, no encryption, no ZIP64. */

export class ZipError extends Error {}

// A Worker has 128 MB of memory; a real daily report unpacks to well under 1 MB.
const MAX_TOTAL = 40 * 1024 * 1024;

/** Inflates at most `limit` bytes; a larger output (a ZIP bomb or a lying header) is an error. */
async function inflate(data: Uint8Array, limit: number): Promise<Uint8Array> {
  const reader = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw')).getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const part = await reader.read();
    if (part.done) break;
    size += part.value.byteLength;
    if (size > limit) { await reader.cancel(); throw new ZipError('ENTRY_TOO_LARGE'); }
    chunks.push(part.value);
  }
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
  return result;
}

/** Returns the entries whose names pass `wanted`, decompressed. */
export async function unzip(bytes: Uint8Array, wanted: (name: string) => boolean = () => true): Promise<Map<string, Uint8Array>> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // End of central directory: last 22 bytes plus an optional comment of up to 64 KiB.
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 65535); i--) {
    if (view.getUint32(i, true) === 0x06054b50) { end = i; break; }
  }
  if (end < 0) throw new ZipError('NOT_A_ZIP');
  const count = view.getUint16(end + 10, true);
  let offset = view.getUint32(end + 16, true);
  const decoder = new TextDecoder();
  const result = new Map<string, Uint8Array>();
  let budget = MAX_TOTAL;
  for (let n = 0; n < count; n++) {
    if (offset + 46 > bytes.length || view.getUint32(offset, true) !== 0x02014b50) throw new ZipError('BAD_DIRECTORY');
    const method = view.getUint16(offset + 10, true);
    const compressed = view.getUint32(offset + 20, true), size = view.getUint32(offset + 24, true);
    const nameLength = view.getUint16(offset + 28, true), extra = view.getUint16(offset + 30, true), comment = view.getUint16(offset + 32, true);
    const local = view.getUint32(offset + 42, true);
    const name = decoder.decode(bytes.subarray(offset + 46, offset + 46 + nameLength));
    offset += 46 + nameLength + extra + comment;
    if (!wanted(name)) continue;
    if (size > budget) throw new ZipError('ENTRY_TOO_LARGE');
    budget -= size;
    if (local + 30 > bytes.length || view.getUint32(local, true) !== 0x04034b50) throw new ZipError('BAD_ENTRY');
    const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    const data = bytes.subarray(start, start + compressed);
    if (data.length !== compressed) throw new ZipError('BAD_ENTRY');
    if (method === 0) result.set(name, data);
    else if (method === 8) result.set(name, await inflate(data, size));
    else throw new ZipError('UNSUPPORTED_METHOD');
  }
  return result;
}
