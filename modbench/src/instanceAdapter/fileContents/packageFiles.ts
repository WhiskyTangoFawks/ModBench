// The files a manifest's packages hold, written into the folder it builds (modlist-repository.md, Restore from manifest,
// story 1).

import { randomUUID } from 'node:crypto';
import { copyFile, rename } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { ensureDir, makeTempDir, ownTempPrefix, realPathIfThere, remove, withLock } from '../files';
import type { InstanceAdapter, PackageFile } from '../instanceAdapter';
import { EXTRACTION_PREFIX } from './hashIndex';
import type { InstallationFileReader } from './installationFileReader';

const reachesOut = (path: string): boolean => path.split('/').some((segment) => ['', '.', '..'].includes(segment) || segment.includes('\\'));

const isInside = (folder: string, path: string): boolean => {
  const inFolder = relative(folder, path);
  return !isAbsolute(inFolder) && inFolder.split(sep)[0] !== '..';
};

// The nearest folder above `path` that is there, its links resolved, decides where a write lands.
async function landsInside(folder: string, path: string): Promise<boolean> {
  const real = await realPathIfThere(folder) ?? folder;
  for (let up = dirname(path); ; up = dirname(up)) {
    const there = await realPathIfThere(up);
    if (there !== undefined) return isInside(real, there);
    if (dirname(up) === up) return false;
  }
}

// A temp beside the target, then one rename, so a reader never meets half a file.
async function putCopy(from: string, to: string): Promise<void> {
  await ensureDir(dirname(to));
  const temp = `${ownTempPrefix(dirname(to), 'package')}_${randomUUID()}`;
  try {
    await copyFile(from, temp);
    await rename(temp, to);
  } finally {
    await remove(temp);
  }
}

const entriesByDownloadedFile = (files: readonly { to: string; from: PackageFile }[]): Map<string, { to: string; entry: string }[]> => {
  const grouped = new Map<string, { to: string; entry: string }[]>();
  for (const { to, from } of files) {
    if (from.kind === 'entry') grouped.set(from.downloadedFile, [...grouped.get(from.downloadedFile) ?? [], { to, entry: from.entry }]);
  }
  return grouped;
};

/** Writes files from their packages, extracting a downloaded file in `scratch` as the hash index does, one at a time. */
export function packageFilesWriter(scratch: string, reader: InstallationFileReader): Pick<InstanceAdapter, 'writeFilesIn'> {
  return {
    async writeFilesIn(folder, files) {
      const targets: { to: string; from: PackageFile }[] = [];
      for (const { path, from } of files) {
        const to = join(folder, path);
        if (reachesOut(path) || !(await landsInside(folder, to))) throw new Error(`Not a file of "${folder}": "${path}"`);
        targets.push({ to, from });
      }
      for (const { to, from } of targets) {
        if (from.kind === 'gameFile') await putCopy(join(from.root, from.path), to);
      }
      for (const [downloadedFile, entries] of entriesByDownloadedFile(targets)) {
        await withLock(join(scratch, EXTRACTION_PREFIX), async () => {
          await ensureDir(scratch);
          const extraction = await makeTempDir(join(scratch, EXTRACTION_PREFIX));
          try {
            await reader.extract(downloadedFile, extraction);
            for (const { to, entry } of entries) await putCopy(join(extraction, entry), to);
          } finally {
            await remove(extraction);
          }
        });
      }
    },
  };
}
