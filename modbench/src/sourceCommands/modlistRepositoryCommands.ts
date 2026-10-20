import {
  isRefused, type RestoreFacts, type UpdateManifestFacts, type RestoreMod, type RestoreOutcome, type MEditClient, type ModlistProgress, type ModRestoreDestroys, type NotFound,
  type ModByFolder, type ModStatus, type UpdateManifestMod, type UpdateManifestOutcome, type ModlistCallOptions,
} from '../client';
import type { CommandResult } from '../coreLib/commandResult';
import type { FileRead, GameFile, InstallationFile, InstanceAdapter, ModMetadata, SourceMods } from '../instanceAdapter/instanceAdapter';
import { errorMessage } from '../ports/errorMessage';
import { refuse } from '../coreLib/refuse';
import type { ItemRefusal } from '../ports/selectionOutcome';
import type { MoveToTrash } from '../ports/trash';
import { modWithMetadata, withMetadataRead } from '../wire/modByFolder';
import { failureReason, isReadFailed, type ReadFailed } from '../wire/readFailed';
import { archiveVariants, metadataUnreadable } from './sourceCommands';

type Adapter = Pick<InstanceAdapter,
  'gameFolder' | 'gameRelease' | 'modOrder' | 'sourceMods' | 'installationFile' | 'downloadedFile' | 'gameFiles' | 'gameFilesTakenBy' | 'modMetadata' | 'unwritableMetadata' | 'writeModMetadata' | 'metadataFilesInModFolder' | 'modFolderPath' | 'writeIgnoreList' | 'removeIgnoreList' | 'writeSubmodules' | 'refuseUnpublishedPins' | 'checkPushRefusalFree' | 'removeRepository' | 'repositoryOnDisk'
  | 'statCacheFolder' | 'trashModFile' | 'excludedSuffix' | 'submodule'>;

interface ModlistRepositoryCommandsDeps {
  client: Pick<MEditClient, 'updateManifest' | 'restoreFromManifest' | 'getWhatRestoreDestroys' | 'getModStatus'>;
  adapter: Adapter;
  instanceRoot: string;
  /** VS Code's git makes the instance folder a repository. */
  makeRepository: () => Promise<void>;
  trash: MoveToTrash;
}

/** What update manifest could not read of a mod, which a person or an agent reads by the mod's label. */
export interface ModNote { readonly mod: string; readonly note: string }

/** What update manifest answers: each mod updated or refused, and each entry a mod folder's listing skipped, or the
 *  whole gesture refused, as a message to show. */
export type UpdateManifestResult = ({ applied: true; notes: readonly ModNote[]; submoduleNotes: readonly string[] } & UpdateManifestOutcome) | { applied: false; refusal: string };

/** Where update manifest is: the Instance adapter reading a mod's files, or mEdit updating manifests. */
export type UpdateManifestStatus = { readonly phase: 'ReadingFiles'; readonly mod: string } | ({ readonly phase: 'Updating' } & ModlistProgress);

/** pushRefusalNotWritten: why the instance repository does not refuse a push of a pin its source mod's remote lacks. */
export type RestoreResult =
  | ({ applied: true; pushRefusalNotWritten?: string } & Omit<RestoreOutcome, 'notFound'>)
  | { applied: false; refusal: string; unfinished: readonly string[] };

/** What restore from manifest would destroy, each mod with a file it would replace or trash and each mod it skipped, or why
 *  mEdit could not say. */
export type WhatRestoreDestroys = { destroys: readonly ModRestoreDestroys[]; refused: readonly ItemRefusal<string>[] } | { refusal: string };

export type RestoreStatus = { readonly phase: 'ReadingFiles'; readonly mod: string } | ({ readonly phase: 'Restoring' } & ModlistProgress);

type ReadMod = Omit<UpdateManifestMod, 'isSourceMod' | 'version'>;

type InstallationFileOf = (mod: string) => Promise<FileRead<InstallationFile | undefined>>;

// The game folder found, named by the game's release.
interface NamedGameFolder {
  readonly name: string;
  readonly dataFolder: string;
}

interface GameToHand {
  readonly takes: (mod: string) => boolean;
  readonly folder: NamedGameFolder | string;
}

