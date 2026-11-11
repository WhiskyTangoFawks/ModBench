import { basename } from 'node:path';
import type { MEditClient } from '../client';
import type { InstallationFile, InstanceAdapter, OtherManifest } from '../instanceAdapter/instanceAdapter';
import {
  exclusionsOfFiles, flaggedHashesIn, isUnderAny, ownFilesOf, sourceModsOf, writeManifestIn, type FlaggedHashes, type Manifest, type ManifestPackage,
} from '../manifestAdapter/manifestAdapter';
import { errorMessage } from '../ports/errorMessage';
import type { ItemRefusal } from '../ports/selectionOutcome';
import { gestureName, phrase, type Message } from '../ports/phrase';
import { heldManifestIn } from './heldManifest';
import { possibleHashesOf } from './possibleHashes';
import { setAsideHeldWhole } from './setAsideHeldWhole';
import { foldersOf, namesOf, type Folders } from './folders';
import { gameFilesOf, gameHeld, gameToHand, type GameToHand } from './gameFolderFacts';
import { buildManifest, downloadedFileOf, downloadedFilesOf, nexusFileOf, describedBy, type DownloadedFile, type GameHeld, type HashedModFile } from './manifestBuilder';

type Adapter = Pick<InstanceAdapter,
  'sourceModFolders' | 'foldersHeldWhole' | 'entryKey' | 'modOrder' | 'gamePlace' | 'gameRelease' | 'gameFiles' | 'gameFilesTakenBy' | 'modFolderPath' | 'installationFile'
  | 'downloadedFilesHashed' | 'unheldFolderValue' | 'fileStamp' | 'nexusFileAt' | 'writeSubmodules' | 'writeOtherManifestLines'>;

export interface UpdateManifestDeps {
  readonly adapter: Adapter;
  readonly client?: Pick<MEditClient, 'getFlaggedPluginHashes'>;
}

/** What update manifest could not read of a mod, which a person or an agent reads by the mod's label. */
export interface ModNote { readonly mod: string; readonly note: string }

interface ModUpdated {
  readonly mod: string;
  readonly manifestWritten: boolean;
  readonly repositoryWritten: boolean;
  readonly notInPackage: readonly string[];
  readonly otherBytes: readonly string[];
}

/** What update manifest answers. `cancelled`: the signal aborted, so the landed mods are those before it.
 *  `manifestWritten` and `repositoryWritten` are false when the manifest, and the mod's `.gitmodules` entry and ignore lines, already were so. */
export interface UpdateManifestResult {
  readonly cancelled?: true;
  readonly landed: readonly ModUpdated[];
  readonly refused: readonly ItemRefusal<string, Message>[];
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
    notes: taken.notes,
  };
}

// ADR-0022: a source mod's mod folder is its build's to record, and its source folder is recorded here.
async function readSourceFolder(
  adapter: Adapter, mod: string, folder: string, game: GameToHand,
): Promise<{ read: ModToUpdate; notes: readonly string[] } | { refusal: string }> {
  const taken = await gameFilesOf(adapter, { mod, folder }, { ...game, takes: () => true }, false);
  if ('refusal' in taken) return taken;
  return { read: { name: mod, folder, ...withGame(game, taken.gameFiles) }, notes: taken.notes };
}

const withGame = (game: GameToHand, held: Parameters<typeof gameHeld>[1]): { game?: GameHeld } => {
  const heldFromGame = gameHeld(game.folder, held);
  return heldFromGame === undefined ? {} : { game: heldFromGame };
};

const takesFromTheGame = (mod: Pick<ModToUpdate, 'game'>): boolean => (mod.game?.files.length ?? 0) > 0;

const depotProblemsOf = (game: GameToHand, mods: readonly ModToUpdate[]): readonly string[] =>
  (typeof game.folder === 'string' || !mods.some(takesFromTheGame) ? [] : game.folder.place.depotProblems);

