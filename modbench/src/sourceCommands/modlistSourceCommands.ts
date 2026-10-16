import {
  isRefused, type RestoreFacts, type RestoreMod, type RestoreOutcome, type MEditClient, type ModlistProgress, type ModRestoreDestroys, type NotFound,
  type ModByFolder, type ModStatus, type UpdateManifestMod, type UpdateManifestOutcome, type ModlistCallOptions,
} from '../client';
import type { CommandResult } from '../coreLib/commandResult';
import type { FileRead, GameFile, GameFolder, InstallationFile, InstanceAdapter, ModMetadata } from '../instanceAdapter/instanceAdapter';
import { errorMessage } from '../ports/errorMessage';
import { refuse } from '../ports/refuse';
import type { ItemRefusal } from '../ports/selectionOutcome';
import type { MoveToTrash } from '../ports/trash';
import { modWithMetadata, withMetadataRead } from '../wire/modByFolder';
import { failureReason, isReadFailed, type ReadFailed } from '../wire/readFailed';
import { archiveVariants, metadataUnreadable } from './sourceCommands';

type Adapter = Pick<InstanceAdapter,
  'installationFiles' | 'downloadedFile' | 'modMetadata' | 'unwritableMetadata' | 'writeModMetadata' | 'metadataFilesInModFolder' | 'modFolderPath' | 'overriddenGameFiles' | 'gameFilesOverriddenBy' | 'writeIgnoreList' | 'removeIgnoreList'
  | 'statCacheFolder' | 'trashModFile' | 'sourceFolder' | 'excludedSuffix'>;

interface ModlistSourceCommandsDeps {
  client: Pick<MEditClient, 'updateManifest' | 'restoreFromManifest' | 'getWhatRestoreDestroys' | 'getModStatus'>;
  adapter: Adapter;
  instanceRoot: string;
  /** VS Code's git makes the instance folder a repository. */
  makeRepository: () => Promise<void>;
  trash: MoveToTrash;
}

/** The slice of the instance value the modlist gestures read: where the game's files are, the release whose archives a
 *  build packs, and each source mod's source folder. */
export interface ModlistInstance {
  readonly gameFolder: GameFolder;
  readonly gameRelease: string | undefined;
  readonly paths: { readonly sourceDirs: ReadonlyMap<string, string> };
}

/** What update manifest could not read of a mod, which a person or an agent reads by the mod's label. */
export interface ModNote { readonly mod: string; readonly note: string }

/** What update manifest answers: each mod updated or refused, and each entry a mod folder's listing skipped, or the
 *  whole gesture refused, as a message to show. */
export type UpdateManifestResult = ({ applied: true; notes: readonly ModNote[] } & UpdateManifestOutcome) | { applied: false; refusal: string };

/** Where update manifest is: the Instance adapter reading a mod's files, or mEdit updating manifests. */
export type UpdateManifestStatus = { readonly phase: 'ReadingFiles'; readonly mod: string } | ({ readonly phase: 'Updating' } & ModlistProgress);

export type RestoreResult =
  | ({ applied: true } & Omit<RestoreOutcome, 'notFound'>)
  | { applied: false; refusal: string; unfinished: readonly string[] };

/** What restore from manifest would destroy, each mod with a file it would replace or trash and each mod it skipped, or why
 *  mEdit could not say. */
export type WhatRestoreDestroys = { destroys: readonly ModRestoreDestroys[]; refused: readonly ItemRefusal<string>[] } | { refusal: string };

export type RestoreStatus = { readonly phase: 'ReadingFiles'; readonly mod: string } | ({ readonly phase: 'Restoring' } & ModlistProgress);

type ReadMod = Omit<UpdateManifestMod, 'isSourceMod' | 'version'>;

type InstallationFilesOf = (mod: string) => Promise<FileRead<readonly InstallationFile[]>>;

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

const wireFile = ({ path, source, size, hash, entries }: InstallationFile): UpdateManifestMod['installationFiles'][number] =>
  ({ path, source, size, hash, entries: [...entries] });

