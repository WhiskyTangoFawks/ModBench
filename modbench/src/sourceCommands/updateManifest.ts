import { basename, join } from 'node:path';
import { flagVariantsThrough, type MEditClient } from '../client';
import type { InstallationFile, InstanceAdapter, OtherManifest } from '../instanceAdapter/instanceAdapter';
import { exclusionsOfFiles, isUnderAny, ownFilesOf, sourceModsOf, writeManifestIn, type Manifest, type ManifestPackage } from '../manifestAdapter/manifestAdapter';
import { errorMessage } from '../ports/errorMessage';
import type { ItemRefusal } from '../ports/selectionOutcome';
import { heldManifestIn } from './heldManifest';
import { foldersOf, namesOf, type Folders } from './folders';
import { gameFilesOf, gameHeld, gameToHand, type GameToHand } from './gameFolderFacts';
import { flagChangesIn } from './flagChanges';
import { buildManifest, downloadedFileOf, packageHashesOf, downloadedFilesOf, nexusFileOf, pagedFrom, type DownloadedFile, type GameHeld, type HashedModFile } from './manifestBuilder';

type Adapter = Pick<InstanceAdapter,
  'sourceRepositories' | 'entryKey' | 'modOrder' | 'gamePlaces' | 'gameRelease' | 'gameFiles' | 'gameFilesTakenBy' | 'modFolderPath' | 'installationFile'
  | 'downloadedFilesHashed' | 'folderValue' | 'sourceFolderValue' | 'fileStamp' | 'nexusFileAt' | 'pathInFolder' | 'writeSubmodules' | 'writeOtherManifestLines'>;

export interface UpdateManifestDeps {
  readonly adapter: Adapter;
  readonly client: Pick<MEditClient, 'pluginFileFlagVariants'>;
}

/** What update manifest could not read of a mod, which a person or an agent reads by the mod's label. */
export interface ModNote { readonly mod: string; readonly note: string }

interface ModUpdated {
  readonly mod: string;
  readonly manifestWritten: boolean;
  readonly notInPackage: readonly string[];
  readonly otherBytes: readonly string[];
}

/** What update manifest answers. `cancelled`: the signal aborted, so the landed mods are those before it. `manifestWritten`
 *  is false when a manifest already was so; `notInPackage` and `otherBytes` name the files no package holds. */
export interface UpdateManifestResult {
  readonly cancelled?: true;
  readonly landed: readonly ModUpdated[];
  readonly refused: readonly ItemRefusal<string>[];
  readonly notes: readonly ModNote[];
  readonly repositoryNotes: readonly string[];
}

/** Where update manifest is: reading a mod's installation file and game files, hashing downloaded files, or updating a mod. */
export type UpdateManifestStatus =
  | { readonly phase: 'ReadingFiles'; readonly mod: string }
  | { readonly phase: 'Hashing'; readonly left: number }
  | { readonly phase: 'Updating'; readonly mod: string; readonly modsDone: number; readonly modsTotal: number };

interface ModToUpdate {
  readonly name: string;
  readonly folder: string;
  readonly installationFile?: InstallationFile;
  readonly game?: GameHeld;
  readonly isSourceFolder?: true;
}

interface UpdateOptions {
  /** For a mod named here, the own paths whose files alone it records, the manifest's other lines kept as they are. */
  readonly only?: ReadonlyMap<string, readonly string[]>;
  readonly onProgress?: (status: UpdateManifestStatus) => void;
  readonly signal?: AbortSignal;
}

