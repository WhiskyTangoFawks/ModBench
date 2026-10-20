import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { InstallationFileReader } from '../instanceAdapter/instanceAdapter';

/** Every installation file holds `files`; extracting one writes each under the destination. */
export function fakeInstallationFileReader(files: readonly string[]): InstallationFileReader {
  return {
    list: () => Promise.resolve(files.map((file) => file.replaceAll('\\', '/'))),
    extract: async (_installationFilePath, destDir) => {
      for (const file of files) {
        await mkdir(dirname(join(destDir, file)), { recursive: true });
        await writeFile(join(destDir, file), `bytes of ${file}`);
      }
    },
  };
}
