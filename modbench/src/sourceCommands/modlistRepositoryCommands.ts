import {
  isRefused, type RestoreFacts, type UpdateManifestFacts, type RestoreMod, type RestoreOutcome, type MEditClient, type ModlistProgress, type ModRestoreDestroys, type NotFound, type ManifestMetadata,
  type ModByFolder, type ModStatus, type UpdateManifestMod, type UpdateManifestOutcome, type ModlistCallOptions,
} from '../client';
import type { CommandResult } from '../coreLib/commandResult';
import type { FileRead, GameFile, InstallationFile, InstanceAdapter, ModMetadata, SourceMods } from '../instanceAdapter/instanceAdapter';
import { errorMessage } from '../ports/errorMessage';
import { refuse } from '../coreLib/refuse';
import type { ItemRefusal } from '../ports/selectionOutcome';
import type { HostGit } from '../ports/repository';
import type { MoveToTrash } from '../ports/trash';
import { modWithMetadata, withMetadataRead } from '../wire/modByFolder';
import { failureReason, isReadFailed, type ReadFailed } from '../wire/readFailed';
import { inModOrder } from './inModOrder';
import { initRepositoryIn } from './initRepositoryIn';
import { namedDownloadedFiles, wireFile } from './namedDownloadedFiles';
import type { Nexus } from '../nexus/nexus';
import { archiveVariants, metadataUnreadable } from './sourceCommands';
import type { StepTasks } from './steps';

type Adapter = Pick<InstanceAdapter,
  'gameFolder' | 'gameRelease' | 'modOrder' | 'entryKey' | 'sourceMods' | 'installationFile' | 'downloadedFile' | 'gameFiles' | 'gameFilesTakenBy' | 'modMetadata' | 'unwritableMetadata' | 'writeModMetadata' | 'metadataFilesInModFolder' | 'modFolderPath' | 'writeIgnoreList' | 'keepOutOfPublisher' | 'publisherConfigurationRefusal' | 'writeSubmodules' | 'refuseUnpublishedPins' | 'checkPushRefusalFree' | 'removeRepository' | 'repositoryOnDisk'
  | 'writePathTokens' | 'pathsOutsideFolders'
  | 'statCacheFolder' | 'trashModFile' | 'exclusionMark' | 'submodule' | 'unclonedSubmodules' | 'nexusFileAt' | 'putDownloadedFile'>;

interface ModlistRepositoryCommandsDeps {
  client: Pick<MEditClient, 'updateManifest' | 'restoreFromManifest' | 'cloneSubmodules' | 'getWhatRestoreDestroys' | 'getModStatus'>;
  adapter: Adapter;
  nexus: Pick<Nexus, 'download'>;
  instanceRoot: string;
  hostGit: HostGit<unknown>;
  trash: MoveToTrash;
  tasks: StepTasks;
}

/** What update manifest could not read of a mod, which a person or an agent reads by the mod's label. */
export interface ModNote { readonly mod: string; readonly note: string }

/** What update manifest answers: each mod updated or refused, and each entry a mod folder's listing skipped, or the
 *  whole gesture refused, as a message to show. */
export type UpdateManifestResult = ({ applied: true; notes: readonly ModNote[]; repositoryNotes: readonly string[] } & UpdateManifestOutcome) | { applied: false; refusal: string };

/** Where update manifest is: the Instance adapter reading a mod's files, or mEdit updating manifests. */
export type UpdateManifestStatus = { readonly phase: 'ReadingFiles'; readonly mod: string } | ({ readonly phase: 'Updating' } & ModlistProgress);

/** pushRefusalNotWritten: why the instance repository does not refuse a push of a pin its source mod's remote lacks.
 *  pathTokensNotWritten: why a path token stays in the working tree. */
export type RestoreResult =
  | ({ applied: true; pushRefusalNotWritten?: string; pathTokensNotWritten?: string } & Omit<RestoreOutcome, 'notFound'>)
  | { applied: false; refusal: string; unfinished: readonly string[] };

/** What restore from manifest would destroy, each mod with a file it would replace or trash and each mod it skipped, or why
 *  mEdit could not say. */
export type WhatRestoreDestroys = { destroys: readonly ModRestoreDestroys[]; refused: readonly ItemRefusal<string>[] } | { refusal: string };

export type RestoreStatus =
  | { readonly phase: 'Cloning' }
  | { readonly phase: 'ReadingFiles'; readonly mod: string }
  | { readonly phase: 'Downloading'; readonly file: string }
  | ({ readonly phase: 'Restoring' } & ModlistProgress);