type Answer = { readonly refusal: string } | { readonly landed: ModUpdated; readonly notes: readonly string[] };

const refusal = (why: string): { refusal: string } => ({ refusal: `was not updated: ${why}` });

async function folderMissing(adapter: Adapter, folder: string): Promise<boolean> {
  const stamp = await adapter.fileStamp(folder);
  return stamp.kind === 'unreadable' && stamp.reason.includes('ENOENT');
}

type Hashed = { readonly files: readonly HashedModFile[]; readonly exclude: readonly string[]; readonly value: Awaited<ReturnType<Adapter['unheldFolderValue']>> } | { readonly unreadable: string };

async function hashedFilesOf(adapter: Adapter, folder: string, ignore: readonly string[]): Promise<Hashed> {
  const value = await adapter.unheldFolderValue(folder);
  const files = ownFilesOf(value, ignore);
  if ('why' in files) return { unreadable: files.why };
  return { files: [...files].map(([path, hash]) => ({ path, hash })), exclude: exclusionsOfFiles(value.exclude, files.keys()), value };
}

// On a case-blind folder a manifest line names its file in whatever case the disk gives it.
function namedAsOnDisk(held: Manifest | undefined, files: readonly HashedModFile[], ignoresCase: boolean): Manifest | undefined {
  if (held === undefined || !ignoresCase) return held;
  const onDisk = new Map(files.map(({ path }) => [path.toLowerCase(), path]));
  const rekeyed = <V>(lines: ReadonlyMap<string, V>): Map<string, V> => new Map([...lines].map(([path, value]) => [onDisk.get(path.toLowerCase()) ?? path, value]));
  return { ...held, files: rekeyed(held.files), flags: rekeyed(held.flags) };
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

// Restore writes a package's copy and flags it, so a flagged plugin is recorded by the package copy it could have held before its flags.
function packageCopiesOf(
  held: Manifest | undefined, files: readonly HashedModFile[], possible: FlaggedHashes, packageHolds: (hash: string) => boolean,
): { readonly files: HashedModFile[] } | { readonly unknown: readonly string[] } {
  const copies: HashedModFile[] = [];
  const unknown: string[] = [];
  for (const file of files) {
    const before = held?.flags.has(file.path) ? possible.get(file.path) : undefined;
    if (before === undefined) { copies.push(file); continue; }
    const copy = before.find(packageHolds);
    if (copy !== undefined) copies.push({ ...file, hash: copy });
    else if (packageHolds(file.hash)) copies.push(file);
    else unknown.push(file.path);
  }
  return unknown.length === 0 ? { files: copies } : { unknown };
}

const unaccounted = (paths: readonly string[]): string => {
  const named = paths.map((path) => `'${path}'`).join(', ');
  return paths.length === 1
    ? `${named} is flagged, and its bytes are neither a package's copy nor a package's copy with its flags set, and restore replaces it with its package's copy, flagged. Drop its entry from the manifest's flags, or let git hold the file, to keep its bytes.`
    : `${named} are flagged, and their bytes are neither a package's copy nor a package's copy with its flags set, and restore replaces them with their packages' copies, flagged. Drop their entries from the manifest's flags, or let git hold the files, to keep their bytes.`;
};

async function updateMod(
  { adapter, client }: UpdateManifestDeps, mod: ModToUpdate, downloadedFiles: readonly DownloadedFile[], only?: readonly string[],
): Promise<Answer> {
  const heldAsRead = await heldManifestIn(mod.folder);
  if (heldAsRead !== undefined && 'why' in heldAsRead) return refusal(heldAsRead.why);
  let held: Manifest | undefined = heldAsRead;
  const holds = (name: string): boolean => name === (mod.installationFile === undefined ? undefined : basename(mod.installationFile.path)) || downloadedFiles.some(({ package: pkg }) => pkg.name === name);
  if (mod.game === undefined && held?.packages.some((pkg) => pkg.kind === 'gameFolder')) {
    return refusal('its manifest names the game folder, and the game folder was not found.');
  }
  const absent = held?.packages.flatMap((pkg) => (pkg.kind === 'installationFile' && !holds(pkg.name) ? [`'${pkg.name}'`] : [])) ?? [];
  if (absent.length > 0) return refusal(`its manifest names ${absent.join(', ')}, and this machine does not hold ${absent.length === 1 ? 'it' : 'them'}.`);
  if (await folderMissing(adapter, mod.folder)) return refusal('its folder does not exist.');

  let hashed: Hashed;
  try {
    hashed = await hashedFilesOf(adapter, mod.folder, held?.ignore ?? []);
  } catch (err) {
    hashed = { unreadable: `a file could not be read: ${errorMessage(err)}` };
  }
  if ('unreadable' in hashed) return refusal(hashed.unreadable);
  held = namedAsOnDisk(held, hashed.files, hashed.value.ignoresCase);

  const own = mod.installationFile;
  const installationFile = own === undefined ? undefined
    : downloadedFileOf(describedBy(own, downloadedFiles.find(({ package: pkg }) => pkg.name === basename(own.path))?.file), nexusFileOf(adapter));
  const files = only === undefined ? hashed.files : hashed.files.filter(({ path }) => isUnderAny(only, path));
  const packageHolds = (hash: string): boolean => [...downloadedFiles.map(({ file }) => file), ...mod.installationFile === undefined ? [] : [mod.installationFile]]
    .some(({ entries }) => entries.some((entry) => entry.hash === hash)) || (mod.game?.files ?? []).some((one) => one.hash === hash);
  const possible = held === undefined ? new Map<string, readonly string[]>()
    : await flaggedHashesIn(held, hashed.value, mod.folder, client === undefined ? undefined : possibleHashesOf(client, adapter), only);
  if ('cannotTell' in possible) return refusal(`${possible.cannotTell}.`);
  const copies = packageCopiesOf(held, files, possible, packageHolds);
  if ('unknown' in copies) return refusal(unaccounted(copies.unknown));
  const built = buildManifest(
    { downloadedFiles, ...mod.game === undefined ? {} : { game: mod.game }, ...installationFile === undefined ? {} : { installationFile } },
    copies.files, exclusionsOfFiles(hashed.exclude, files.map(({ path }) => path)), held);
  const recorded = only === undefined ? built : { ...built, manifest: laidOver(held, built.manifest) };
  let written: boolean;
  try {
    written = await writeManifestIn(mod.folder, recorded.manifest);
  } catch (err) {
    return refusal(`its manifest could not be written: ${errorMessage(err)}`);
  }
  return { landed: { mod: mod.name, manifestWritten: written, repositoryWritten: false, notInPackage: recorded.notInPackage, otherBytes: recorded.otherBytes }, notes: recorded.notes };
}

// instance-repository.md, The repository, story 2: git cannot let in a file inside a folder its ignore list leaves out.
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
): Promise<{ notes: readonly ModNote[]; repositoryNotes: readonly string[]; written: readonly string[] }> {
  try {
    const { notes, other, written } = await adapter.writeSubmodules(acted, sourceMods);
    return { notes, repositoryNotes: other, written };
  } catch (err) {
    return { notes: [], repositoryNotes: [errorMessage(err)], written: [] };
  }
}

