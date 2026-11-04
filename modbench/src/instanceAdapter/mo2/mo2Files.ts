// An origin's files as MO2 lays them out: a mod folder walked as MO2's VFS walks it, and the
// overwrite folder listed whole. Neither answers the adapter's own writes in flight.

import type { Dirent } from 'node:fs';
import { sep } from 'node:path';
import { errnoCode } from '../../ports/errno';
import { errorMessage } from '../../ports/errorMessage';
import { MOD_META_FILE_NAME } from './codecs/metaIni';
import { OVERWRITE_ORIGIN } from '../../wire/pluginAddress';
import { factsOf, listDirByStamp, isOwnTemp, realPathIfThere } from '../files';
import type { FileOrigin, ModFolders, OriginFile, OriginFiles, OriginFolder } from '../instanceAdapter';
import { isManifestPath } from '../../repositoriesLib/manifestPath';
import { includedPathOf, isExcludedName, overwriteDir } from './layout';
import { originFolder, type Mo2Context } from './mo2Context';

// The mod's metadata is MO2's and its manifest is Modbench's: neither is the mod's content.
const NOT_CONTENT: ReadonlySet<string> = new Set([MOD_META_FILE_NAME]);

interface Walk {
  readonly root: string;
  readonly notContent: ReadonlySet<string>;
  readonly manifestAtRoot: boolean;
  /** Lists the origin's root alone, never a folder below it. */
  readonly rootOnly: boolean;
  readonly files: OriginFile[];
  readonly folders: OriginFolder[];
  readonly notes: string[];
  /** Each folder listed, with the listing it answered. */
  readonly listings: [string, Dirent[]][];
  /** False once the walk met what a folder's stamp does not cover: a link, or a folder gone mid-read. */
  stampsCover: boolean;
}

async function listed(walk: Walk, dir: string): Promise<Dirent[]> {
  const listing = await listDirByStamp(dir);
  walk.listings.push([dir, listing]);
  return listing;
}

const relativeUnder = (root: string, path: string): string => {
  const below = path.slice(root.length + 1);
  return sep === '/' ? below : below.split(sep).join('/');
};

const childOf = (dir: string, name: string): string => dir + sep + name;

// MO2 keeps from the game every entry whose name, or a folder's above it, carries its suffix.
const isExcluded = (relativePath: string): boolean => relativePath.split('/').some(isExcludedName);

export const originFileOf = (relativePath: string, path: string, sourcePath: string = path): OriginFile =>
  ({ relativePath, path, sourcePath, excluded: isExcluded(relativePath), markedExcluded: isExcludedName(relativePath), includedPath: includedPathOf(relativePath) });

function keep(walk: Walk, path: string, sourcePath: string = path): void {
  const relativePath = relativeUnder(walk.root, path);
  if (walk.notContent.has(relativePath) || (walk.manifestAtRoot && isManifestPath(relativePath))) return;
  walk.files.push(originFileOf(relativePath, path, sourcePath));
}

const keepFolder = (walk: Walk, path: string): void => {
  const relativePath = relativeUnder(walk.root, path);
  walk.folders.push({ relativePath, path, includedPath: includedPathOf(relativePath), excluded: isExcluded(relativePath) });
};

// Another tool can remove a subfolder mid-walk: that skips it alone, noted. The root's absence is
// its caller's to answer.
async function inSubfolder(walk: Walk, dir: string, visit: () => Promise<void>): Promise<void> {
  try {
    await visit();
  } catch (err) {
    if (errnoCode(err) !== 'ENOENT') throw err;
    walk.stampsCover = false;
    walk.notes.push(`"${dir}" was removed mid-read, skipped`);
  }
}

// A directory reached through a link (`linkedTo`, its real path) is entered only when that is none of its ancestors'. Resolving
// them only then keeps a walk with no link to one stat per folder.
async function descend(walk: Walk, dir: string, ancestors: readonly string[], linkedTo?: string): Promise<void> {
  await inSubfolder(walk, dir, async () => {
    if (linkedTo !== undefined && (await Promise.all(ancestors.map(realPathIfThere))).includes(linkedTo)) {
      walk.notes.push(`link cycle at "${dir}", skipped`);
      return;
    }
    keepFolder(walk, dir);
    await walkDir(walk, dir, [...ancestors, dir]);
  });
}

// A link is followed as MO2 follows it; a broken one is skipped and noted, and any other failure
// rejects rather than reading as nothing there.
async function walkLink(walk: Walk, path: string, ancestors: readonly string[]): Promise<void> {
  walk.stampsCover = false;
  let facts;
  try {
    facts = await factsOf(path);
  } catch (err) {
    if (errnoCode(err) !== 'ENOENT') throw err;
    walk.notes.push(`broken link "${path}", skipped (${errorMessage(err)})`);
    return;
  }
  if (facts.kind === 'directory') {
    if (!walk.rootOnly) await descend(walk, path, ancestors, facts.realPath);
  }
  else if (facts.kind === 'file') keep(walk, path, facts.realPath);
  else walk.notes.push(`link "${path}" names no file or folder, skipped`);
}

