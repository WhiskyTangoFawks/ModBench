// The source mods: each repository in the source folder, and the mod its build configuration builds
// (ADR-0007). A rename leaves the repository where it is, so the output, never the folder's name, says
// which mod a source builds.

import { join } from 'node:path';
import { errnoCode } from '../ports/errno';
import { errorMessage } from '../ports/errorMessage';
import { get, isTracked, listFolders } from './files';
import type { SourceMods } from './instanceAdapter';
import { buildConfigurationFile, modFolderName, sourceRootDir } from './layout';
import { readOrAbsent } from './mo2Context';

async function outputOf(sourceFolder: string): Promise<{ output: string } | { reason: string }> {
  let text: string;
  try {
    text = await get(buildConfigurationFile(sourceFolder));
  } catch (err) {
    if (errnoCode(err) === 'ENOENT') return { reason: 'it has no build configuration' };
    throw err;
  }
  let configuration: unknown;
  try {
    configuration = JSON.parse(text);
  } catch (err) {
    return { reason: `its build configuration is not JSON: ${errorMessage(err)}` };
  }
  const output = typeof configuration === 'object' && configuration !== null && 'output' in configuration ? configuration.output : undefined;
  if (typeof output !== 'string') return { reason: 'its build configuration names no output' };
  return modFolderName(output) === undefined ? { reason: `its build configuration's output "${output}" is not a folder name` } : { output };
}

export async function sourceModsIn(instanceRoot: string): Promise<SourceMods> {
  const root = sourceRootDir(instanceRoot);
  const folders = new Map<string, string>();
  const notes: string[] = [];
  for (const name of (await readOrAbsent(() => listFolders(root), [])).sort()) {
    const folder = join(root, name);
    if (!(await isTracked(folder))) continue;
    const built = await outputOf(folder);
    if ('reason' in built) {
      notes.push(`${folder} is not a source mod: ${built.reason}.`);
      continue;
    }
    const holder = folders.get(built.output);
    if (holder === undefined) folders.set(built.output, folder);
    else notes.push(`${folder} is not a source mod: ${holder} builds "${built.output}" too.`);
  }
  return { folders, notes };
}
