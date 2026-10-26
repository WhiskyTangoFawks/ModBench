// The source mods: each repository in the source folder, and the mod its manifest builds (ADR-0022). A rename leaves the
// repository where it is, so the output, never the folder's name, says which mod a source builds.

import { join } from 'node:path';
import { errorMessage } from '../../ports/errorMessage';
import { get, ignoreSkippedLink, isRepository, listDir, listFolders, readOrAbsent } from '../files';
import type { SourceMods } from '../instanceAdapter';
import { MANIFEST_OUTPUT_KEY, MANIFEST_SUFFIX } from '../../wire/sourceMod';
import { modFolderName, sourceRootDir } from './layout';
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

async function outputOf(sourceFolder: string): Promise<{ output: string } | { reason: string }> {
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
  return manifest.name === `${output}${MANIFEST_SUFFIX}` ? { output } : { reason: `its manifest ${manifest.name} is not named for its output "${output}"` };
}

// MO2 matches mod names without case, so an output names the mod whatever its case.
export async function sourceModsIn(instanceRoot: string): Promise<SourceMods> {
  const root = sourceRootDir(instanceRoot);
  const byKey = new Map<string, { output: string; folder: string }>();
  const notes: string[] = [];
  for (const name of (await readOrAbsent(() => listFolders(root, ignoreSkippedLink), [])).sort()) {
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