// The game folder found, named by the game's release, or why a manifest cannot name it.
async function namedGameFolder(adapter: Adapter, gameRelease: string): Promise<NamedGameFolder | string> {
  const gameFolder = await adapter.gameFolder();
  return gameFolder.kind === 'found' ? { name: gameRelease, dataFolder: gameFolder.dataFolder } : 'the game folder was not found';
}

async function gameToHand(adapter: Adapter, sourceMods: SourceMods): Promise<GameToHand> {
  const [{ modFolders }, folder] = await Promise.all([adapter.modOrder(), namedGameFolder(adapter, await adapter.gameRelease())]);
  return { folder, takes: (mod) => sourceMods.folderOf(mod) === undefined && modFolders?.find((entry) => entry.modName === mod)?.kind !== 'separator' };
}

const wireGameFolder = (folder: NamedGameFolder | string, files: readonly GameFile[]): UpdateManifestFacts['gameFolder'] =>
  typeof folder === 'string' ? undefined : { ...folder, files: [...files] };

interface ReadMods {
  readonly sent: readonly ReadMod[];
  readonly gameFiles: readonly GameFile[];
  readonly refused: readonly ItemRefusal<string>[];
  readonly notes: readonly ModNote[];
}

async function byFolder(adapter: Adapter, mods: readonly string[]): Promise<ModByFolder[]> {
  const asked: ModByFolder[] = [];
  for (const mod of mods) {
    const folder = await adapter.modFolderPath(mod);
    if (folder !== undefined) asked.push({ name: mod, folder, metadataFiles: [...adapter.metadataFilesInModFolder] });
  }
  return asked;
}

const wireFile = ({ path, page, size, hash, entries }: InstallationFile): NonNullable<UpdateManifestMod['installationFile']> =>
  ({ path, page, size, hash, entries: [...entries] });

async function gameFilesOf(
  adapter: Adapter, mod: string, game: GameToHand | undefined,
): Promise<{ gameFiles: readonly GameFile[]; notes: readonly string[] } | { refusal: string }> {
  if (game === undefined || !game.takes(mod)) return { gameFiles: [], notes: [] };
  if (typeof game.folder === 'string') return { gameFiles: [], notes: [`${game.folder}, so its manifest cannot name the game folder as its package`] };
  const taken = await adapter.gameFilesTakenBy(game.folder.dataFolder, mod);
  return taken.kind === 'unreadable' ? { refusal: taken.reason } : { gameFiles: taken.answer.gameFiles, notes: taken.answer.notes };
}

async function readMod(
  adapter: Adapter, mod: string, installationFileOf: InstallationFileOf, game: GameToHand | undefined,
): Promise<{ read: ReadMod; gameFiles: readonly GameFile[]; notes: readonly string[] } | { refusal: string }> {
  const folder = await adapter.modFolderPath(mod);
  if (folder === undefined) return { refusal: 'its name gives it no folder' };
  const installed = await installationFileOf(mod);
  if (installed.kind === 'unreadable') return { refusal: installed.reason };
  const taken = installed.answer === undefined ? await gameFilesOf(adapter, mod, game) : { gameFiles: [], notes: [] };
  if ('refusal' in taken) return taken;
  return {
    read: { name: mod, folder, installationFile: installed.answer === undefined ? undefined : wireFile(installed.answer), metadataFiles: [...adapter.metadataFilesInModFolder] },
    gameFiles: taken.gameFiles,
    notes: [
      ...taken.notes,
      ...(installed.answer?.unpagedGame === undefined
        ? []
        : [`its installation file comes from '${installed.answer.unpagedGame}', a game whose host the instance adapter has no page on, so its manifest names no page`]),
    ],
  };
}