type ReadMod = Omit<UpdateManifestMod, 'version'>;

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

// A source mod's manifest is in its repository (modlist-repository.md, The manifest, story 1).
const sourceFolderOf = (sourceMods: SourceMods, mod: string): { sourceFolder?: string } => {
  const sourceFolder = sourceMods.folderOf(mod);
  return sourceFolder === undefined ? {} : { sourceFolder };
};

async function byFolder(adapter: Adapter, mods: readonly string[]): Promise<ModByFolder[]> {
  const sourceMods = await adapter.sourceMods();
  const asked: ModByFolder[] = [];
  for (const mod of mods) {
    const folder = await adapter.modFolderPath(mod);
    if (folder !== undefined) asked.push({ name: mod, folder, metadataFiles: [...adapter.metadataFilesInModFolder], ...sourceFolderOf(sourceMods, mod) });
  }
  return asked;
}

async function gameFilesOf(
  adapter: Adapter, mod: string, game: GameToHand | undefined,
): Promise<{ gameFiles: readonly GameFile[]; notes: readonly string[] } | { refusal: string }> {
  if (game === undefined || !game.takes(mod)) return { gameFiles: [], notes: [] };
  if (typeof game.folder === 'string') return { gameFiles: [], notes: [`${game.folder}, so its manifest cannot name the game folder as its package`] };
  const taken = await adapter.gameFilesTakenBy(game.folder.dataFolder, mod);
  return taken.kind === 'unreadable' ? { refusal: taken.reason } : { gameFiles: taken.answer.gameFiles, notes: taken.answer.notes };
}

