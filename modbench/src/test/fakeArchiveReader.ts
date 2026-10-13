import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { ArchiveReader } from '../instanceAdapter/archiveReader';

/** Every archive holds `files`; extracting one writes each under the destination. */
export function fakeArchiveReader(files: readonly string[]): ArchiveReader {
  return {
    list: () => Promise.resolve(files.map((file) => file.replaceAll('\\', '/'))),
    extract: async (_archivePath, destDir) => {
      for (const file of files) {
        await mkdir(dirname(join(destDir, file)), { recursive: true });
        await writeFile(join(destDir, file), `bytes of ${file}`);
      }
    },
  };
}
