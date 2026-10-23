// The one byte-level read in the extension (ADR-0004): the bytes go into a hash and nowhere else.

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import xxhash from 'xxhash-wasm';

const hasher = xxhash();

/** xxHash64 as Wabbajack writes it, its eight little-endian bytes in base64: the hash mEdit's manifest
 *  carries (ADR-0022). Streamed: a texture or an archive runs to gigabytes. */
export async function digestOf(path: string): Promise<string> {
  const hash = (await hasher).create64();
  const bytes: AsyncIterable<Buffer> = createReadStream(path);
  for await (const chunk of bytes) hash.update(chunk);
  const digest = Buffer.alloc(8);
  digest.writeBigUInt64LE(hash.digest());
  return digest.toString('base64');
}

/** MD5 in hex, the hash Nexus finds a file by. Streamed. */
export async function md5Of(path: string): Promise<string> {
  const hash = createHash('md5');
  const bytes: AsyncIterable<Buffer> = createReadStream(path);
  for await (const chunk of bytes) hash.update(chunk);
  return hash.digest('hex');
}
