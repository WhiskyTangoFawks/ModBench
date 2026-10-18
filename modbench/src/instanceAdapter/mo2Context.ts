// What every part of MO2's implementation shares: the instance root, the two resolvers over one
// read of ModOrganizer.ini, the watch, and the reads and name rules more than one part uses.

import { errorMessage } from '../ports/errorMessage';
import { entryNamed, modNameKey, OVERWRITE_DIR_NAME, separatorModName } from './codecs/modlistText';
import type { DownloadsDirectoryResolver } from './downloadsDirectory';
import { exists, get, ignoreSkippedLink, listDir, listFolders, readOrAbsent, rename, type SkippedLink, type Undo } from './files';
import type { GameFolderResolver } from './gameFolder/gameFolderResolver';
import type { EntryRef, ModFolder, ModFolders, ModlistEntry } from './instanceAdapter';
import type { FileOrigin } from './instanceAdapter';
import { entryDir, isNewModExtraction, manifestFileIn, mo2FolderName, modDir, modsDir, overwriteDir, settingsFile } from './layout';
import type { MyGamesResolver } from './gameFolder/myGames';
import type { Mo2Watch } from './mo2Watch';

export interface Mo2Context {
  readonly instanceRoot: string;
  readonly resolveGameFolder: GameFolderResolver;
  readonly resolveDownloadsFolder: DownloadsDirectoryResolver;
  readonly resolveMyGames: MyGamesResolver;
  readonly watch: Mo2Watch;
  readonly mo2Running: () => Promise<boolean>;
}

/** How MO2 matches an entry: by the name of its folder, without case, a separator's folder named
 *  as MO2 names it. A mod named as a separator's folder is that separator. */
export const entryKey = (entry: EntryRef): string =>
  modNameKey(entry.kind === 'separator' ? separatorModName(mo2FolderName(entry.name)) : entry.name);

/** The entry of `entry`'s kind `order` lists, matched as MO2 matches names. */
export const listedAs = (order: readonly ModlistEntry[], entry: EntryRef): ModlistEntry | undefined =>
  order.find((e) => e.kind === entry.kind && entryKey(e) === entryKey(entry));

// A new mod's folder holds its extraction until the install settles; a folder removed since the
// listing is gone, and any other failure to read it surfaces.
async function isBeingInstalled(folder: string): Promise<boolean> {
  const entries = await readOrAbsent(() => listDir(folder), undefined);
  return entries === undefined || entries.some((entry) => isNewModExtraction(entry.name));
}

/** The mod folders as entries; the reserved overwrite name holds none, nor does a folder a new
 *  mod is being installed into or one removed mid-listing. */
export async function listModFolders(
  { instanceRoot }: Mo2Context, skippedLink: SkippedLink,
): Promise<ModFolder[] | undefined> {
  const names = await readOrAbsent<string[] | undefined>(() => listFolders(modsDir(instanceRoot), skippedLink), undefined);
  const candidates = names?.filter((name) => modNameKey(name) !== OVERWRITE_DIR_NAME);
  const installing = await Promise.all(candidates?.map((name) => isBeingInstalled(modDir(instanceRoot, name))) ?? []);
  return candidates
    ?.filter((_, i) => !installing[i])
    .map((name) => ({ ...entryNamed(name), path: modDir(instanceRoot, name), modName: name }));
}

export function modFoldersOf(all: readonly ModFolder[]): ModFolders {
  const byKey = new Map(all.map((folder) => [entryKey(folder), folder]));
  return { all, holding: (entry) => all.find((folder) => folder.kind === entry.kind && folder.name === entry.name) ?? byKey.get(entryKey(entry)) };
}

/** The downloads folder as the settings name it now; rejects with why when it cannot be resolved. */
export async function currentDownloadsDir({ instanceRoot, resolveDownloadsFolder }: Mo2Context): Promise<string> {
  const resolution = await resolveDownloadsFolder(instanceRoot, await get(settingsFile(instanceRoot)));
  if (resolution.kind === 'unresolved') throw new Error(resolution.reason);
  return resolution.downloadsDir;
}

/** The folder a new mod of this name takes; rejects a name that gives it none. */
export function newModFolder({ instanceRoot }: Mo2Context, mod: string): string {
  const folder = entryDir(instanceRoot, { kind: 'mod', name: mod });
  if (folder === undefined) throw new Error(`Not a valid mod name: "${mod}"`);
  return folder;
}

/** The folder that holds `entry`, matched as MO2 matches names. */
export async function folderHolding(context: Mo2Context, entry: EntryRef): Promise<ModFolder | undefined> {
  const all = await listModFolders(context, ignoreSkippedLink);
  return all === undefined ? undefined : modFoldersOf(all).holding(entry);
}

/** The folder of the mod `name`, found as MO2 finds it, without case; a folder of exactly that name wins. Where no folder
 *  is there, the folder the name would give it; `undefined` when the name gives none. */
export async function modFolderNamed({ instanceRoot }: Mo2Context, name: string): Promise<string | undefined> {
  const exact = entryDir(instanceRoot, { kind: 'mod', name });
  if (exact === undefined || await exists(exact)) return exact;
  const key = entryKey({ kind: 'mod', name });
  const folders = await readOrAbsent(() => listFolders(modsDir(instanceRoot), ignoreSkippedLink), []);
  const found = folders.find((folder) => entryKey({ kind: 'mod', name: folder }) === key);
  return found === undefined ? exact : modDir(instanceRoot, found);
}

/** The folder an origin's files are in; `undefined` for a mod whose name gives it none. */
export async function originFolder(context: Mo2Context, origin: FileOrigin): Promise<string | undefined> {
  return origin.kind === 'runtimeOutput' ? overwriteDir(context.instanceRoot) : modFolderNamed(context, origin.name);
}

/** A folder already there, listed or not, is never replaced or adopted: the change is refused
 *  before anything moves. */
export async function refuseFolderTaken(context: Mo2Context, entry: EntryRef, folder: string): Promise<void> {
  const inTheWay = (await folderHolding(context, entry))?.path ?? ((await exists(folder)) ? folder : undefined);
  if (inTheWay !== undefined) throw new Error(`The folder "${inTheWay}" is in the way`);
}

/** Renames a mod folder with its manifest, which is named for the mod, so no rename lands in part: a manifest that cannot
 *  be renamed puts the folder back and rejects. Answers how to put both back. */
export async function renameFolderWithManifest(from: ModFolder, toPath: string, toModName: string): Promise<Undo> {
  await rename(from.path, toPath);
  const undoFolder: Undo = () => rename(toPath, from.path);
  const old = manifestFileIn(toPath, from.modName);
  const renamed = manifestFileIn(toPath, toModName);
  if (old === renamed || !(await exists(old))) return undoFolder;
  try {
    await rename(old, renamed);
  } catch (err) {
    try {
      await undoFolder();
    } catch (undoErr) {
      throw new Error(`${errorMessage(err)}; the folder now sits at ${toPath} because putting it back failed: ${errorMessage(undoErr)}`);
    }
    throw err;
  }
  return async () => { await rename(renamed, old); await undoFolder(); };
}
