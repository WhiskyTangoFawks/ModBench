import { readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { errnoCode } from '../ports/errno';
import { MANIFEST_SUFFIX } from '../wire/sourceMod';
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

// An editor may write a byte order mark, which JSON does not allow.
const textAt = async (path: string): Promise<string> => (await readFile(path, 'utf8')).replace(/^\uFEFF/, '');

const read = async (path: string): Promise<ManifestRead> => readManifest(await textAt(path));

const twoManifests = (one: string, other: string): string => `its folder holds two manifests, '${one}' and '${other}'`;

/** The manifest named for `folder` in it, its name in any case, so a folder reads alike on Windows and Linux;
 *  undefined when it holds none. */
export async function manifestIn(folder: string): Promise<ManifestRead | undefined> {
  const named = `${basename(folder)}${MANIFEST_SUFFIX}`.toLowerCase();
  const [one, other] = (await fileNamesIn(folder)).filter((name) => name.toLowerCase() === named);
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

const manifestsNamedFor = async (folder: string): Promise<string[]> => {
  const named = `${basename(folder)}${MANIFEST_SUFFIX}`.toLowerCase();
  return (await fileNamesIn(folder)).filter((name) => name.toLowerCase() === named);
};

/** Writes `manifest` as the manifest `folder` holds, in the spelling it holds it in, else named for the folder; true
 *  when the file changed. Rejects, writing nothing, when the folder holds two manifests or is not there. */
export async function writeManifestIn(folder: string, manifest: Manifest): Promise<boolean> {
  const [one, other] = await manifestsNamedFor(folder);
  if (other !== undefined) throw new Error(twoManifests(one ?? '', other));
  const path = join(folder, one ?? `${basename(folder)}${MANIFEST_SUFFIX}`);
  const text = manifestText(manifest);
  if (one !== undefined && await textAt(path) === text) return false;
  await writeWhole(folder, path, text);
  return true;
}

/** Removes the manifest named for `folder` in it, in any case; does nothing when it holds none. */
export async function removeManifestIn(folder: string): Promise<void> {
  for (const name of await manifestsNamedFor(folder)) await rm(join(folder, name));
}

/** The name and text a source mod's repository holds `manifest` as: named for the output folder it names. */
export function sourceManifestFile(manifest: Manifest): { readonly name: string; readonly text: string } {
  if (manifest.output === undefined) throw new Error('A source mod\'s manifest names no output folder.');
  return { name: `${manifest.output}${MANIFEST_SUFFIX}`, text: manifestText(manifest) };
}

/** Writes `manifest` at the root of the source mod's repository in `sourceFolder`, named for its output folder, in place
 *  of the manifest there; true when the file changed. Rejects, writing nothing, a manifest that names no output folder. */
export async function writeSourceManifestIn(sourceFolder: string, manifest: Manifest): Promise<boolean> {
  const { name, text } = sourceManifestFile(manifest);
  const held = (await fileNamesIn(sourceFolder)).filter((one) => one.toLowerCase().endsWith(MANIFEST_SUFFIX));
  // A name that differs in case alone is the same file where the file system matches names without case.
  const sameButCase = held.find((one) => one !== name && one.toLowerCase() === name.toLowerCase());
  if (sameButCase !== undefined) await rename(join(sourceFolder, sameButCase), join(sourceFolder, name));
  const others = held.filter((one) => one.toLowerCase() !== name.toLowerCase());
  if (others.length === 0 && held.length > 0 && await textAt(join(sourceFolder, name)) === text) return false;
  await writeWhole(sourceFolder, join(sourceFolder, name), text);
  for (const other of others) await rm(join(sourceFolder, other), { force: true });
  return true;
}

/** The manifest at the root of the source mod's repository in `sourceFolder`, which names the folder it builds
 *  (ADR-0022); undefined when it holds none. */
export async function sourceManifestIn(sourceFolder: string): Promise<ManifestRead | undefined> {
  const [one, other] = (await fileNamesIn(sourceFolder)).filter((name) => name.toLowerCase().endsWith(MANIFEST_SUFFIX));
  if (one === undefined) return undefined;
  if (other !== undefined) return { refused: `its repository holds two manifests, '${one}' and '${other}'` };
  const held = await read(join(sourceFolder, one));
  if ('refused' in held) return held;
  const { output } = held.manifest;
  if (output === undefined) return { refused: 'its manifest names no output folder' };
  return one === `${output}${MANIFEST_SUFFIX}` ? held : { refused: `its manifest '${one}' is not named for its output folder '${output}'` };
}
