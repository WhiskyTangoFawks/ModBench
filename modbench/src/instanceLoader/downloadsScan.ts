import { join } from 'node:path';
import type { DownloadEntry } from '../mo2Codecs/downloads';
import { DOWNLOAD_SIDECAR_SUFFIX } from '../mo2Codecs/downloads';
import { downloadsDir } from '../instanceAdapter/layout';
import { factsOf, get, listDir } from '../instanceAdapter/files';
import { errnoCode } from '../ports/errno';

// A metaless archive is a valid Downloaded row, so an absent sidecar is undefined, not an error.
async function readMetaText(path: string): Promise<string | undefined> {
  try {
    return await get(path);
  } catch (err) {
    if (errnoCode(err) === 'ENOENT') return undefined;
    throw err;
  }
}

/** `downloads/` absent reads as no downloads, not a failure — a fresh instance has none yet. */
export async function scanDownloads(instanceRoot: string): Promise<DownloadEntry[] | undefined> {
  const dir = downloadsDir(instanceRoot);
  let names: string[];
  try {
    names = (await listDir(dir)).map((dirent) => dirent.name);
  } catch (err) {
    if (errnoCode(err) === 'ENOENT') return undefined;
    throw err;
  }
  // .meta sidecars are suppressed as rows by buildDownloadRows, not filtered
  // here too — one place owns the suppression rule.
  return Promise.all(
    names.map(async (name) => {
      const filePath = join(dir, name);
      const [facts, metaText] = await Promise.all([factsOf(filePath), readMetaText(filePath + DOWNLOAD_SIDECAR_SUFFIX)]);
      return { name, size: facts.size, mtimeMs: facts.mtimeMs, metaText };
    }),
  );
}
