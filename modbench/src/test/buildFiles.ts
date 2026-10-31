import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { BUILD_FILE_VERSION, type BuildFile } from '../manifestAdapter/manifestAdapter';
import { BUILD_FILE } from '../wire/sourceMod';

export const buildFileOf = (over: Partial<BuildFile> = {}): BuildFile => ({ steps: [], archives: [], ...over });

/** The text of `buildFile` as its author writes it. */
export const buildFileText = ({ steps, archives }: BuildFile): string =>
  JSON.stringify({
    version: BUILD_FILE_VERSION,
    ...steps.length === 0 ? {} : { steps },
    ...archives.length === 0 ? {} : { archives: Object.fromEntries(archives.map(({ path, files }) => [path, files])) },
  });

/** Writes `buildFile` at the root of the repository in `sourceFolder`, as its author would. */
export const writeBuildFile = (sourceFolder: string, buildFile: BuildFile = buildFileOf()): Promise<void> =>
  writeFile(join(sourceFolder, BUILD_FILE), buildFileText(buildFile));