async function walkDir(walk: Walk, dir: string, ancestors: readonly string[]): Promise<void> {
  for (const dirent of await listed(walk, dir)) {
    if (isOwnTemp(dirent.name)) continue;
    const path = childOf(dir, dirent.name);
    if (dirent.isDirectory()) {
      if (!walk.rootOnly) await descend(walk, path, ancestors);
    } else if (dirent.isFile()) {
      keep(walk, path);
    } else if (dirent.isSymbolicLink()) {
      await walkLink(walk, path, ancestors);
    } else {
      walk.notes.push(`"${path}" is a socket, FIFO or device node, skipped`);
    }
  }
}

async function walkMod(folder: string, rootOnly: boolean): Promise<Walk> {
  const walk: Walk = { root: folder, notContent: NOT_CONTENT, manifestAtRoot: true, rootOnly, files: [], folders: [], notes: [], listings: [], stampsCover: true };
  try {
    await walkDir(walk, folder, [folder]);
  } catch (err) {
    if (errnoCode(err) !== 'ENOENT') throw err;
    return { ...walk, files: [], folders: [], notes: [], stampsCover: false };
  }
  return walk;
}

async function listWhole(walk: Walk, dir: string): Promise<void> {
  for (const dirent of await listed(walk, dir)) {
    if (isOwnTemp(dirent.name)) continue;
    const path = childOf(dir, dirent.name);
    if (dirent.isDirectory()) {
      if (walk.rootOnly) continue;
      await inSubfolder(walk, path, () => {
        keepFolder(walk, path);
        return listWhole(walk, path);
      });
    }
    else if (dirent.isFile()) keep(walk, path);
    else if (dirent.isSymbolicLink()) walk.notes.push(`link "${path}" is not followed here, skipped`);
    else walk.notes.push(`"${path}" is a socket, FIFO or device node, skipped`);
  }
}

async function listOverwrite(folder: string, rootOnly: boolean): Promise<Walk> {
  const walk: Walk = { root: folder, notContent: NOT_CONTENT, manifestAtRoot: false, rootOnly, files: [], folders: [], notes: [], listings: [], stampsCover: true };
  try {
    await listWhole(walk, folder);
  } catch (err) {
    if (errnoCode(err) !== 'ENOENT') throw err;
    return { ...walk, files: [], folders: [], notes: [], stampsCover: false };
  }
  return walk;
}

/** The files below `folder` as a mod's are listed, its manifest not among them. */
export async function filesBelow(folder: string): Promise<{ files: OriginFile[]; notes: string[] }> {
  const { files, notes } = await walkMod(folder, false);
  return { files, notes };
}

interface Walked {
  readonly listings: readonly (readonly [string, Dirent[]])[];
  readonly files: OriginFiles;
}

const listingsStill = async ({ listings }: Walked): Promise<boolean> => {
  try {
    return (await Promise.all(listings.map(async ([dir, listing]) => (await listDirByStamp(dir)) === listing))).every(Boolean);
  } catch {
    return false;
  }
};

const modKey = (rootOnly: boolean, folder: string): string => `mod|${rootOnly}|${folder}`;

/** An instance's origin files, each answered again while every folder its walk listed still answers the listing it did.
 *  It keeps the walks of the mod folders the latest reading names, so it ends with the instance it describes. */
export function originFilesReader(
  context: Mo2Context,
): (origin: FileOrigin, rootOnly: boolean, modFolders: ModFolders | undefined | 'list') => Promise<OriginFiles> {
  const walked = new Map<string, Walked>();
  let named: ModFolders | undefined;

  const forgetUnnamed = (modFolders: ModFolders): void => {
    if (named === modFolders) return;
    named = modFolders;
    const live = new Set(modFolders.all.flatMap(({ path }) => [modKey(false, path), modKey(true, path)]));
    for (const key of walked.keys()) if (key.startsWith('mod|') && !live.has(key)) walked.delete(key);
  };

  async function walkedOnce(key: string, walk: () => Promise<Walk>, filesOf: (walk: Walk) => OriginFiles): Promise<OriginFiles> {
    const before = walked.get(key);
    if (before !== undefined && await listingsStill(before)) return before.files;
    const done = await walk();
    const files = filesOf(done);
    if (done.stampsCover) walked.set(key, { listings: done.listings, files });
    else walked.delete(key);
    return files;
  }

  return async (origin, rootOnly, modFolders) => {
    if (origin.kind === 'runtimeOutput') {
      const dir = overwriteDir(context.instanceRoot);
      return walkedOnce(`overwrite|${rootOnly}`, () => listOverwrite(dir, rootOnly),
        ({ root, files, folders, notes }) => ({ origin: OVERWRITE_ORIGIN, folder: root, files, folders, notes }));
    }
    if (typeof modFolders === 'object') forgetUnnamed(modFolders);
    const folder = await originFolder(context, origin, modFolders);
    if (folder === undefined) return { origin: origin.name, folder: undefined, files: [], folders: [], notes: [] };
    return walkedOnce(modKey(rootOnly, folder), () => walkMod(folder, rootOnly),
      ({ files, folders, notes }) => ({ origin: origin.name, folder, files, folders, notes }));
  };
}
