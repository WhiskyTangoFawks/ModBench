import { readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { errnoCode } from '../ports/errno';
import { BUILD_FILE, MANIFEST_SUFFIX } from '../wire/sourceMod';
import type { Manifest, ManifestRead } from './manifest';
import { manifestText, ordinal } from './manifestText';
import { readManifest } from './manifestRead';

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

export const manifestNameOf = (folder: string): string => `${basename(folder)}${MANIFEST_SUFFIX}`;

// An editor may write a byte order mark, which JSON does not allow.
const textAt = async (path: string): Promise<string> => (await readFile(path, 'utf8')).replace(/^\uFEFF/, '');

const read = async (path: string, file?: string): Promise<ManifestRead> => readManifest(await textAt(path), file);

const twoManifests = (one: string, other: string): string => `its folder holds two manifests, '${one}' and '${other}'`;

const twoBuildFiles = (one: string, other: string): string => `its repository holds two build files, '${one}' and '${other}'`;

/** The manifest named for `folder` in it, its name in any case; undefined when it holds none. */
export async function manifestIn(folder: string): Promise<ManifestRead | undefined> {
  const [one, other] = await spellingsIn(folder, manifestNameOf(folder));
  if (other !== undefined) return { refused: twoManifests(one ?? '', other) };
  return one === undefined ? undefined : read(join(folder, one));
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

// `text` as the file of `name` in `folder`, in the spelling it holds it in; true when the file changed.
async function writeNamed(folder: string, name: string, text: string, two: (one: string, other: string) => string): Promise<boolean> {
  const [one, other] = await spellingsIn(folder, name);
  if (other !== undefined) throw new Error(two(one ?? '', other));
  const path = join(folder, one ?? name);
  if (one !== undefined && await textAt(path) === text) return false;
  await writeWhole(folder, path, text);
  return true;
}

/** Writes `manifest` as the manifest `folder` holds, in the spelling it holds it in, else named for the folder; true
 *  when the file changed. Rejects, writing nothing, when the folder holds two manifests or is not there. */
export const writeManifestIn = (folder: string, manifest: Manifest): Promise<boolean> =>
  writeNamed(folder, manifestNameOf(folder), manifestText(manifest), twoManifests);

/** Writes `buildFile` at the root of the source mod's repository in `sourceFolder`, in the spelling it holds it in. Rejects,
 *  writing nothing, when the repository holds two. */
export async function writeBuildFileIn(sourceFolder: string, buildFile: Manifest): Promise<void> {
  await writeNamed(sourceFolder, BUILD_FILE, manifestText(buildFile), twoBuildFiles);
}

/** The build file at the root of the source mod's repository in `sourceFolder`, which names the folder it builds; undefined
 *  when it holds none. */
export async function buildFileIn(sourceFolder: string): Promise<ManifestRead | undefined> {
  const [one, other] = await spellingsIn(sourceFolder, BUILD_FILE);
  if (other !== undefined) return { refused: twoBuildFiles(one ?? '', other) };
  if (one === undefined) return undefined;
  const held = await read(join(sourceFolder, one), 'build file');
  if ('refused' in held) return held;
  return held.manifest.output === undefined ? { refused: 'its build file names no output folder' } : held;
}
