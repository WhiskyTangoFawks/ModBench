import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { DownloadEntry } from './mo2/downloads';

// A metaless archive is a valid Downloaded row, so an absent sidecar is undefined, not an error.
async function readMetaText(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
}

/** `downloads/` absent reads as no downloads, not a failure — a fresh instance has none yet. */
export async function scanDownloads(instanceRoot: string): Promise<DownloadEntry[] | undefined> {
  const dir = join(instanceRoot, 'downloads');
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
  // .meta sidecars are suppressed as rows by buildDownloadRows, not filtered
  // here too — one place owns the suppression rule.
  return Promise.all(
    names.map(async (name) => {
      const filePath = join(dir, name);
      const [info, metaText] = await Promise.all([stat(filePath), readMetaText(`${filePath}.meta`)]);
      return { name, size: info.size, mtimeMs: info.mtimeMs, metaText };
    }),
  );
}