async function readMod(
  adapter: Adapter, mod: string, dataFolder: string, installationFilesOf: InstallationFilesOf,
): Promise<{ read: ReadMod; gameFiles: readonly GameFile[]; notes: readonly string[] } | { refusal: string }> {
  const folder = await adapter.modFolderPath(mod);
  if (folder === undefined) return { refusal: 'its name gives it no folder' };
  const installed = await installationFilesOf(mod);
  if (installed.kind === 'unreadable') return { refusal: installed.reason };
  const overridden = await adapter.gameFilesOverriddenBy(dataFolder, mod);
  if (overridden.kind === 'unreadable') return { refusal: overridden.reason };
  return {
    read: { name: mod, folder, installationFiles: installed.answer.map(wireFile), metadataFiles: [...adapter.metadataFilesInModFolder] },
    gameFiles: overridden.answer.gameFiles,
    notes: [
      ...overridden.answer.notes,
      ...installed.answer.flatMap(({ unsourcedGame }) =>
        unsourcedGame === undefined ? [] : [`its installation file comes from '${unsourcedGame}', which has no Nexus domain here, so its manifest names no source`]),
    ],
  };
}

async function readMods(
  adapter: Adapter, mods: readonly string[], dataFolder: string, installationFilesOf: InstallationFilesOf,
  { onProgress, signal }: ModlistCallOptions<{ phase: 'ReadingFiles'; mod: string }>,
): Promise<ReadMods> {
  const sent: ReadMod[] = [];
  const gameFiles = new Map<string, GameFile>();
  const refused: ItemRefusal<string>[] = [];
  const notes: ModNote[] = [];
  for (const mod of mods) {
    if (signal?.aborted) break;
    onProgress?.({ phase: 'ReadingFiles', mod });
    const read = await readMod(adapter, mod, dataFolder, installationFilesOf);
    if ('refusal' in read) { refused.push({ item: mod, reason: read.refusal }); continue; }
    sent.push(read.read);
    for (const file of read.gameFiles) gameFiles.set(file.path.toLowerCase(), file);
    notes.push(...read.notes.map((note) => ({ mod, note })));
  }
  return { sent: signal?.aborted ? [] : sent, gameFiles: [...gameFiles.values()], refused, notes };
}

// modlist-repository.md, Restore from manifest, story 8: the manifest names them, and only mEdit reads it.
const noneBeforeTheManifestNamesThem: InstallationFilesOf = () => Promise.resolve({ kind: 'read', answer: [] });

// A call that fails part way answers no mod, so none had its files no line names trashed: each is not finished.
async function restoreOnce(
  client: ModlistSourceCommandsDeps['client'], mods: readonly RestoreMod[], facts: RestoreFacts, options: ModlistCallOptions,
): Promise<({ applied: true } & RestoreOutcome) | Extract<RestoreResult, { applied: false }>> {
  const outcome = await client.restoreFromManifest(mods, facts, options);
  return isRefused(outcome) ? { applied: false, refusal: outcome.message, unfinished: mods.map((mod) => mod.name) } : { applied: true, ...outcome };
}

async function namedGameFiles(
  adapter: Adapter, dataFolder: string, notFound: readonly NotFound[],
): Promise<{ found: readonly GameFile[]; unread: string }> {
  const paths = [...new Set(notFound.flatMap(({ gameFiles }) => gameFiles))];
  if (paths.length === 0) return { found: [], unread: '' };
  const found = await adapter.overriddenGameFiles(dataFolder, paths);
  return found.kind === 'read' ? { found: found.answer, unread: '' } : { found: [], unread: ` The game files could not be read: ${found.reason}.` };
}

async function namedDownloadedFiles(adapter: Adapter, notFound: readonly NotFound[]): Promise<{
  handed: (names: readonly string[]) => RestoreMod['installationFiles'];
  unread: (names: readonly string[]) => string;
}> {
  const read = new Map<string, FileRead<InstallationFile | undefined>>();
  for (const name of new Set(notFound.flatMap(({ installationFiles }) => installationFiles))) read.set(name, await adapter.downloadedFile(name));
  return {
    handed: (names) => names.flatMap((name) => {
      const file = read.get(name);
      return file?.kind === 'read' && file.answer !== undefined ? [wireFile(file.answer)] : [];
    }),
    unread: (names) => names.map((name) => {
      const file = read.get(name);
      return file?.kind === 'unreadable' ? ` '${name}' could not be read: ${file.reason}.` : '';
    }).join(''),
  };
}

