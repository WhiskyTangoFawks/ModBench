// The source mods: each repository in the source folder, and the mod its build configuration builds
// (ADR-0007). A rename leaves the repository where it is, so the output, never the folder's name, says
// which mod a source builds.

import { join } from 'node:path';
import { errnoCode } from './errno';
import { errorMessage } from '../ports/errorMessage';
import { get, isRepository, listFolders, readOrAbsent } from './files';
import type { SourceMods } from './instanceAdapter';
import { BUILD_OUTPUT_KEY } from '../wire/sourceMod';
import { buildConfigurationFile, modFolderName, sourceRootDir } from './layout';
import { modNameKey } from './codecs/modlistText';

async function outputOf(sourceFolder: string): Promise<{ output: string } | { reason: string }> {
  let text: string;
  try {
    text = await get(buildConfigurationFile(sourceFolder));
  } catch (err) {
    return { reason: errnoCode(err) === 'ENOENT' ? 'it has no build configuration' : `its build configuration cannot be read: ${errorMessage(err)}` };
  }
  let configuration: unknown;
  try {
    configuration = JSON.parse(text);
  } catch (err) {
    return { reason: `its build configuration is not JSON: ${errorMessage(err)}` };
  }
  const output = typeof configuration === 'object' && configuration !== null && BUILD_OUTPUT_KEY in configuration
    ? configuration[BUILD_OUTPUT_KEY] : undefined;
  if (typeof output !== 'string') return { reason: 'its build configuration names no output' };
  return modFolderName(output) === undefined ? { reason: `its build configuration's output "${output}" is not a folder name` } : { output };
}

// MO2 matches mod names without case, so an output names the mod whatever its case.
export async function sourceModsIn(instanceRoot: string): Promise<SourceMods> {
  const root = sourceRootDir(instanceRoot);
  const byKey = new Map<string, { output: string; folder: string }>();
  const notes: string[] = [];
  for (const name of (await readOrAbsent(() => listFolders(root), [])).sort()) {
    const folder = join(root, name);
    if (!(await isRepository(folder))) continue;
    const built = await outputOf(folder);
    if ('reason' in built) {
      notes.push(`${folder} is not a source mod: ${built.reason}.`);
      continue;
    }
    const holder = byKey.get(modNameKey(built.output));
    if (holder === undefined) byKey.set(modNameKey(built.output), { output: built.output, folder });
    else notes.push(`${folder} is not a source mod: ${holder.folder} builds "${holder.output}" too.`);
  }
  return {
    folders: new Map([...byKey.values()].map(({ output, folder }) => [output, folder])),
    folderOf: (mod) => byKey.get(modNameKey(mod))?.folder,
    notes,
  };
}