async function readMod(
  adapter: Adapter, mod: string, folders: Folders, game: GameToHand,
): Promise<{ read: ModToUpdate; notes: readonly string[] } | { refusal: string }> {
  const folder = await folders.of(mod);
  if (folder === undefined) return { refusal: 'its name gives it no folder' };
  if (!folders.isMod(mod)) {
    const taken = await gameFilesOf(adapter, { mod, folder }, game, false);
    if ('refusal' in taken) return taken;
    return { read: { name: mod, folder, ...withGame(game, taken.gameFiles) }, notes: taken.notes };
  }
  const installed = await adapter.installationFile(mod);
  const installationFile = installed.kind === 'read' ? installed.answer : undefined;
  const taken = await gameFilesOf(adapter, { mod, folder }, game, installationFile !== undefined);
  if ('refusal' in taken) return taken;
  return {
    read: {
      name: mod, folder, ...withGame(game, taken.gameFiles),
      ...installationFile === undefined ? {} : { installationFile },
    },
    notes: [
      ...taken.notes,
      ...installationFile?.unpagedGame === undefined
        ? []
        : [`its installation file comes from '${installationFile.unpagedGame}', a game whose host the instance adapter has no page on, so its manifest names no host`],
    ],
  };
}

// ADR-0022: a source mod's mod folder is its build's to record, and its source folder is recorded here.
async function readSourceFolder(
  adapter: Adapter, mod: string, folder: string, game: GameToHand,
): Promise<{ read: ModToUpdate; notes: readonly string[] } | { refusal: string }> {
  const taken = await gameFilesOf(adapter, { mod, folder }, { ...game, takes: () => true }, false);
  if ('refusal' in taken) return taken;
  return { read: { name: mod, folder, isSourceFolder: true, ...withGame(game, taken.gameFiles) }, notes: taken.notes };
}

const withGame = (game: GameToHand, held: Parameters<typeof gameHeld>[1]): { game?: GameHeld } => {
  const places = gameHeld(game.folder, held);
  return places === undefined ? {} : { game: places };
};

const takesFromTheGame = (mod: Pick<ModToUpdate, 'game'>): boolean => mod.game?.places.some((place) => place.files.length > 0) === true;

const depotProblemsOf = (game: GameToHand, mods: readonly ModToUpdate[]): readonly string[] =>
  (typeof game.folder === 'string' || !mods.some(takesFromTheGame) ? [] : game.folder.places.flatMap((place) => place.depotProblems));

type Answer = { readonly refusal: string } | { readonly landed: ModUpdated };

const refusal = (why: string): { refusal: string } => ({ refusal: `was not updated: ${why}` });

async function folderMissing(adapter: Adapter, folder: string): Promise<boolean> {
  const stamp = await adapter.fileStamp(folder);
  return stamp.kind === 'unreadable' && stamp.reason.includes('ENOENT');
}

type Hashed = { readonly files: readonly HashedModFile[]; readonly exclude: readonly string[] } | { readonly unreadable: string };

async function hashedFilesOf(
  adapter: Adapter, { folder, isSourceFolder }: Pick<ModToUpdate, 'folder' | 'isSourceFolder'>, ignore: readonly string[],
): Promise<Hashed> {
  const value = await (isSourceFolder ? adapter.sourceFolderValue(folder) : adapter.folderValue(folder));
  const files = ownFilesOf(value, ignore);
  if ('why' in files) return { unreadable: files.why };
  return { files: [...files].map(([path, hash]) => ({ path, hash })), exclude: exclusionsOfFiles(value.exclude, files.keys()) };
}

const packageKey = (pkg: ManifestPackage): string => (pkg.kind === 'installationFile' ? `installationFile:${pkg.name}` : pkg.kind);

// The lines `added` records, laid over those `held` keeps: every held package stays, and `added` brings those it lacks.
function laidOver(held: Manifest | undefined, added: Manifest): Manifest {
  if (held === undefined) return added;
  const heldKeys = new Set(held.packages.map(packageKey));
  return {
    packages: [...held.packages, ...added.packages.filter((pkg) => !heldKeys.has(packageKey(pkg)))],
    exclude: [...new Set([...held.exclude, ...added.exclude])],
    ignore: added.ignore,
    flags: new Map([...[...held.flags].filter(([path]) => !added.files.has(path)), ...added.flags]),
    files: new Map([...held.files, ...added.files]),
  };
}