async function readMods(
  adapter: Adapter, mods: readonly string[], installationFileOf: InstallationFileOf, game: GameToHand | undefined,
  { onProgress, signal }: ModlistCallOptions<{ phase: 'ReadingFiles'; mod: string }>,
): Promise<ReadMods> {
  const sent: ReadMod[] = [];
  const gameFiles = new Map<string, GameFile>();
  const refused: ItemRefusal<string>[] = [];
  const notes: ModNote[] = [];
  for (const mod of mods) {
    if (signal?.aborted) break;
    onProgress?.({ phase: 'ReadingFiles', mod });
    const read = await readMod(adapter, mod, installationFileOf, game);
    if ('refusal' in read) { refused.push({ item: mod, reason: read.refusal }); continue; }
    sent.push(read.read);
    for (const file of read.gameFiles) gameFiles.set(file.path.toLowerCase(), file);
    notes.push(...read.notes.map((note) => ({ mod, note })));
  }
  return { sent: signal?.aborted ? [] : sent, gameFiles: [...gameFiles.values()], refused, notes };
}

// modlist-repository.md, Restore from manifest, story 8: the manifest names them, and only mEdit reads it.
const noneBeforeTheManifestNamesThem: InstallationFileOf = () => Promise.resolve({ kind: 'read', answer: undefined });

// A call that fails part way answers no mod, so none had its files no line names trashed: each is not finished.
async function restoreOnce(
  client: ModlistRepositoryCommandsDeps['client'], mods: readonly RestoreMod[], facts: RestoreFacts, options: ModlistCallOptions,
): Promise<({ applied: true } & RestoreOutcome) | Extract<RestoreResult, { applied: false }>> {
  const outcome = await client.restoreFromManifest(mods, facts, options);
  return isRefused(outcome) ? { applied: false, refusal: outcome.message, unfinished: mods.map((mod) => mod.name) } : { applied: true, ...outcome };
}

const sentence = (reason: string): string => ` ${reason.charAt(0).toUpperCase()}${reason.slice(1)}.`;

async function namedGameFiles(
  adapter: Adapter, folder: NamedGameFolder | string, notFound: readonly NotFound[],
): Promise<{ found: readonly GameFile[]; unread: string }> {
  const paths = [...new Set(notFound.flatMap(({ gameFiles }) => gameFiles))];
  if (paths.length === 0) return { found: [], unread: '' };
  if (typeof folder === 'string') return { found: [], unread: sentence(folder) };
  const found = await adapter.gameFiles(folder.dataFolder, paths);
  return found.kind === 'read' ? { found: found.answer, unread: '' } : { found: [], unread: ` The game files could not be read: ${found.reason}.` };
}

async function namedDownloadedFiles(adapter: Adapter, notFound: readonly NotFound[]): Promise<{
  handed: (name: string | undefined) => RestoreMod['installationFile'];
  unread: (name: string | undefined) => string;
}> {
  const read = new Map<string, FileRead<InstallationFile | undefined>>();
  for (const name of new Set(notFound.flatMap(({ installationFile }) => installationFile === undefined ? [] : [installationFile]))) {
    read.set(name, await adapter.downloadedFile(name));
  }
  return {
    handed: (name) => {
      const file = name === undefined ? undefined : read.get(name);
      return file?.kind === 'read' && file.answer !== undefined ? wireFile(file.answer) : undefined;
    },
    unread: (name) => {
      const file = name === undefined ? undefined : read.get(name);
      return file?.kind === 'unreadable' ? ` '${name}' could not be read: ${file.reason}.` : '';
    },
  };
}

// modlist-repository.md, Restore from manifest, story 3: git checks each submodule out at the commit the repository pins.
async function namedSubmodules(adapter: Adapter, notFound: readonly NotFound[]): Promise<{
  handed: (name: string | undefined) => RestoreMod['submodule'];
  unread: (name: string | undefined) => string;
}> {
  const read = new Map<string, Awaited<ReturnType<Adapter['submodule']>>>();
  for (const name of new Set(notFound.flatMap(({ submodule }) => submodule === undefined ? [] : [submodule]))) {
    read.set(name, await adapter.submodule(name));
  }
  return {
    handed: (name) => {
      const found = name === undefined ? undefined : read.get(name);
      return found === undefined || 'lacks' in found ? undefined : { ...found };
    },
    unread: (name) => {
      const found = name === undefined ? undefined : read.get(name);
      return found !== undefined && 'lacks' in found ? sentence(found.lacks) : '';
    },
  };
}

function cancelRefused(...latestFirst: (string | undefined)[]): { cancelRefusal?: string } {
  const [cancelRefusal] = latestFirst.filter((refusal) => refusal !== undefined);
  return cancelRefusal === undefined ? {} : { cancelRefusal };
}

