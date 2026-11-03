import type { Dirent } from 'node:fs';
import { access, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { errnoCode } from '../ports/errno';
import { errorMessage } from '../ports/errorMessage';
import { isManifestPath, MANIFEST_SUFFIX } from '../repositoriesLib/manifestPath';
import type { PackagesAsked } from '../repositoriesLib/statusValues';
import { BUILD_FILE, PLUGIN_SOURCE_FOLDER } from '../wire/sourceMod';
import type { BuildFileAgainst, BuildFileLack, BuildFileRead, BuildStep } from './buildFile';
import { readBuildFile } from './buildFileRead';
import type { Manifest, ManifestRead } from './manifest';
import { manifestText, ordinal } from './manifestText';
import { readManifest } from './manifestRead';
import { packagesAsked } from './manifestPackages';

async function entriesIn(folder: string): Promise<Dirent[]> {
  try {
    return await readdir(folder, { withFileTypes: true });
  } catch (err) {
    if (errnoCode(err) === 'ENOENT') return [];
    throw err;
  }
}

const fileNamesIn = async (folder: string): Promise<string[]> =>
  (await entriesIn(folder)).filter((entry) => entry.isFile()).map(({ name }) => name).sort(ordinal);

// A name in any case, so a folder reads alike on Windows and Linux.
const spellingsIn = async (folder: string, name: string): Promise<string[]> =>
  (await fileNamesIn(folder)).filter((held) => held.toLowerCase() === name.toLowerCase());

export const manifestNameOf = (folder: string): string => `${basename(folder)}${MANIFEST_SUFFIX}`;

/** The names of the manifests `folder` holds, whatever they are named. */
export const manifestsIn = async (folder: string): Promise<string[]> => (await fileNamesIn(folder)).filter(isManifestPath);

const manifestFileIn = async (folder: string): Promise<string> => join(folder, (await manifestsIn(folder))[0] ?? manifestNameOf(folder));

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

function refuseUnlessReadable(text: string): void {
  const read = readManifest(text);
  if ('refused' in read) throw new Error(read.refused);
}

/** Writes `manifest` as the manifest named for `folder`, in the spelling it holds, and removes one named otherwise;
 *  true when a file changed. Rejects, writing nothing, when the folder holds two manifests, is not there or the text is refused. */
export async function writeManifestIn(folder: string, manifest: Manifest): Promise<boolean> {
  const [one, other] = await manifestsIn(folder);
  if (other !== undefined) throw new Error(twoManifests(one ?? '', other));
  const named = one?.toLowerCase() === manifestNameOf(folder).toLowerCase() ? one : undefined;
  const path = join(folder, named ?? manifestNameOf(folder));
  const text = manifestText(manifest);
  refuseUnlessReadable(text);
  if (named !== undefined && await textAt(path) === text) return false;
  await writeWhole(folder, path, text);
  if (one !== undefined && named === undefined) await rm(join(folder, one));
  return true;
}

async function buildFileAt(sourceFolder: string): Promise<{ readonly file: string; readonly read: BuildFileRead } | undefined> {
  const [one, other] = await spellingsIn(sourceFolder, BUILD_FILE);
  if (one === undefined) return undefined;
  const file = join(sourceFolder, one);
  return { file, read: other === undefined ? readBuildFile(await textAt(file)) : { refused: twoBuildFiles(one, other) } };
}

/** The build file at the root of the source mod's repository in `sourceFolder`; undefined when it holds none. */
export const buildFileIn = async (sourceFolder: string): Promise<BuildFileRead | undefined> => (await buildFileAt(sourceFolder))?.read;

// A path that cannot be read is held: the build says why it cannot read it.
const holds = (path: string): Promise<boolean> => access(path).then(() => true, (err: unknown) => !['ENOENT', 'ENOTDIR'].includes(errnoCode(err) ?? ''));

// The paths a step reads from the source folder: a compile step's name plugin sources.
const readBy = (step: BuildStep): { readonly step: BuildFileLack['step']; readonly paths: readonly string[] } | undefined => {
  switch (step.kind) {
    case 'decompile': case 'compile': case 'copy': return { step: step.kind, paths: step.paths };
    case 'unpack': return { step: 'unpack', paths: step.archives.map(({ path }) => path) };
    case 'script': return { step: 'script', paths: [step.script] };
    case 'pack': case 'task': case 'defaultScript': return undefined;
  }
};

/** Each path a build file step reads from `sourceFolder` that names nothing there; a plugin source is found in any case,
 *  as mEdit finds it. None when the folder holds no build file it can read. */
export async function buildFileAgainst(sourceFolder: string): Promise<BuildFileAgainst | undefined> {
  const unreadable = () => undefined;
  const [at, listed] = await Promise.all([buildFileAt(sourceFolder).catch(unreadable), entriesIn(join(sourceFolder, PLUGIN_SOURCE_FOLDER)).catch(unreadable)]);
  if (at === undefined || listed === undefined || 'refused' in at.read) return undefined;
  const sources = new Set(listed.filter((entry) => entry.isDirectory()).map(({ name }) => name.toLowerCase()));
  const lacks: BuildFileLack[] = [];
  for (const { step, paths } of at.read.buildFile.steps.flatMap((built) => readBy(built) ?? [])) {
    for (const path of paths) {
      const held = step === 'compile' ? sources.has(path.toLowerCase()) : await holds(join(sourceFolder, path));
      if (!held) lacks.push({ step, path });
    }
    if (step === 'decompile') for (const path of paths) sources.add(path.toLowerCase());
  }
  return { file: at.file, lacks };
}

/** What a folder holds of its manifest: the read, none when it holds none, and the path as the folder spells it. */
export interface ManifestAt {
  readonly read: ManifestRead | undefined;
  readonly file: string;
}

/** The manifest `folder` holds; a file that could not be read is a refusal that says so. */
export async function manifestAt(folder: string): Promise<ManifestAt> {
  try {
    return { read: await manifestIn(folder), file: await manifestFileIn(folder) };
  } catch (err) {
    return { read: { refused: `a file could not be read: ${errorMessage(err)}` }, file: manifestNameOf(folder) };
  }
}

/** What the Instance adapter is asked to read for a status of the manifest `at` holds; none when it holds none to compare. */
export const packagesAskedAt = ({ read }: ManifestAt): PackagesAsked | undefined => (read !== undefined && 'manifest' in read ? packagesAsked(read.manifest) : undefined);