async function readMod(
  adapter: Adapter, mod: string, installationFileOf: InstallationFileOf, game: GameToHand | undefined, sourceMods: SourceMods,
): Promise<{ read: ReadMod; gameFiles: readonly GameFile[]; notes: readonly string[] } | { refusal: string }> {
  const folder = await adapter.modFolderPath(mod);
  if (folder === undefined) return { refusal: 'its name gives it no folder' };
  const installed = await installationFileOf(mod);
  if (installed.kind === 'unreadable') return { refusal: installed.reason };
  const taken = installed.answer === undefined ? await gameFilesOf(adapter, mod, game) : { gameFiles: [], notes: [] };
  if ('refusal' in taken) return taken;
  return {
    read: { name: mod, folder, installationFile: wireFile(installed.answer), metadataFiles: [...adapter.metadataFilesInModFolder], ...sourceFolderOf(sourceMods, mod) },
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
  adapter: Adapter, mods: readonly string[], installationFileOf: InstallationFileOf, game: GameToHand | undefined, sourceMods: SourceMods,
  { onProgress, signal }: ModlistCallOptions<{ phase: 'ReadingFiles'; mod: string }>,
): Promise<ReadMods> {
  const sent: ReadMod[] = [];
  const gameFiles = new Map<string, GameFile>();
  const refused: ItemRefusal<string>[] = [];
  const notes: ModNote[] = [];
  for (const mod of mods) {
    if (signal?.aborted) break;
    onProgress?.({ phase: 'ReadingFiles', mod });
    const read = await readMod(adapter, mod, installationFileOf, game, sourceMods);
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
): Promise<{ found: readonly GameFile[]; unreadable: (mod: string) => Record<string, string> }> {
  const found = new Map<string, GameFile>();
  const unreadable = new Map<string, Record<string, string>>();
  for (const { mod, gameFiles } of notFound) {
    if (gameFiles.length === 0) continue;
    const read = typeof folder === 'string'
      ? { files: [], unreadable: Object.fromEntries(gameFiles.map((path) => [path, folder])) }
      : await adapter.gameFiles(folder.dataFolder, gameFiles);
    unreadable.set(mod, read.unreadable);
    for (const file of read.files) found.set(file.path.toLowerCase(), file);
  }
  return { found: [...found.values()], unreadable: (mod) => unreadable.get(mod) ?? {} };
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

const notCloned = (why: string): string => `was not cloned: ${why.replace(/\.$/, '')}.`;

interface Cloned { readonly refused: readonly ItemRefusal<string>[]; readonly leftDetached: ReadonlyMap<string, string> }

// modlist-repository.md, Restore from manifest, story 3: a submodule the source folder lacks is cloned first, because the
// manifest it holds is what names the mod it builds.
async function submodulesCloned({ adapter, client }: ModlistRepositoryCommandsDeps, onProgress?: (status: RestoreStatus) => void): Promise<Cloned> {
  const uncloned = await adapter.unclonedSubmodules();
  const refused: ItemRefusal<string>[] = uncloned.flatMap((submodule) => ('lacks' in submodule ? [{ item: submodule.name, reason: notCloned(submodule.lacks) }] : []));
  const toClone = uncloned.flatMap((submodule) => ('lacks' in submodule ? [] : [submodule]));
  if (toClone.length === 0) return { refused, leftDetached: new Map() };
  onProgress?.({ phase: 'Cloning' });
  const cloned = await client.cloneSubmodules(toClone.map(({ folder, pin, branch }) => ({ folder, pin, ...(branch === undefined ? {} : { branch }) })));
  if (isRefused(cloned)) return { refused: [...refused, ...toClone.map(({ name }) => ({ item: name, reason: notCloned(cloned.message) }))], leftDetached: new Map() };
  const nameOf = new Map(toClone.map(({ name, folder }) => [folder, name]));
  const leftDetached = new Map<string, string>();
  for (const { item, message } of cloned.refused) refused.push({ item: nameOf.get(item) ?? item, reason: notCloned(message) });
  for (const { folder, leftDetached: why } of cloned.applied) {
    if (why) leftDetached.set(folder, why);
  }
  return { refused, leftDetached };
}

// modlist-repository.md, Every mod, story 1: every other manifest, a source mod's whose folder its build has not made included.
const withEverySourceMod = (mods: readonly string[], sourceMods: SourceMods): string[] => {
  const listed = new Set(mods.map((mod) => mod.toLowerCase()));
  return [...mods, ...[...sourceMods.folders.keys()].filter((mod) => !listed.has(mod.toLowerCase()))];
};

const leftDetachedBy = (landed: Restored, sourceMods: SourceMods, cloned: Cloned): Restored =>
  landed.map((mod) => {
    const why = cloned.leftDetached.get(sourceMods.folderOf(mod.mod) ?? '');
    return why === undefined || mod.leftDetached ? mod : { ...mod, leftDetached: why };
  });

async function restoreFromManifest(
  deps: ModlistRepositoryCommandsDeps, asked: readonly string[], options: ModlistCallOptions<RestoreStatus>, everyManifest: boolean,
): Promise<RestoreResult> {
  const pathTokensNotWritten = await pathTokensWrittenOrWhy(deps.adapter);
  const cloned = await submodulesCloned(deps, options.onProgress);
  const sourceMods = await deps.adapter.sourceMods();
  const mods = await inModOrder(deps.adapter, everyManifest ? withEverySourceMod(asked, sourceMods) : asked);
  const restored = await restoreFolders(deps, mods, sourceMods, options);
  const landedInOrder = (await inModOrder(deps.adapter, restored.landed.map(({ mod }) => mod)))
    .flatMap((name) => restored.landed.filter(({ mod }) => mod === name));
  const trashed = await withFilesNoLineNamesTrashed(deps, leftDetachedBy(landedInOrder, sourceMods, cloned));
  const stepped = await withRestoredStepsRun(deps, trashed.finished, options.signal);
  const finished = stepped.finished;
  const unfinished = [...trashed.unfinished, ...stepped.unfinished];
  if (restored.applied) {
    const refused = [...cloned.refused, ...restored.refused, ...unfinished];
    const pushRefusalNotWritten = await pushRefusalWrittenOrWhy(deps.adapter);
    return {
      ...restored, landed: finished, refused: options.signal?.aborted ? [...refused, ...cancelledBefore(mods, restored)] : refused,
      ...(pushRefusalNotWritten === undefined ? {} : { pushRefusalNotWritten }),
      ...(pathTokensNotWritten === undefined ? {} : { pathTokensNotWritten }),
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

// modlist-repository.md, The repository, story 4: a clone holds a path token where its game path is until restore puts
// this machine's path there, so restore writes them before it reads the game folder.
async function pathTokensWrittenOrWhy(adapter: Adapter): Promise<string | undefined> {
  try {
    return await adapter.writePathTokens();
  } catch (err) {
    return errorMessage(err);
  }
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

// modlist-repository.md, The manifest, story 17: restore runs a mod's steps once its folder holds what its packages give.
async function withRestoredStepsRun(
  { adapter, tasks }: ModlistRepositoryCommandsDeps, landed: Restored, signal: AbortSignal | undefined,
): Promise<{ finished: Restored; unfinished: readonly ItemRefusal<string>[] }> {
  const finished: Restored[number][] = [];
  const unfinished: ItemRefusal<string>[] = [];
  for (const mod of landed) {
    const why = await whyNotStepped(adapter, tasks, mod, signal);
    if (why === undefined) finished.push(mod);
    else unfinished.push({ item: mod.mod, reason: `was not finished: ${why}. Restoring it again finishes it.` });
  }
  return { finished, unfinished };
}

async function whyNotStepped(
  adapter: Adapter, tasks: StepTasks, { mod, steps }: Restored[number], signal: AbortSignal | undefined,
): Promise<string | undefined> {
  if (steps.length === 0) return undefined;
  if (signal?.aborted) return 'the restore was cancelled before its steps ran';
  const folder = await adapter.modFolderPath(mod);
  if (folder === undefined) return 'its name gives it no folder for its steps to run in';
  const failed = await tasks.whyStepsFailed(steps, folder);
  return failed === undefined ? undefined : `its ${failed}`;
}

const heldByAdapter = ({ version, installationFile }: ManifestMetadata): ModMetadata =>
  ({ version: version ?? undefined, installationFile: installationFile ? { name: installationFile.name, page: installationFile.page ?? undefined } : undefined });

async function metadataWrittenOrWhy(adapter: Adapter, mod: string, metadata: ManifestMetadata): Promise<string | undefined> {
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
  { client, adapter, nexus, tasks }: ModlistRepositoryCommandsDeps, mods: readonly string[], sourceMods: SourceMods,
  { onProgress, signal }: ModlistCallOptions<RestoreStatus>,
): Promise<Extract<RestoreResult, { applied: true }> | FoldersNotFinished> {
  const gameRelease = await adapter.gameRelease();
  const folder = await namedGameFolder(adapter, gameRelease);
  const read = await readMods(adapter, mods, noneBeforeTheManifestNamesThem, undefined, sourceMods, { onProgress, signal });
  if (read.sent.length === 0) return { applied: true, landed: [], refused: read.refused };
  const sent: readonly RestoreMod[] = read.sent;
  const facts: RestoreFacts = {
    statCache: adapter.statCacheFolder, exclusionMark: adapter.exclusionMark, archives: archiveVariants(gameRelease), gameFolder: wireGameFolder(folder, []), asksWhatItLacks: true,
    tasks: [...await tasks.labels()],
  };
  const restoring = { onProgress: (progress: ModlistProgress): void => { onProgress?.({ phase: 'Restoring', ...progress }); }, signal };
  const first = await restoreOnce(client, sent, facts, restoring);
  if (!first.applied) return { ...first, landed: [] };
  const { cancelRefusal } = first;
  const retried = new Map(first.notFound.map((notFound) => [notFound.mod, notFound]));
  const firstRefused = first.refused.filter((refused) => !retried.has(refused.item));
  const notSentAgain = { applied: true, landed: first.landed, refused: [...firstRefused, ...read.refused], ...cancelRefused(cancelRefusal) } as const;
  if (retried.size === 0 || signal?.aborted) return notSentAgain;

  const named = await namedGameFiles(adapter, folder, first.notFound);
  const downloaded = await namedDownloadedFiles({ adapter, nexus }, first.notFound, { onDownload: (file) => { onProgress?.({ phase: 'Downloading', file }); }, signal });
  if (signal?.aborted) return notSentAgain;
  const submodules = await namedSubmodules(adapter, first.notFound);
  const again = sent.flatMap((mod) => {
    const notFound = retried.get(mod.name);
    return notFound === undefined
      ? [] : [{
        ...mod, installationFiles: notFound.installationFiles.flatMap((file) => wireFile(downloaded.handed(file.name)) ?? []), submodule: submodules.handed(notFound.submodule),
        unreadableGameFiles: named.unreadable(mod.name), unreadableInstallationFiles: downloaded.unreadableAmong(notFound.installationFiles),
      }];
  });
  const builtFromSource = new Set(again.filter((mod) => mod.submodule !== undefined).map((mod) => mod.name));
  const secondFacts = { ...facts, gameFolder: wireGameFolder(folder, named.found), asksWhatItLacks: builtFromSource.size > 0 };
  const second = await restoreOnce(client, again, secondFacts, restoring);
  if (!second.applied) return { ...second, landed: first.landed };

  // modlist-repository.md, Restore from manifest, story 3: the manifest of a source mod names its installation files, and
  // it is read once its submodule is checked out.
  const needing = new Map(second.notFound.filter((notFound) => builtFromSource.has(notFound.mod) && notFound.installationFiles.length > 0).map((notFound) => [notFound.mod, notFound]));
  const fetched = needing.size === 0 || signal?.aborted
    ? undefined
    : await namedDownloadedFiles({ adapter, nexus }, [...needing.values()], { onDownload: (file) => { onProgress?.({ phase: 'Downloading', file }); }, signal });
  const third = fetched === undefined || signal?.aborted ? undefined : await restoreOnce(
    client,
    again.flatMap((mod) => {
      const notFound = needing.get(mod.name);
      return notFound === undefined ? [] : [{
        ...mod, installationFiles: notFound.installationFiles.flatMap((file) => wireFile(fetched.handed(file.name)) ?? []),
        unreadableInstallationFiles: fetched.unreadableAmong(notFound.installationFiles),
      }];
    }),
    { ...secondFacts, asksWhatItLacks: false }, restoring);
  if (third !== undefined && !third.applied) return { ...third, landed: [...first.landed, ...second.landed] };

  const answeredAgain = new Set(third === undefined ? [] : needing.keys());
  const stillLacking = [...second.notFound.filter(({ mod }) => !answeredAgain.has(mod)), ...(third?.notFound ?? [])];
  const unreadFor = new Map(stillLacking.map(({ mod, submodule, installationFiles }) => {
    const whyNot = installationFiles.flatMap(({ name }) => [downloaded.notDownloaded(name), fetched?.notDownloaded(name)].filter((why) => why !== undefined));
    return [mod, submodules.unread(submodule) + whyNot.map(sentence).join('')];
  }));
  const refusedAgain = [...second.refused.filter(({ item }) => !answeredAgain.has(item)), ...(third?.refused ?? [])];
  return {
    applied: true,
    landed: [...first.landed, ...second.landed, ...(third?.landed ?? [])],
    refused: [
      ...firstRefused,
      ...refusedAgain.map((refused) => ({ ...refused, reason: refused.reason + (unreadFor.get(refused.item) ?? '') })),
      ...read.refused,
    ],
    ...cancelRefused(third?.cancelRefusal, second.cancelRefusal, cancelRefusal),
  };
}

// A failed init leaves nothing behind: what it wrote goes, and what stays is named.
interface TakenBack { readonly what: string; readonly undo: () => Promise<void> }

async function refusalTakenBack(failure: unknown, undone: readonly TakenBack[]): Promise<string> {
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

// publishing.md, What ships, story 1
async function keptOutOfPublisher(adapter: Adapter): Promise<readonly string[]> {
  try {
    await adapter.keepOutOfPublisher();
    return [];
  } catch (err) {
    return [errorMessage(err)];
  }
}

async function submodulesWritten(adapter: Adapter): Promise<{ notes: readonly ModNote[]; repositoryNotes: readonly string[] }> {
  try {
    const { notes, other } = await adapter.writeSubmodules();
    return { notes, repositoryNotes: other };
  } catch (err) {
    return { notes: [], repositoryNotes: [errorMessage(err)] };
  }
}

async function pathsReported(adapter: Adapter): Promise<readonly string[]> {
  try {
    return (await adapter.pathsOutsideFolders()).map(({ file, path }) => `${file} holds a path no path token names: ${path}`);
  } catch (err) {
    return [`the paths the instance repository's files hold could not be read: ${errorMessage(err)}`];
  }
}

/** pathTokensNotWritten: why a path token stays in the working tree. pushRefusalNotWritten: why an adopted repository's
 *  own pre-push hook was left in place. */
export type GitInitResult = CommandResult<{ pathTokensNotWritten?: string; pushRefusalNotWritten?: string }>;

async function gitInit({ adapter, instanceRoot, hostGit }: ModlistRepositoryCommandsDeps): Promise<GitInitResult> {
  const adopting = await adapter.repositoryOnDisk();
  let takenBack: TakenBack[] = [];
  try {
    if (!adopting) await adapter.checkPushRefusalFree();
    const unreadable = await adapter.publisherConfigurationRefusal();
    if (unreadable !== undefined) return { applied: false, refusal: unreadable };
    takenBack = [{ what: 'the ignore list it wrote', undo: await adapter.writeIgnoreList() }];
  } catch (err) {
    return refuse(err);
  }
  if (!adopting) {
    try {
      await initRepositoryIn(hostGit, instanceRoot);
    } catch (err) {
      return { applied: false, refusal: await refusalTakenBack(err, takenBack) };
    }
    takenBack = [{ what: 'the repository it made', undo: () => adapter.removeRepository() }, ...takenBack];
  }
  let pushRefusalNotWritten: string | undefined;
  try {
    takenBack = [{ what: 'the push check it wrote', undo: await adapter.refuseUnpublishedPins() }, ...takenBack];
  } catch (err) {
    if (!adopting) return { applied: false, refusal: await refusalTakenBack(err, takenBack) };
    pushRefusalNotWritten = errorMessage(err);
  }
  let pathTokensNotWritten: string | undefined;
  try {
    takenBack = [{ what: 'the publisher\'s ignore list entries it wrote', undo: await adapter.keepOutOfPublisher() }, ...takenBack];
    pathTokensNotWritten = await adapter.writePathTokens();
  } catch (err) {
    return { applied: false, refusal: await refusalTakenBack(err, takenBack) };
  }
  return {
    applied: true,
    ...(pushRefusalNotWritten === undefined ? {} : { pushRefusalNotWritten }),
    ...(pathTokensNotWritten === undefined ? {} : { pathTokensNotWritten }),
  };
}

/** The modlist gestures, bound to the mEdit client and handing it the instance's facts. */
export function modlistRepositoryCommands(deps: ModlistRepositoryCommandsDeps) {
  const { client, adapter } = deps;

  return {
    /** Makes the repository, or adopts the one the instance folder holds, with its ignore list, push refusal and path
     *  tokens, and writes no manifest. */
    gitInit: (): Promise<GitInitResult> => gitInit(deps),

    /** A mod whose folder or installation files the Instance adapter cannot answer is refused here, naming why, and mEdit
     *  updates the rest. */
    updateManifest: async (
      mods: readonly string[], { onProgress, signal }: ModlistCallOptions<UpdateManifestStatus> = {},
    ): Promise<UpdateManifestResult> => {
      const sourceMods = await adapter.sourceMods();
      const game = await gameToHand(adapter, sourceMods);
      const { sent, gameFiles, refused: unread, notes } = await readMods(adapter, mods, (mod) => adapter.installationFile(mod), game, sourceMods, { onProgress, signal });
      const refused = [...unread];
      if (sent.length === 0) return { applied: true, landed: [], refused, notes, repositoryNotes: await pathsReported(adapter) };
      const versioned: UpdateManifestMod[] = [];
      for (const mod of sent) {
        const metadata = await adapter.modMetadata(mod.name);
        if (metadata.kind === 'unreadable') refused.push({ item: mod.name, reason: metadataUnreadable(metadata.reason) });
        else versioned.push({ ...mod, version: metadata.answer.version });
      }
      if (versioned.length === 0) return { applied: true, landed: [], refused, notes, repositoryNotes: await pathsReported(adapter) };
      const outcome = await client.updateManifest(
        versioned,
        {
          statCache: adapter.statCacheFolder,
          gameFolder: wireGameFolder(game.folder, gameFiles),
        },
        { onProgress: (progress) => onProgress?.({ phase: 'Updating', ...progress }), signal });
      if (isRefused(outcome)) return { applied: false, refusal: outcome.message };
      const submodules = await submodulesWritten(adapter);
      return {
        applied: true, ...outcome, refused: [...outcome.refused, ...refused], notes: [...notes, ...submodules.notes],
        repositoryNotes: [...submodules.repositoryNotes, ...await keptOutOfPublisher(adapter), ...await pathsReported(adapter)],
      };
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

    /** `everyManifest`: the mods are every mod, so a source mod whose folder its build has not made joins them. */
    restoreFromManifest: (
      mods: readonly string[], options: ModlistCallOptions<RestoreStatus> = {}, everyManifest = false,
    ): Promise<RestoreResult> => restoreFromManifest(deps, mods, options, everyManifest),

    /** Each mod's folder against its manifest (modlist-repository.md, Status). */
    modStatus: async (mods: readonly string[]): Promise<readonly ModStatus[] | ReadFailed> => {
      const folders = await byFolder(adapter, mods);
      const asked = await withMetadataRead(folders, (mod) => adapter.modMetadata(mod));
      return asked.length === 0 ? [] : client.getModStatus(asked, adapter.statCacheFolder);
    },
  };
}

export type ModlistRepositoryCommands = ReturnType<typeof modlistRepositoryCommands>;