type Restored = Extract<RestoreResult, { applied: true }>['landed'];

type FoldersNotFinished = Extract<RestoreResult, { applied: false }> & { readonly landed: Restored };

async function restoreFromManifest(
  deps: ModlistRepositoryCommandsDeps, mods: readonly string[], options: ModlistCallOptions<RestoreStatus>,
): Promise<RestoreResult> {
  const restored = await restoreFolders(deps, mods, options);
  const { finished, unfinished } = await withFilesNoLineNamesTrashed(deps, restored.landed);
  if (restored.applied) {
    const refused = [...restored.refused, ...unfinished];
    const pushRefusalNotWritten = await pushRefusalWrittenOrWhy(deps.adapter);
    return {
      ...restored, landed: finished, refused: options.signal?.aborted ? [...refused, ...cancelledBefore(mods, restored)] : refused,
      ...(pushRefusalNotWritten === undefined ? {} : { pushRefusalNotWritten }),
    };
  }
  return { applied: false, refusal: restored.refusal, unfinished: [...restored.unfinished, ...unfinished.map(({ item }) => item)] };
}

// modlist-repository.md, The repository, story 6: a hook does not travel with a clone, so restore writes it as git init does.
async function pushRefusalWrittenOrWhy(adapter: Adapter): Promise<string | undefined> {
  try {
    if (await adapter.repositoryOnDisk()) await adapter.refuseUnpublishedPins();
  } catch (err) {
    return errorMessage(err);
  }
  return undefined;
}

// modlist-repository.md, Restore from manifest, story 6: an interrupted restore names each mod it did not finish.
function cancelledBefore(mods: readonly string[], { landed, refused }: Extract<RestoreResult, { applied: true }>): ItemRefusal<string>[] {
  const answered = new Set([...landed.map(({ mod }) => mod), ...refused.map(({ item }) => item)]);
  return mods.filter((mod) => !answered.has(mod))
    .map((mod) => ({ item: mod, reason: 'was not finished: the restore was cancelled. Restoring it again finishes it.' }));
}

async function withFilesNoLineNamesTrashed(
  { adapter, trash }: ModlistRepositoryCommandsDeps, landed: Restored,
): Promise<{ finished: Restored; unfinished: readonly ItemRefusal<string>[] }> {
  const finished: Restored[number][] = [];
  const unfinished: ItemRefusal<string>[] = [];
  for (const mod of landed) {
    const why = await trashedOrWhy(adapter, trash, mod.mod, mod.namedByNoLine) ?? await metadataWrittenOrWhy(adapter, mod.mod, mod.metadata);
    if (why === undefined) finished.push(mod);
    else unfinished.push({ item: mod.mod, reason: `was not finished: ${why}. Restoring it again finishes it.` });
  }
  return { finished, unfinished };
}

const heldByAdapter = ({ version, installationFile }: Restored[number]['metadata']): ModMetadata =>
  ({ version: version ?? undefined, installationFile: installationFile ? { name: installationFile.name, page: installationFile.page ?? undefined } : undefined });

async function metadataWrittenOrWhy(adapter: Adapter, mod: string, metadata: Restored[number]['metadata']): Promise<string | undefined> {
  try {
    await adapter.writeModMetadata(mod, heldByAdapter(metadata));
  } catch (err) {
    return `its metadata could not be written: ${errorMessage(err)}`;
  }
  return undefined;
}

async function trashedOrWhy(adapter: Adapter, trash: MoveToTrash, mod: string, paths: readonly string[]): Promise<string | undefined> {
  for (const path of paths) {
    try {
      await adapter.trashModFile(mod, path, trash);
    } catch (err) {
      return `'${path}' could not be moved to the trash: ${errorMessage(err)}`;
    }
  }
  return undefined;
}

