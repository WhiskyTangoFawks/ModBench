import { readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { errnoCode } from '../ports/errno';
import { isManifestPath, MANIFEST_SUFFIX } from '../repositoriesLib/manifestPath';
import { BUILD_FILE } from '../wire/sourceMod';
import type { BuildFileRead, Manifest, ManifestRead } from './manifest';
import { manifestText, ordinal } from './manifestText';
import { readBuildFile, readManifest } from './manifestRead';

async function fileNamesIn(folder: string): Promise<string[]> {
  try {
    return (await readdir(folder, { withFileTypes: true })).filter((entry) => entry.isFile()).map(({ name }) => name).sort(ordinal);
  } catch (err) {
    if (errnoCode(err) === 'ENOENT') return [];
    throw err;
  }
}

// A name in any case, so a folder reads alike on Windows and Linux.
const spellingsIn = async (folder: string, name: string): Promise<string[]> =>
  (await fileNamesIn(folder)).filter((held) => held.toLowerCase() === name.toLowerCase());

const manifestNameOf = (folder: string): string => `${basename(folder)}${MANIFEST_SUFFIX}`;

const manifestsIn = async (folder: string): Promise<string[]> => (await fileNamesIn(folder)).filter(isManifestPath);

/** The path of the manifest `folder` holds, else of the one named for it. */
export const manifestFileIn = async (folder: string): Promise<string> => join(folder, (await manifestsIn(folder))[0] ?? manifestNameOf(folder));

// An editor may write a byte order mark, which JSON does not allow.
const textAt = async (path: string): Promise<string> => (await readFile(path, 'utf8')).replace(/^\uFEFF/, '');

const twoManifests = (one: string, other: string): string => `its folder holds two manifests, '${one}' and '${other}'`;

const twoBuildFiles = (one: string, other: string): string => `its repository holds two build files, '${one}' and '${other}'`;

/** The one manifest `folder` holds, whatever its name; undefined when it holds none. */
export async function manifestIn(folder: string): Promise<ManifestRead | undefined> {
  const [one, other] = await manifestsIn(folder);
  if (other !== undefined) return { refused: twoManifests(one ?? '', other) };
  return one === undefined ? undefined : readManifest(await textAt(join(folder, one)));
}

// The Instance adapter's listings skip the temp's name.
async function writeWhole(folder: string, path: string, text: string): Promise<void> {
  const temp = join(folder, `.medit_tmp_${process.pid}_manifest`);
  try {
    await writeFile(temp, text);
    await rename(temp, path);
  } finally {
    await rm(temp, { force: true });
  }
}

/** Writes `manifest` as the manifest named for `folder`, in the spelling it holds it in, and removes one named otherwise;
 *  true when a file changed. Rejects, writing nothing, when the folder holds two manifests or is not there. */
export async function writeManifestIn(folder: string, manifest: Manifest): Promise<boolean> {
  const [one, other] = await manifestsIn(folder);
  if (other !== undefined) throw new Error(twoManifests(one ?? '', other));
  const named = one?.toLowerCase() === manifestNameOf(folder).toLowerCase() ? one : undefined;
  const path = join(folder, named ?? manifestNameOf(folder));
  const text = manifestText(manifest);
  if (named !== undefined && await textAt(path) === text) return false;
  await writeWhole(folder, path, text);
  if (one !== undefined && named === undefined) await rm(join(folder, one));
  return true;
}

/** The build file at the root of the source mod's repository in `sourceFolder`; undefined when it holds none. */
export async function buildFileIn(sourceFolder: string): Promise<BuildFileRead | undefined> {
  const [one, other] = await spellingsIn(sourceFolder, BUILD_FILE);
  if (other !== undefined) return { refused: twoBuildFiles(one ?? '', other) };
  return one === undefined ? undefined : readBuildFile(await textAt(join(sourceFolder, one)));
}
