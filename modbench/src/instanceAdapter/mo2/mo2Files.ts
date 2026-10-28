// An origin's files as MO2 lays them out: a mod folder walked as MO2's VFS walks it, and the
// overwrite folder listed whole. Neither answers the adapter's own writes in flight.

import { basename, sep } from 'node:path';
import { errnoCode } from '../../ports/errno';
import { errorMessage } from '../../ports/errorMessage';
import { MOD_META_FILE_NAME } from './codecs/metaIni';
import { OVERWRITE_ORIGIN } from '../../wire/pluginAddress';
import { factsOf, listDir, isOwnTemp } from '../files';
import type { FileOrigin, ModFolders, OriginFile, OriginFiles, OriginFolder } from '../instanceAdapter';
import { includedPathOf, isExcludedName, manifestFileName, overwriteDir } from './layout';
import { originFolder, type Mo2Context } from './mo2Context';

// The mod's metadata is MO2's and its manifest is Modbench's: neither is the mod's content.
const NOT_CONTENT: ReadonlySet<string> = new Set([MOD_META_FILE_NAME]);

interface Walk {
  readonly root: string;
  readonly notContent: ReadonlySet<string>;
  /** Lists the origin's root alone, never a folder below it. */
  readonly rootOnly: boolean;
  readonly files: OriginFile[];
  readonly folders: OriginFolder[];
  readonly notes: string[];
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
  if (walk.notContent.has(relativePath)) return;
  walk.files.push(originFileOf(relativePath, path, sourcePath));
}

const keepFolder = (walk: Walk, path: string): void => {
  const relativePath = relativeUnder(walk.root, path);
  walk.folders.push({ relativePath, path, excluded: isExcluded(relativePath) });
};

// Another tool can remove a subfolder mid-walk: that skips it alone, noted. The root's absence is
// its caller's to answer.
async function inSubfolder(walk: Walk, dir: string, visit: () => Promise<void>): Promise<void> {
  try {
    await visit();
  } catch (err) {
    if (errnoCode(err) !== 'ENOENT') throw err;
    walk.notes.push(`"${dir}" was removed mid-read, skipped`);
  }
}

// One real path per directory, so a single guard catches a link cycle.
async function descend(walk: Walk, dir: string, ancestors: ReadonlySet<string>): Promise<void> {
  await inSubfolder(walk, dir, async () => {
    const { realPath } = await factsOf(dir);
    if (ancestors.has(realPath)) {
      walk.notes.push(`link cycle at "${dir}", skipped`);
      return;
    }
    keepFolder(walk, dir);
    await walkDir(walk, dir, new Set(ancestors).add(realPath));
  });
}

// A link is followed as MO2 follows it; a broken one is skipped and noted, and any other failure
// rejects rather than reading as nothing there.
async function walkLink(walk: Walk, path: string, ancestors: ReadonlySet<string>): Promise<void> {
  let facts;
  try {
    facts = await factsOf(path);
  } catch (err) {
    if (errnoCode(err) !== 'ENOENT') throw err;
    walk.notes.push(`broken link "${path}", skipped (${errorMessage(err)})`);
    return;
  }
  if (facts.kind === 'directory') {
    if (!walk.rootOnly) await descend(walk, path, ancestors);
  }
  else if (facts.kind === 'file') keep(walk, path, facts.realPath);
  else walk.notes.push(`link "${path}" names no file or folder, skipped`);
}

async function walkDir(walk: Walk, dir: string, ancestors: ReadonlySet<string>): Promise<void> {
  for (const dirent of await listDir(dir)) {
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

async function walkMod(folder: string, modName: string, rootOnly: boolean): Promise<Walk> {
  const walk: Walk = { root: folder, notContent: new Set([...NOT_CONTENT, manifestFileName(modName)]), rootOnly, files: [], folders: [], notes: [] };
  try {
    await walkDir(walk, folder, new Set([(await factsOf(folder)).realPath]));
  } catch (err) {
    if (errnoCode(err) !== 'ENOENT') throw err;
    return { ...walk, files: [], folders: [], notes: [] };
  }
  return walk;
}

async function listWhole(walk: Walk, dir: string): Promise<void> {
  for (const dirent of await listDir(dir)) {
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
  const walk: Walk = { root: folder, notContent: NOT_CONTENT, rootOnly, files: [], folders: [], notes: [] };
  try {
    await listWhole(walk, folder);
  } catch (err) {
    if (errnoCode(err) !== 'ENOENT') throw err;
    return { ...walk, files: [], folders: [], notes: [] };
  }
  return walk;
}

/** The files below `folder` as a mod's are listed, its manifest, named for the folder it builds, not among them. */
export async function filesBelow(folder: string): Promise<{ files: OriginFile[]; notes: string[] }> {
  const { files, notes } = await walkMod(folder, basename(folder), false);
  return { files, notes };
}

export async function originFilesIn(context: Mo2Context, origin: FileOrigin, rootOnly: boolean, modFolders: ModFolders | undefined | 'list'): Promise<OriginFiles> {
  if (origin.kind === 'runtimeOutput') {
    const { root, files, folders, notes } = await listOverwrite(overwriteDir(context.instanceRoot), rootOnly);
    return { origin: OVERWRITE_ORIGIN, folder: root, files, folders, notes };
  }
  const folder = await originFolder(context, origin, modFolders);
  if (folder === undefined) return { origin: origin.name, folder: undefined, files: [], folders: [], notes: [] };
  const { files, folders, notes } = await walkMod(folder, origin.name, rootOnly);
  return { origin: origin.name, folder, files, folders, notes };
}
