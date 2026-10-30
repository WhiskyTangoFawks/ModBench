// The extension's byte-level reads (ADR-0004): the bytes go into a hash and nowhere else.

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import xxhash from 'xxhash-wasm';

const hasher = xxhash();

async function feed(path: string, update: (chunk: Buffer) => void): Promise<void> {
  const bytes: AsyncIterable<Buffer> = createReadStream(path);
  for await (const chunk of bytes) update(chunk);
}

/** xxHash64, its eight little-endian bytes in base64: the hash mEdit's manifest
 *  carries (ADR-0022). Streamed: a texture or an archive runs to gigabytes. */
export async function digestOf(path: string): Promise<string> {
  const hash = (await hasher).create64();
  await feed(path, (chunk) => hash.update(chunk));
  const digest = Buffer.alloc(8);
  digest.writeBigUInt64LE(hash.digest());
  return digest.toString('base64');
}

/** The hash of `text`'s UTF-8 bytes, written as `digestOf` writes it. */
export async function textHash(text: string): Promise<string> {
  const digest = Buffer.alloc(8);
  digest.writeBigUInt64LE((await hasher).h64Raw(Buffer.from(text, 'utf8')));
  return digest.toString('base64');
}

/** MD5 in hex, the hash Nexus finds a file by. Streamed. */
export async function md5Of(path: string): Promise<string> {
  const hash = createHash('md5');
  await feed(path, (chunk) => hash.update(chunk));
  return hash.digest('hex');
}
