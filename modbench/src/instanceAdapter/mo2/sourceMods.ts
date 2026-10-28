// The source mods: each repository in the source folder, and the mod its manifest builds (ADR-0022). A rename leaves the
// repository where it is, so the output, never the folder's name, says which mod a source builds.

import { join } from 'node:path';
import { errorMessage } from '../../ports/errorMessage';
import { exists, get, ignoreSkippedLink, isRepository, listDir, listFolders, readOrAbsent } from '../files';
import type { SourceMods } from '../instanceAdapter';
import { MANIFEST_OUTPUT_KEY, MANIFEST_SUFFIX } from '../../wire/sourceMod';
import { git } from '../git';
import { modFolderName, sourceModPath, sourceRootDir, submodulesFile } from './layout';
import { modNameKey } from './codecs/modlistText';

async function manifestIn(sourceFolder: string): Promise<{ name: string; text: string } | { reason: string }> {
  try {
    const [manifest, other] = (await listDir(sourceFolder))
      .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(MANIFEST_SUFFIX)).map(({ name }) => name).sort((a, b) => a.localeCompare(b));
    if (manifest === undefined) return { reason: 'it has no manifest' };
    if (other !== undefined) return { reason: `it holds two manifests, ${manifest} and ${other}` };
    return { name: manifest, text: await get(join(sourceFolder, manifest)) };
  } catch (err) {
    return { reason: `its manifest cannot be read: ${errorMessage(err)}` };
  }
}

async function outputOf(sourceFolder: string): Promise<{ output: string } | { reason: string; output?: string }> {
  const manifest = await manifestIn(sourceFolder);
  if ('reason' in manifest) return manifest;
  let parsed: unknown;
  try {
    parsed = JSON.parse(manifest.text);
  } catch (err) {
    return { reason: `its manifest is not JSON: ${errorMessage(err)}` };
  }
  const output = typeof parsed === 'object' && parsed !== null && MANIFEST_OUTPUT_KEY in parsed ? parsed[MANIFEST_OUTPUT_KEY] : undefined;
  if (typeof output !== 'string') return { reason: 'its manifest names no output folder' };
  if (modFolderName(output) === undefined) return { reason: `its manifest's output "${output}" is not a folder name` };
  return manifest.name === `${output}${MANIFEST_SUFFIX}` ? { output } : { reason: `its manifest ${manifest.name} is not named for its output "${output}"`, output };
}

/** The key of a `.gitmodules` entry that names the mod its repository's manifest builds, so a clone knows the mod before it can read the manifest. */
export const SUBMODULE_OUTPUT_KEY = 'output';

// The name of each .gitmodules entry for a source repository that records an output, by the mod it names.
async function entriesByOutput(instanceRoot: string): Promise<Map<string, string>> {
  const file = submodulesFile(instanceRoot);
  const byOutput = new Map<string, string>();
  if (!(await exists(file))) return byOutput;
  const values = new Map<string, string>();
  for (const entry of (await git(instanceRoot, 'config', '-f', file, '--null', '--list')).split('\0')) {
    const [key = '', value = ''] = entry.split('\n');
    values.set(key, value);
  }
  for (const [key, output] of values) {
    if (!key.startsWith('submodule.') || !key.endsWith(`.${SUBMODULE_OUTPUT_KEY}`)) continue;
    const name = key.slice('submodule.'.length, -`.${SUBMODULE_OUTPUT_KEY}`.length);
    if (values.get(`submodule.${name}.path`) === sourceModPath(name)) byOutput.set(modNameKey(output), name);
  }
  return byOutput;
}

async function unclonedOutputs(instanceRoot: string, notes: string[]): Promise<Set<string>> {
  try {
    const uncloned = new Set<string>();
    for (const [output, name] of await entriesByOutput(instanceRoot)) {
      if (!(await isRepository(join(sourceRootDir(instanceRoot), name)))) uncloned.add(output);
    }
    return uncloned;
  } catch (err) {
    notes.push(`${submodulesFile(instanceRoot)} could not be read, so no uncloned source mod is known: ${errorMessage(err)}.`);
    return new Set();
  }
}

/** Takes back the output `.gitmodules` records for `mod`, once its source is trashed and builds nothing. The entry is update
 *  manifest's to remove. Rejects when `.gitmodules` cannot be read or written. */
export async function outputUnset(instanceRoot: string, mod: string): Promise<void> {
  const name = (await entriesByOutput(instanceRoot)).get(modNameKey(mod));
  if (name !== undefined) await git(instanceRoot, 'config', '-f', submodulesFile(instanceRoot), '--unset-all', `submodule.${name}.${SUBMODULE_OUTPUT_KEY}`);
}

// MO2 matches mod names without case, so an output names the mod whatever its case.
export async function sourceModsIn(instanceRoot: string): Promise<SourceMods> {
  const root = sourceRootDir(instanceRoot);
  const byKey = new Map<string, { output: string; folder: string }>();
  const claims = new Map<string, string>();
  const builders = new Map<string, string[]>();
  const notes: string[] = [];
  for (const name of (await readOrAbsent(() => listFolders(root, ignoreSkippedLink), [])).sort()) {
    const folder = join(root, name);
    if (!(await isRepository(folder))) continue;
    const built = await outputOf(folder);
    if (built.output !== undefined) claims.set(folder, built.output);
    if ('reason' in built) {
      notes.push(`${folder} is not a source mod: ${built.reason}.`);
      continue;
    }
    const holder = byKey.get(modNameKey(built.output));
    if (holder === undefined) byKey.set(modNameKey(built.output), { output: built.output, folder });
    else {
      notes.push(`${folder} is not a source mod: ${holder.folder} builds "${holder.output}" too.`);
      builders.set(modNameKey(built.output), [...builders.get(modNameKey(built.output)) ?? [holder.folder], folder]);
    }
  }
  const uncloned = await unclonedOutputs(instanceRoot, notes);
  return {
    builds: (mod) => byKey.has(modNameKey(mod)) || uncloned.has(modNameKey(mod)),
    folders: new Map([...byKey.values()].map(({ output, folder }) => [output, folder])),
    folderOf: (mod) => byKey.get(modNameKey(mod))?.folder,
    claimedOutput: (folder) => claims.get(folder),
    buildersOf: (mod) => builders.get(modNameKey(mod)) ?? [],
    notes,
  };
}
