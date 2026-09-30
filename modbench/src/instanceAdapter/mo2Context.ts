// What every part of MO2's implementation shares: the instance root, the two resolvers over one
// read of ModOrganizer.ini, the watch, and the reads and name rules more than one part uses.

import { errnoCode } from '../ports/errno';
import { entryNamed, modNameKey, OVERWRITE_DIR_NAME, separatorModName } from './codecs/modlistText';
import type { DownloadsDirectoryResolver } from './downloadsDirectory';
import { get, listFolders } from './files';
import type { GameDirectoryResolver } from './gameDirectory';
import type { EntryRef, ModFolder, ModFolders } from './instanceAdapter';
import { entryDir, mo2FolderName, modDir, modsDir, settingsFile } from './layout';
import type { Mo2Watch } from './mo2Watch';

export interface Mo2Context {
  readonly instanceRoot: string;
  readonly resolveGameFolder: GameDirectoryResolver;
  readonly resolveDownloadsFolder: DownloadsDirectoryResolver;
  readonly watch: Mo2Watch;
}

/** A missing file answers `absent`; any other failure rejects. */
export async function readOrAbsent<T>(read: () => Promise<T>, absent: T): Promise<T> {
  try {
    return await read();
  } catch (err) {
    if (errnoCode(err) !== 'ENOENT') throw err;
    return absent;
  }
}

/** How MO2 matches an entry: by the name of its folder, without case, a separator's folder named
 *  as MO2 names it. A mod named as a separator's folder is that separator. */
export const entryKey = (entry: EntryRef): string =>
  modNameKey(entry.kind === 'separator' ? separatorModName(mo2FolderName(entry.name)) : entry.name);

/** The mod folders as entries; the reserved overwrite name holds none. */
export async function listModFolders(
  { instanceRoot }: Mo2Context, skippedLink?: (name: string, reason: string) => void,
): Promise<ModFolder[] | undefined> {
  const names = await readOrAbsent<string[] | undefined>(() => listFolders(modsDir(instanceRoot), skippedLink), undefined);
  return names
    ?.filter((name) => modNameKey(name) !== OVERWRITE_DIR_NAME)
    .map((name) => ({ ...entryNamed(name), path: modDir(instanceRoot, name) }));
}

export function modFoldersOf(all: readonly ModFolder[]): ModFolders {
  const byKey = new Map(all.map((folder) => [entryKey(folder), folder]));
  return { all, holding: (entry) => byKey.get(entryKey(entry)) };
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
  const all = await listModFolders(context);
  return all === undefined ? undefined : modFoldersOf(all).holding(entry);
}