// mEdit that cannot be reached or read a file leaves the file named as no package's, which it is.
async function flagChangesOf(
  { adapter, client }: UpdateManifestDeps, mod: ModToUpdate, files: readonly HashedModFile[], unheld: readonly string[], packageHashes: ReadonlySet<string>,
  exclude: readonly string[],
): ReturnType<typeof flagChangesIn> {
  try {
    return await flagChangesIn(
      flagVariantsThrough(client, await adapter.gameRelease()), files, unheld, packageHashes, (path) => join(mod.folder, adapter.pathInFolder(path, exclude)));
  } catch {
    return new Map();
  }
}

async function updateMod(
  deps: UpdateManifestDeps, mod: ModToUpdate, downloadedFiles: readonly DownloadedFile[], only?: readonly string[],
): Promise<Answer> {
  const { adapter } = deps;
  const held = await heldManifestIn(mod.folder);
  if (held !== undefined && 'why' in held) return refusal(held.why);
  const holds = (name: string): boolean => name === (mod.installationFile === undefined ? undefined : basename(mod.installationFile.path)) || downloadedFiles.some(({ package: pkg }) => pkg.name === name);
  if (mod.game === undefined && held?.packages.some((pkg) => pkg.kind === 'gameFolder')) {
    return refusal('its manifest names the game folder, and the game folder was not found.');
  }
  const absent = held?.packages.flatMap((pkg) => (pkg.kind === 'installationFile' && !holds(pkg.name) ? [`'${pkg.name}'`] : [])) ?? [];
  if (absent.length > 0) return refusal(`its manifest names ${absent.join(', ')}, and this machine does not hold ${absent.length === 1 ? 'it' : 'them'}.`);
  if (await folderMissing(adapter, mod.folder)) return refusal('its folder does not exist.');

  let hashed: Hashed;
  try {
    hashed = await hashedFilesOf(adapter, mod, held?.ignore ?? []);
  } catch (err) {
    hashed = { unreadable: `a file could not be read: ${errorMessage(err)}` };
  }
  if ('unreadable' in hashed) return refusal(hashed.unreadable);

  const own = mod.installationFile;
  const installationFile = own === undefined ? undefined
    : downloadedFileOf(pagedFrom(own, downloadedFiles.find(({ package: pkg }) => pkg.name === basename(own.path))?.file), nexusFileOf(adapter));
  const files = only === undefined ? hashed.files : hashed.files.filter(({ path }) => isUnderAny(only, path));
  const sources = { downloadedFiles, ...mod.game === undefined ? {} : { game: mod.game }, ...installationFile === undefined ? {} : { installationFile } };
  const exclude = exclusionsOfFiles(hashed.exclude, files.map(({ path }) => path));
  let built = buildManifest(sources, files, exclude, held);
  const flagged = await flagChangesOf(deps, mod, files, [...built.notInPackage, ...built.otherBytes], packageHashesOf(sources), exclude);
  if (flagged.size > 0) built = buildManifest(sources, files.map((file) => flagged.get(file.path) ?? file), exclude, held);
  const recorded = only === undefined ? built : { ...built, manifest: laidOver(held, built.manifest) };
  let written: boolean;
  try {
    written = await writeManifestIn(mod.folder, recorded.manifest);
  } catch (err) {
    return refusal(`its manifest could not be written: ${errorMessage(err)}`);
  }
  return { landed: { mod: mod.name, manifestWritten: written, notInPackage: recorded.notInPackage, otherBytes: recorded.otherBytes } };
}

// modlist-repository.md, The repository, story 2: git cannot let in a file inside a folder its ignore list leaves out.
async function otherManifestLinesWritten(adapter: Adapter): Promise<readonly string[]> {
  try {
    await adapter.writeOtherManifestLines();
    return [];
  } catch (err) {
    return [errorMessage(err)];
  }
}

async function submodulesWritten(
  adapter: Adapter, acted: readonly string[] | 'every', sourceMods: ReadonlyMap<string, string>,
): Promise<{ notes: readonly ModNote[]; repositoryNotes: readonly string[] }> {
  try {
    const { notes, other } = await adapter.writeSubmodules(acted, sourceMods);
    return { notes, repositoryNotes: other };
  } catch (err) {
    return { notes: [], repositoryNotes: [errorMessage(err)] };
  }
}

