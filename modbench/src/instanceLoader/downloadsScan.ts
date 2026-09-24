import { join } from 'node:path';
import type { DownloadEntry } from '../mo2Codecs/downloads';
import { DOWNLOAD_SIDECAR_SUFFIX } from '../mo2Codecs/downloads';
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

/** The resolved downloads folder absent reads as no downloads, not a failure — MO2 does not
 *  create it until a first download lands, and Modbench does not either. */
export async function scanDownloads(downloadsDir: string): Promise<DownloadEntry[] | undefined> {
  let names: string[];
  try {
    // A folder is never a download of its own — MO2 lists files by the installers' extensions,
    // never folders — so a subfolder here is skipped before it ever becomes an entry.
    names = (await listDir(downloadsDir)).filter((dirent) => dirent.isFile()).map((dirent) => dirent.name);
  } catch (err) {
    if (errnoCode(err) === 'ENOENT') return undefined;
    throw err;
  }
  // .meta sidecars are suppressed as rows by buildDownloadRows, not filtered
  // here too — one place owns the suppression rule.
  return Promise.all(
    names.map(async (name) => {
      const filePath = join(downloadsDir, name);
      const [facts, metaText] = await Promise.all([factsOf(filePath), readMetaText(filePath + DOWNLOAD_SIDECAR_SUFFIX)]);
      return { name, size: facts.size, mtimeMs: facts.mtimeMs, metaText };
    }),
  );
}
