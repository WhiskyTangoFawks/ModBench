// An origin's files as MO2 lays them out: a mod folder walked as MO2's VFS walks it, and the
// overwrite folder listed whole. Neither answers the adapter's own writes in flight.

import { join, relative, sep } from 'node:path';
import { errnoCode } from '../ports/errno';
import { errorMessage } from '../ports/errorMessage';
import { MOD_META_FILE_NAME } from './codecs/metaIni';
import { OVERWRITE_DIR_NAME } from './codecs/modlistText';
import { factsOf, listDir } from './files';
import type { FileOrigin, OriginFile, OriginFiles } from './instanceAdapter';
import { entryDir, isTempWrite, overwriteDir } from './layout';

// The mod's metadata is MO2's, not the mod's content: nearly every mod has one.
const EXCLUDED_RELATIVE_PATHS = new Set([MOD_META_FILE_NAME]);

// Matched at the mod root only: Papyrus assets ship nested (`Scripts/Source/...`), so a bare
// name match at any depth would exclude a mod's own scripts.
const ROOT_SOURCE_FOLDER_NAME = 'source';

interface Walk {
  readonly root: string;
  readonly files: OriginFile[];
  readonly notes: string[];
}

const relativeOf = (walk: Walk, path: string): string => relative(walk.root, path).split(sep).join('/');

// `path` keeps the relative key; `sourcePath` is where the file is read from, its link's target.
function keep(walk: Walk, path: string, sourcePath: string = path): void {
  const relativePath = relativeOf(walk, path);
  if (!EXCLUDED_RELATIVE_PATHS.has(relativePath)) walk.files.push({ relativePath, path: sourcePath });
}

// One real path per directory, so a single guard catches a link cycle.
async function descend(walk: Walk, dir: string, ancestors: ReadonlySet<string>): Promise<void> {
  const { realPath } = await factsOf(dir);
  if (ancestors.has(realPath)) {
    walk.notes.push(`link cycle at "${dir}", skipped`);
    return;
  }
  await walkDir(walk, dir, new Set(ancestors).add(realPath));
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
  if (facts.kind === 'directory') await descend(walk, path, ancestors);
  else if (facts.kind === 'file') keep(walk, path, facts.realPath);
  else walk.notes.push(`link "${path}" names no file or folder, skipped`);
}

async function walkDir(walk: Walk, dir: string, ancestors: ReadonlySet<string>): Promise<void> {
  for (const dirent of await listDir(dir)) {
    if (dirent.name.startsWith('.') || isTempWrite(dirent.name)) continue;
    const path = join(dir, dirent.name);
    if (dirent.isDirectory()) {
      if (dir === walk.root && dirent.name.toLowerCase() === ROOT_SOURCE_FOLDER_NAME) continue;
      await descend(walk, path, ancestors);
    } else if (dirent.isFile()) {
      keep(walk, path);
    } else if (dirent.isSymbolicLink()) {
      await walkLink(walk, path, ancestors);
    } else {
      walk.notes.push(`"${path}" is a socket, FIFO or device node, skipped`);
    }
  }
}

async function walkMod(folder: string): Promise<Walk> {
  const walk: Walk = { root: folder, files: [], notes: [] };
  try {
    await walkDir(walk, folder, new Set([(await factsOf(folder)).realPath]));
  } catch (err) {
    if (errnoCode(err) !== 'ENOENT') throw err;
    return { root: folder, files: [], notes: [] };
  }
  return walk;
}

async function listWhole(walk: Walk, dir: string): Promise<void> {
  for (const dirent of await listDir(dir)) {
    if (isTempWrite(dirent.name)) continue;
    const path = join(dir, dirent.name);
    if (dirent.isDirectory()) await listWhole(walk, path);
    else if (dirent.isFile()) keep(walk, path);
  }
}

async function listOverwrite(folder: string): Promise<Walk> {
  const walk: Walk = { root: folder, files: [], notes: [] };
  try {
    await listWhole(walk, folder);
  } catch (err) {
    if (errnoCode(err) !== 'ENOENT') throw err;
    return { root: folder, files: [], notes: [] };
  }
  return walk;
}

export async function originFilesIn(instanceRoot: string, origin: FileOrigin): Promise<OriginFiles> {
  if (origin.kind === 'runtimeOutput') {
    const { root, files, notes } = await listOverwrite(overwriteDir(instanceRoot));
    return { origin: OVERWRITE_DIR_NAME, folder: root, files, notes };
  }
  const folder = entryDir(instanceRoot, { kind: 'mod', name: origin.name });
  if (folder === undefined) return { origin: origin.name, folder: undefined, files: [], notes: [] };
  const { files, notes } = await walkMod(folder);
  return { origin: origin.name, folder, files, notes };
}