async function restoreFolders(
  { client, adapter }: ModlistRepositoryCommandsDeps, mods: readonly string[],
  { onProgress, signal }: ModlistCallOptions<RestoreStatus>,
): Promise<Extract<RestoreResult, { applied: true }> | FoldersNotFinished> {
  const gameRelease = await adapter.gameRelease();
  const folder = await namedGameFolder(adapter, gameRelease);
  const read = await readMods(adapter, mods, noneBeforeTheManifestNamesThem, undefined, { onProgress, signal });
  if (read.sent.length === 0) return { applied: true, landed: [], refused: read.refused };
  const sent: readonly RestoreMod[] = read.sent;
  const facts: RestoreFacts = {
    statCache: adapter.statCacheFolder, excludedSuffix: adapter.excludedSuffix, archives: archiveVariants(gameRelease), gameFolder: wireGameFolder(folder, []),
  };
  const restoring = { onProgress: (progress: ModlistProgress): void => { onProgress?.({ phase: 'Restoring', ...progress }); }, signal };
  const first = await restoreOnce(client, sent, facts, restoring);
  if (!first.applied) return { ...first, landed: [] };
  const { cancelRefusal } = first;
  const retried = new Map(first.notFound.map((notFound) => [notFound.mod, notFound]));
  const firstRefused = first.refused.filter((refused) => !retried.has(refused.item));
  if (retried.size === 0 || signal?.aborted) {
    return { applied: true, landed: first.landed, refused: [...firstRefused, ...read.refused], ...cancelRefused(cancelRefusal) };
  }

  const named = await namedGameFiles(adapter, folder, first.notFound);
  const downloaded = await namedDownloadedFiles(adapter, first.notFound);
  const submodules = await namedSubmodules(adapter, first.notFound);
  const again = sent.flatMap((mod) => {
    const notFound = retried.get(mod.name);
    return notFound === undefined
      ? [] : [{ ...mod, installationFile: downloaded.handed(notFound.installationFile), submodule: submodules.handed(notFound.submodule) }];
  });
  const second = await restoreOnce(client, again, { ...facts, gameFolder: wireGameFolder(folder, named.found) }, restoring);
  if (!second.applied) return { ...second, landed: first.landed };
  const unreadFor = new Map(second.notFound.map(({ mod, installationFile, submodule }) =>
    [mod, named.unread + downloaded.unread(installationFile) + submodules.unread(submodule)]));
  return {
    applied: true,
    landed: [...first.landed, ...second.landed],
    refused: [
      ...firstRefused,
      ...second.refused.map((refused) => ({ ...refused, reason: refused.reason + (unreadFor.get(refused.item) ?? '') })),
      ...read.refused,
    ],
    ...cancelRefused(second.cancelRefusal, cancelRefusal),
  };
}

// A failed init leaves nothing behind: what it wrote goes, and what stays is named.
async function refusalTakenBack(failure: unknown, undone: readonly { what: string; undo: () => Promise<void> }[]): Promise<string> {
  let refusal = errorMessage(failure);
  for (const { what, undo } of undone) {
    try {
      await undo();
    } catch (err) {
      refusal += `; ${what} remains: ${errorMessage(err)}`;
    }
  }
  return refusal;
}

async function submodulesWritten(adapter: Adapter): Promise<{ notes: readonly ModNote[]; submoduleNotes: readonly string[] }> {
  try {
    const { notes, other } = await adapter.writeSubmodules();
    return { notes, submoduleNotes: other };
  } catch (err) {
    return { notes: [], submoduleNotes: [errorMessage(err)] };
  }
}

