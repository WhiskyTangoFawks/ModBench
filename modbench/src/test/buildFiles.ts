import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { buildFileText, type BuildFile } from '../manifestAdapter/manifestAdapter';
import { BUILD_FILE } from '../wire/sourceMod';

/** A build file of one built-in step, but as `over` says. */
export const buildFileOf = (over: Partial<BuildFile> = {}): BuildFile => ({ steps: [{ kind: 'compile', paths: ['A.esp'] }], ...over });

/** Writes `buildFile` at the root of the repository in `sourceFolder`, as its author would. */
export const writeBuildFile = (sourceFolder: string, buildFile: BuildFile = buildFileOf()): Promise<void> =>
  writeFile(join(sourceFolder, BUILD_FILE), buildFileText(buildFile));
