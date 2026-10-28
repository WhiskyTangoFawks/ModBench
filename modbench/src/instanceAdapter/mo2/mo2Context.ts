// What every part of MO2's implementation shares: the instance root, the two resolvers over one
// read of ModOrganizer.ini, the watch, and the reads and name rules more than one part uses.

import { gameReleaseForGame, nexusDomainForMetaGame, nexusDomainsForGame, shortNameForNexusDomain } from '../../tables/gamePaths';
import { readGameName } from './codecs/modOrganizerIni';
import { errorMessage } from '../../ports/errorMessage';
import { entryNamed, modNameKey, OVERWRITE_DIR_NAME, separatorModName } from './codecs/modlistText';
import type { DownloadsDirectoryResolver } from './downloadsDirectory';
import { exists, get, ignoreSkippedLink, listFolders, readOrAbsent, rename, type SkippedLink, type Undo } from '../files';
import type { GameFolderResolver, SteamInstallResolver } from '../gameFolder/gameFolderResolver';
import type { EntryRef, ModFolder, ModFolders, ModlistEntry } from '../instanceAdapter';
import type { FileOrigin } from '../instanceAdapter';
import { entryDir, manifestFileIn, mo2FolderName, modDir, modsDir, overwriteDir, settingsFile } from './layout';
import type { MyGamesResolver } from '../gameFolder/myGames';
import type { Mo2Watch } from './mo2Watch';

export interface Mo2Context {
  readonly instanceRoot: string;
  readonly resolveGameFolder: GameFolderResolver;
  readonly resolveSteamInstall: SteamInstallResolver;
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

const instanceGameName = async ({ instanceRoot }: Mo2Context): Promise<string> => readGameName(await get(settingsFile(instanceRoot)));

/** The Nexus domains to ask about a file of the instance's game, in MO2's order; rejects when Nexus has none for it. */
export async function nexusDomainsOfInstance(context: Mo2Context): Promise<string[]> {
  const gameName = await instanceGameName(context);
  const domains = nexusDomainsForGame(gameName);
  if (domains.length === 0) throw new Error(`Nexus has no game for '${gameName}'`);
  return domains;
}

/** The game a downloaded file's metadata names for Nexus's `domain`: the instance's game when it is on that domain; rejects when no game is. */
export async function metaGameOfDomain(context: Mo2Context, domain: string): Promise<string> {
  const release = gameReleaseForGame(await instanceGameName(context));
  const game = release !== undefined && nexusDomainForMetaGame(release) === domain ? release : shortNameForNexusDomain(domain);
  if (game === undefined) throw new Error(`Modbench has no game for the Nexus game '${domain}'`);
  return game;
}

/** The mod folders as entries; the reserved overwrite name holds none. */
export async function listModFolders(
  { instanceRoot }: Mo2Context, skippedLink: SkippedLink,
): Promise<ModFolder[] | undefined> {
  const names = await readOrAbsent<string[] | undefined>(() => listFolders(modsDir(instanceRoot), skippedLink), undefined);
  return names
    ?.filter((name) => modNameKey(name) !== OVERWRITE_DIR_NAME)
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
  return (await modFoldersAmong(context))?.holding(entry);
}

/** The folder of the mod `name` in its on-disk spelling, found among `folders` or a fresh listing. Where none is there,
 *  the folder the name would give it; `undefined` when the name gives none. */
export async function modFolderNamed(context: Mo2Context, name: string, folders: ModFolders | undefined | 'list'): Promise<string | undefined> {
  const exact = entryDir(context.instanceRoot, { kind: 'mod', name });
  if (exact === undefined) return undefined;
  const listed = folders === 'list' ? await modFoldersAmong(context) : folders;
  return listed?.holding({ kind: 'mod', name })?.path ?? exact;
}

async function modFoldersAmong(context: Mo2Context): Promise<ModFolders | undefined> {
  const all = await listModFolders(context, ignoreSkippedLink);
  return all === undefined ? undefined : modFoldersOf(all);
}

/** The folder an origin's files are in; `undefined` for a mod whose name gives it none. */
export async function originFolder(context: Mo2Context, origin: FileOrigin, folders: ModFolders | undefined | 'list'): Promise<string | undefined> {
  return origin.kind === 'runtimeOutput' ? overwriteDir(context.instanceRoot) : modFolderNamed(context, origin.name, folders);
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