/** The modlist gestures, bound to the mEdit client and handing it the instance's facts. */
export function modlistRepositoryCommands(deps: ModlistRepositoryCommandsDeps) {
  const { client, adapter, instanceRoot, makeRepository } = deps;
  const ignoreList = { what: 'the ignore list it wrote', undo: () => adapter.removeIgnoreList() };
  const repository = { what: 'the repository it made', undo: () => adapter.removeRepository() };

  return {
    /** Makes the repository and its ignore list, and writes no manifest. Refused when the instance folder holds one already. */
    gitInit: async (): Promise<CommandResult<object>> => {
      if (await adapter.repositoryOnDisk()) return { applied: false, refusal: `${instanceRoot} already holds a repository.` };
      try {
        await adapter.checkPushRefusalFree();
        await adapter.writeIgnoreList();
      } catch (err) {
        return refuse(err);
      }
      try {
        await makeRepository();
      } catch (err) {
        return { applied: false, refusal: await refusalTakenBack(err, [ignoreList]) };
      }
      try {
        await adapter.refuseUnpublishedPins();
      } catch (err) {
        return { applied: false, refusal: await refusalTakenBack(err, [repository, ignoreList]) };
      }
      return { applied: true };
    },

    /** A mod whose folder or installation files the Instance adapter cannot answer is refused here, naming why, and mEdit
     *  updates the rest. */
    updateManifest: async (
      mods: readonly string[], { onProgress, signal }: ModlistCallOptions<UpdateManifestStatus> = {},
    ): Promise<UpdateManifestResult> => {
      const sourceMods = await adapter.sourceMods();
      const game = await gameToHand(adapter, sourceMods);
      const { sent, gameFiles, refused: unread, notes } = await readMods(adapter, mods, (mod) => adapter.installationFile(mod), game, { onProgress, signal });
      const refused = [...unread];
      if (sent.length === 0) return { applied: true, landed: [], refused, notes, submoduleNotes: [] };
      const versioned: UpdateManifestMod[] = [];
      for (const mod of sent) {
        const metadata = await adapter.modMetadata(mod.name);
        if (metadata.kind === 'unreadable') refused.push({ item: mod.name, reason: metadataUnreadable(metadata.reason) });
        else versioned.push({ ...mod, isSourceMod: sourceMods.folderOf(mod.name) !== undefined, version: metadata.answer.version });
      }
      if (versioned.length === 0) return { applied: true, landed: [], refused, notes, submoduleNotes: [] };
      const outcome = await client.updateManifest(
        versioned,
        {
          statCache: adapter.statCacheFolder,
          gameFolder: wireGameFolder(game.folder, gameFiles),
        },
        { onProgress: (progress) => onProgress?.({ phase: 'Updating', ...progress }), signal });
      if (isRefused(outcome)) return { applied: false, refusal: outcome.message };
      const submodules = await submodulesWritten(adapter);
      return { applied: true, ...outcome, refused: [...outcome.refused, ...refused], notes: [...notes, ...submodules.notes], submoduleNotes: submodules.submoduleNotes };
    },

    /** Asks before anything is written, so a mod the Instance adapter gives no folder, which restore refuses, is not asked. */
    whatRestoreDestroys: async (mods: readonly string[]): Promise<WhatRestoreDestroys> => {
      const folders = await byFolder(adapter, mods);
      const asked: ModByFolder[] = [];
      const skipped: ItemRefusal<string>[] = [];
      for (const folder of folders) {
        const held = await adapter.modMetadata(folder.name);
        if (held.kind === 'unreadable') skipped.push({ item: folder.name, reason: `was skipped: ${metadataUnreadable(held.reason)}.` });
        else asked.push(modWithMetadata(folder, held));
      }
      if (asked.length === 0) return { destroys: [], refused: skipped };
      const listing = await client.getWhatRestoreDestroys(asked, adapter.statCacheFolder);
      if (isReadFailed(listing)) return { refusal: `Could not ask what restore from manifest destroys: ${failureReason(listing)}` };
      for (const { mod, metadata } of listing.manifests) {
        const why = await adapter.unwritableMetadata(mod, heldByAdapter(metadata));
        if (why !== undefined) skipped.push({ item: mod, reason: `was skipped: ${why}.` });
      }
      const unrestorable = new Set(skipped.map(({ item }) => item));
      return { destroys: listing.destroys.filter(({ mod }) => !unrestorable.has(mod)), refused: [...listing.refused, ...skipped] };
    },

    restoreFromManifest: (
      mods: readonly string[], options: ModlistCallOptions<RestoreStatus> = {},
    ): Promise<RestoreResult> => restoreFromManifest(deps, mods, options),

    /** Each mod's folder against its manifest (modlist-repository.md, Status). */
    modStatus: async (mods: readonly string[]): Promise<readonly ModStatus[] | ReadFailed> => {
      const folders = await byFolder(adapter, mods);
      const asked = await withMetadataRead(folders, (mod) => adapter.modMetadata(mod));
      return asked.length === 0 ? [] : client.getModStatus(asked, adapter.statCacheFolder);
    },
  };
}

export type ModlistRepositoryCommands = ReturnType<typeof modlistRepositoryCommands>;
