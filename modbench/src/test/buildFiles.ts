import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { manifestText, type Manifest } from '../manifestAdapter/manifestAdapter';
import { BUILD_FILE } from '../wire/sourceMod';

/** A build file as its author writes it, which holds no exclusion. */
export type BuildFile = Omit<Manifest, 'exclude'>;

export const buildFileOf = (over: Partial<BuildFile> = {}): BuildFile => ({ packages: [], archives: [], steps: [], tools: [], files: [], ...over });

/** Writes `buildFile` at the root of the repository in `sourceFolder`, as its author would. */
export const writeBuildFile = (sourceFolder: string, buildFile: BuildFile = buildFileOf()): Promise<void> =>
  writeFile(join(sourceFolder, BUILD_FILE), manifestText({ ...buildFile, exclude: [] }));