function cancelRefused(...latestFirst: (string | undefined)[]): { cancelRefusal?: string } {
  const [cancelRefusal] = latestFirst.filter((refusal) => refusal !== undefined);
  return cancelRefusal === undefined ? {} : { cancelRefusal };
}

type Restored = Extract<RestoreResult, { applied: true }>['landed'];

type FoldersNotFinished = Extract<RestoreResult, { applied: false }> & { readonly landed: Restored };

async function restoreFromManifest(
  deps: ModlistSourceCommandsDeps, mods: readonly string[], instance: ModlistInstance, options: ModlistCallOptions<RestoreStatus>,
): Promise<RestoreResult> {
  const restored = await restoreFolders(deps, mods, instance, options);
  const { finished, unfinished } = await withFilesNoLineNamesTrashed(deps, restored.landed);
  if (restored.applied) {
    const refused = [...restored.refused, ...unfinished];
    return { ...restored, landed: finished, refused: options.signal?.aborted ? [...refused, ...cancelledBefore(mods, restored)] : refused };
  }
  return { applied: false, refusal: restored.refusal, unfinished: [...restored.unfinished, ...unfinished.map(({ item }) => item)] };
}

// modlist-repository.md, Restore from manifest, story 6: an interrupted restore names each mod it did not finish.
function cancelledBefore(mods: readonly string[], { landed, refused }: Extract<RestoreResult, { applied: true }>): ItemRefusal<string>[] {
  const answered = new Set([...landed.map(({ mod }) => mod), ...refused.map(({ item }) => item)]);
  return mods.filter((mod) => !answered.has(mod))
    .map((mod) => ({ item: mod, reason: 'was not finished: the restore was cancelled. Restoring it again finishes it.' }));
}