const withRepositoryWritten = (landed: readonly ModUpdated[], written: readonly string[]): ModUpdated[] =>
  landed.map((one) => (written.includes(one.mod) ? { ...one, repositoryWritten: true } : one));

const cancelledIf = (signal: AbortSignal | undefined): { cancelled?: true } => (signal?.aborted ? { cancelled: true } : {});

/** Each mod's manifest from the mod as it is, and the source folder of each source mod in `sourceModsToRecord`, or every one when
 *  `everyMod`. A source mod's own folder is its build's. */
export async function updateManifest(
  deps: UpdateManifestDeps, mods: readonly string[], { onProgress, signal, only }: UpdateOptions, others: readonly OtherManifest[], everyMod: boolean,
  sourceModsToRecord: readonly string[],
): Promise<UpdateManifestResult> {
  const { adapter } = deps;
  const order = await adapter.modOrder();
  const sourceMods = await sourceModsOf(order.modFolders, await adapter.sourceModFolders(), (name) => adapter.entryKey({ kind: 'mod', name }));
  const game = await gameToHand(adapter, sourceMods);
  const folders = foldersOf(adapter, others);
  const refused: ItemRefusal<string, Message>[] = [];
  const notes: ModNote[] = [];
  const read: ModToUpdate[] = [];
  const record = async (mod: string, readOf: () => ReturnType<typeof readMod>): Promise<void> => {
    onProgress?.({ phase: 'ReadingFiles', mod });
    const answer = await readOf();
    if ('refusal' in answer) { refused.push({ item: mod, reason: answer.refusal }); return; }
    read.push(answer.read);
    notes.push(...answer.notes.map((note) => ({ mod, note })));
  };
  const heldWhole = await setAsideHeldWhole(adapter, [...new Set(namesOf(mods, others))], order.modFolders, {
    takes: (mod) => folders.isMod(mod) && sourceMods.folderOf(mod) === undefined, everyMod, reason: refusal('git holds its whole folder.').refusal,
  });
  refused.push(...heldWhole.refused);
  for (const mod of heldWhole.rest) {
    if (signal?.aborted) break;
    const sourceFolder = folders.isMod(mod) ? sourceMods.folderOf(mod) : undefined;
    if (sourceFolder === undefined) await record(mod, () => readMod(adapter, mod, folders, game));
    else if (!everyMod) refused.push({ item: mod, reason: phrase`its build records its folder: run ${gestureName('modbench.mod.build', 'build')} on it, or name its source folder ${sourceFolder}` });
  }
  for (const mod of new Set(everyMod ? sourceMods.folders.keys() : sourceModsToRecord)) {
    if (signal?.aborted) break;
    const folder = sourceMods.folderOf(mod);
    if (folder === undefined) refused.push({ item: mod, reason: 'no source folder builds it' });
    else await record(mod, () => readSourceFolder(adapter, mod, folder, game));
  }
  const nothingUpdated = (): UpdateManifestResult => ({ ...cancelledIf(signal), landed: [], refused, notes, repositoryNotes: [] });
  if (signal?.aborted || read.length === 0) return nothingUpdated();

  const downloaded = await adapter.downloadedFilesHashed({ onHashing: (left) => onProgress?.({ phase: 'Hashing', left }), signal });
  if (signal?.aborted) return nothingUpdated();

  const downloadedFiles = downloadedFilesOf(downloaded.files, nexusFileOf(adapter));
  const landed: ModUpdated[] = [];
  const acted: string[] = [];
  for (const [at, mod] of read.entries()) {
    if (signal?.aborted) break;
    onProgress?.({ phase: 'Updating', mod: mod.name, modsDone: at, modsTotal: read.length });
    const answer = await updateMod(deps, mod, downloadedFiles, only?.get(mod.name));
    acted.push(mod.name);
    if ('refusal' in answer) { refused.push({ item: mod.name, reason: answer.refusal }); continue; }
    landed.push(answer.landed);
    notes.push(...answer.notes.map((note) => ({ mod: mod.name, note })));
  }
  const submodules = await submodulesWritten(adapter, everyMod ? 'every' : acted, sourceMods.folders);
  return {
    ...cancelledIf(signal), landed: withRepositoryWritten(landed, submodules.written), refused, notes: [...notes, ...submodules.notes],
    repositoryNotes: [
      ...downloaded.notes, ...depotProblemsOf(game, read), ...submodules.repositoryNotes,
      ...await otherManifestLinesWritten(adapter),
    ],
  };
}
