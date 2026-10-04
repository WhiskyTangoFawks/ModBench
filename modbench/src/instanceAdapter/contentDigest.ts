// The one byte-level read in the extension (ADR-0004): the bytes go into a hash and nowhere else.

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';

/** Streamed: a texture or an archive runs to gigabytes. */
export async function digestOf(path: string): Promise<string> {
  const hash = createHash('sha256');
  const bytes: AsyncIterable<Buffer> = createReadStream(path);
  for await (const chunk of bytes) hash.update(chunk);
  return hash.digest('hex');
}