const cancelledIf = (signal: AbortSignal | undefined): { cancelled?: true } => (signal?.aborted ? { cancelled: true } : {});

/** Each mod's manifest from the mod as it is, and the source folder of each source mod in `sourceModsToRecord`, or every one when
 *  `everyMod`. A source mod's own folder is its build's. */
export async function updateManifest(
  deps: UpdateManifestDeps, mods: readonly string[], { onProgress, signal, only }: UpdateOptions, others: readonly OtherManifest[], everyMod: boolean,
  sourceModsToRecord: readonly string[],
): Promise<UpdateManifestResult> {
  const { adapter } = deps;
  const sourceMods = await sourceModsOf((await adapter.modOrder()).modFolders, await adapter.sourceRepositories(), (name) => adapter.entryKey({ kind: 'mod', name }));
  const game = await gameToHand(adapter, sourceMods);
  const folders = foldersOf(adapter, others);
  const refused: ItemRefusal<string>[] = [];
  const notes: ModNote[] = [];
  const read: ModToUpdate[] = [];
  const passedOver: string[] = [];
  const record = async (mod: string, readOf: () => ReturnType<typeof readMod>): Promise<void> => {
    onProgress?.({ phase: 'ReadingFiles', mod });
    const answer = await readOf();
    if ('refusal' in answer) { refused.push({ item: mod, reason: answer.refusal }); return; }
    read.push(answer.read);
    notes.push(...answer.notes.map((note) => ({ mod, note })));
  };
  for (const mod of new Set(namesOf(mods, others))) {
    if (signal?.aborted) break;
    if (folders.isMod(mod) && sourceMods.folderOf(mod) !== undefined) passedOver.push(mod);
    else await record(mod, () => readMod(adapter, mod, folders, game));
  }
  for (const mod of new Set(everyMod ? sourceMods.folders.keys() : sourceModsToRecord)) {
    if (signal?.aborted) break;
    const folder = sourceMods.folderOf(mod);
    if (folder === undefined) refused.push({ item: mod, reason: 'no source folder builds it' });
    else await record(mod, () => readSourceFolder(adapter, mod, folder, game));
  }
  const nothingUpdated = async (): Promise<UpdateManifestResult> => {
    const cancelled = cancelledIf(signal);
    const submodules = passedOver.length === 0 || cancelled.cancelled ? { notes: [], repositoryNotes: [] } : await submodulesWritten(adapter, passedOver, sourceMods.folders);
    return {
      ...cancelled, landed: [], refused, notes: [...notes, ...submodules.notes],
      repositoryNotes: submodules.repositoryNotes,
    };
  };
  if (signal?.aborted || read.length === 0) return nothingUpdated();

  const downloaded = await adapter.downloadedFilesHashed({ onHashing: (left) => onProgress?.({ phase: 'Hashing', left }), signal });
  if (signal?.aborted) return nothingUpdated();

  const downloadedFiles = downloadedFilesOf(downloaded.files, nexusFileOf(adapter));
  const landed: ModUpdated[] = [];
  const acted = [...passedOver];
  for (const [at, mod] of read.entries()) {
    if (signal?.aborted) break;
    onProgress?.({ phase: 'Updating', mod: mod.name, modsDone: at, modsTotal: read.length });
    const answer = await updateMod(deps, mod, downloadedFiles, only?.get(mod.name));
    if (!mod.isSourceFolder) acted.push(mod.name);
    if ('refusal' in answer) { refused.push({ item: mod.name, reason: answer.refusal }); continue; }
    landed.push(answer.landed);
  }
  const submodules = await submodulesWritten(adapter, everyMod ? 'every' : acted, sourceMods.folders);
  return {
    ...cancelledIf(signal), landed, refused, notes: [...notes, ...submodules.notes],
    repositoryNotes: [
      ...downloaded.notes, ...depotProblemsOf(game, read), ...submodules.repositoryNotes,
      ...await otherManifestLinesWritten(adapter),
    ],
  };
}