async function withFilesNoLineNamesTrashed(
  { adapter, trash }: ModlistSourceCommandsDeps, landed: Restored,
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

const heldByAdapter = ({ version, installationFiles }: NonNullable<Restored[number]['metadata']>): ModMetadata =>
  ({ version: version ?? undefined, installationFiles: installationFiles.map(({ name, source }) => ({ name, source: source ?? undefined })) });

async function metadataWrittenOrWhy(adapter: Adapter, mod: string, metadata: Restored[number]['metadata']): Promise<string | undefined> {
  if (metadata === undefined) return undefined;
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
  { client, adapter }: ModlistSourceCommandsDeps, mods: readonly string[], instance: ModlistInstance,
  { onProgress, signal }: ModlistCallOptions<RestoreStatus>,
): Promise<Extract<RestoreResult, { applied: true }> | FoldersNotFinished> {
  const { gameFolder, gameRelease, paths } = instance;
  if (gameFolder.kind !== 'found') {
    return { applied: false, refusal: 'Could not restore from manifest: the game folder was not found.', unfinished: [], landed: [] };
  }
  const read = await readMods(adapter, mods, gameFolder.dataFolder, noneBeforeTheManifestNamesThem, { onProgress, signal });
  if (read.sent.length === 0) return { applied: true, landed: [], refused: read.refused };
  const sent: readonly RestoreMod[] = read.sent.map((mod) => ({ ...mod, sourceFolder: paths.sourceDirs.get(mod.name) ?? adapter.sourceFolder(mod.name) }));
  const facts: RestoreFacts = {
    gameFiles: [...read.gameFiles], dataFolder: gameFolder.dataFolder, statCache: adapter.statCacheFolder,
    excludedSuffix: adapter.excludedSuffix, archives: archiveVariants(gameRelease),
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

  const named = await namedGameFiles(adapter, gameFolder.dataFolder, first.notFound);
  const downloaded = await namedDownloadedFiles(adapter, first.notFound);
  const gameFiles = new Map([...facts.gameFiles, ...named.found].map((file) => [file.path.toLowerCase(), file]));
  const again = sent.flatMap((mod) => {
    const notFound = retried.get(mod.name);
    return notFound === undefined ? [] : [{ ...mod, installationFiles: downloaded.handed(notFound.installationFiles) }];
  });
  const second = await restoreOnce(client, again, { ...facts, gameFiles: [...gameFiles.values()] }, restoring);
  if (!second.applied) return { ...second, landed: first.landed };
  const unreadFor = new Map(second.notFound.map(({ mod, installationFiles }) => [mod, named.unread + downloaded.unread(installationFiles)]));
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

/** The modlist gestures, bound to the mEdit client and handing it the instance's facts. */
export function modlistSourceCommands(deps: ModlistSourceCommandsDeps) {
  const { client, adapter, instanceRoot, makeRepository } = deps;
  // A failed init leaves nothing behind: the ignore list it wrote goes, and what stays is named.
  async function refusalWithIgnoreListTakenBack(failure: unknown): Promise<string> {
    try {
      await adapter.removeIgnoreList();
      return errorMessage(failure);
    } catch (err) {
      return `${errorMessage(failure)}; the ignore list it wrote remains: ${errorMessage(err)}`;
    }
  }

  return {
    /** Makes the repository and its ignore list, and writes no manifest. Refused when the instance folder holds one already. */
    gitInit: async ({ holdsRepository }: { readonly holdsRepository: boolean }): Promise<CommandResult<object>> => {
      if (holdsRepository) return { applied: false, refusal: `${instanceRoot} already holds a repository.` };
      try {
        await adapter.writeIgnoreList();
      } catch (err) {
        return refuse(err);
      }
      try {
        await makeRepository();
        return { applied: true };
      } catch (err) {
        return { applied: false, refusal: await refusalWithIgnoreListTakenBack(err) };
      }
    },

    /** A mod whose folder, installation files or overridden game files the Instance adapter cannot answer is refused
     *  here, naming why, and mEdit updates the rest. */
    updateManifest: async (
      mods: readonly string[], instance: ModlistInstance, { onProgress, signal }: ModlistCallOptions<UpdateManifestStatus> = {},
    ): Promise<UpdateManifestResult> => {
      const { gameFolder } = instance;
      if (gameFolder.kind !== 'found') return { applied: false, refusal: 'Could not update manifests: the game folder was not found.' };
      const { sent, gameFiles, refused: unread, notes } = await readMods(
        adapter, mods, gameFolder.dataFolder, (mod) => adapter.installationFiles(mod), { onProgress, signal });
      const refused = [...unread];
      if (sent.length === 0) return { applied: true, landed: [], refused, notes };
      const versioned: UpdateManifestMod[] = [];
      for (const mod of sent) {
        const metadata = await adapter.modMetadata(mod.name);
        if (metadata.kind === 'unreadable') refused.push({ item: mod.name, reason: metadataUnreadable(metadata.reason) });
        else versioned.push({ ...mod, isSourceMod: instance.paths.sourceDirs.has(mod.name), version: metadata.answer.version });
      }
      if (versioned.length === 0) return { applied: true, landed: [], refused, notes };
      const outcome = await client.updateManifest(
        versioned, { gameFiles: [...gameFiles], statCache: adapter.statCacheFolder }, { onProgress: (progress) => onProgress?.({ phase: 'Updating', ...progress }), signal });
      return isRefused(outcome) ? { applied: false, refusal: outcome.message } : { applied: true, ...outcome, refused: [...outcome.refused, ...refused], notes };
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
      mods: readonly string[], instance: ModlistInstance, options: ModlistCallOptions<RestoreStatus> = {},
    ): Promise<RestoreResult> => restoreFromManifest(deps, mods, instance, options),

    /** Each mod's folder against its manifest (modlist-repository.md, Status). */
    modStatus: async (mods: readonly string[]): Promise<readonly ModStatus[] | ReadFailed> => {
      const folders = await byFolder(adapter, mods);
      const asked = await withMetadataRead(folders, (mod) => adapter.modMetadata(mod));
      return asked.length === 0 ? [] : client.getModStatus(asked, adapter.statCacheFolder);
    },
  };
}

export type ModlistSourceCommands = ReturnType<typeof modlistSourceCommands>;
