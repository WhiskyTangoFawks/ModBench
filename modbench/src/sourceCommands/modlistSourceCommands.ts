import { dirname } from 'node:path';
import {
  isRefused, type DiscardFacts, type DiscardMod, type DiscardOutcome, type MEditClient, type ModlistProgress, type NotFound, type StageMod, type StageOutcome,
} from '../client';
import type { CommandResult } from '../coreLib/commandResult';
import {
  isArchiveName, samePath, type GameFile, type GameFolder, type InstallationFile, type InstanceAdapter, type OriginFile,
} from '../instanceAdapter/instanceAdapter';
import { errorMessage } from '../ports/errorMessage';
import { refuse } from '../ports/refuse';
import type { ItemRefusal } from '../ports/selectionOutcome';

const DELTA_SHARE = 0.5;

type Adapter = Pick<InstanceAdapter,
  'installationFiles' | 'downloadedFile' | 'managerFilesInModFolder' | 'modFolderPath' | 'overriddenGameFiles' | 'buildFolder'
  | 'writeIgnoreList' | 'removeIgnoreList'>;

interface ModlistSourceCommandsDeps {
  client: Pick<MEditClient, 'stage' | 'discardChanges'>;
  adapter: Adapter;
  instanceRoot: string;
  /** VS Code's git makes the instance folder a repository. */
  makeRepository: () => Promise<void>;
}

/** The slice of the instance value stage reads: each mod's files, and where the game's files are. */
export interface StageInstance {
  readonly filesByMod: ReadonlyMap<string, readonly Pick<OriginFile, 'relativePath'>[]>;
  readonly gameFolder: GameFolder;
}

export interface DiscardInstance extends StageInstance {
  readonly paths: { readonly downloadsDir: string | undefined; readonly modDirs: ReadonlyMap<string, string> };
  readonly downloads: { readonly kind: 'listed'; readonly rows: readonly { readonly name: string; readonly path: string }[] } | { readonly kind: 'unresolved' };
}

/** What stage answers: each mod staged or refused, or the whole stage refused, as a message to show. */
export type StageResult = ({ applied: true } & StageOutcome) | { applied: false; refusal: string };

/** Where stage is: the Instance adapter reading a mod's files, or mEdit staging mods. */
export type StageStatus = { readonly phase: 'ReadingFiles'; readonly mod: string } | ({ readonly phase: 'Staging' } & ModlistProgress);

export type DiscardResult =
  | ({ applied: true } & Omit<DiscardOutcome, 'notFound'>)
  | { applied: false; refusal: string; unfinished: readonly string[] };

export type DiscardStatus =
  | { readonly phase: 'ReadingFiles'; readonly mod: string }
  | ({ readonly phase: 'Discarding' } & ModlistProgress)
  | { readonly phase: 'ReadingDownloadedFile'; readonly file: string };

interface ReadMods {
  readonly sent: readonly StageMod[];
  readonly gameFiles: readonly GameFile[];
  readonly refused: readonly ItemRefusal<string>[];
}

const wireFile = (file: InstallationFile): StageMod['installationFiles'][number] => ({ ...file, entries: [...file.entries] });

async function readMod(
  adapter: Adapter, mod: string, dataFolder: string, modFilePaths: readonly string[],
): Promise<{ read: StageMod; gameFiles: readonly GameFile[] } | { refusal: string }> {
  const folder = await adapter.modFolderPath(mod);
  if (folder === undefined) return { refusal: 'its name gives it no folder' };
  const installed = await adapter.installationFiles(mod);
  if (installed.kind === 'unreadable') return { refusal: installed.reason };
  const overridden = await adapter.overriddenGameFiles(dataFolder, modFilePaths);
  if (overridden.kind === 'unreadable') return { refusal: overridden.reason };
  return {
    read: { name: mod, folder, installationFiles: installed.answer.map(wireFile), committedFiles: [...adapter.managerFilesInModFolder] },
    gameFiles: overridden.answer,
  };
}

async function readMods(
  adapter: Adapter, mods: readonly string[], dataFolder: string, { filesByMod }: StageInstance, onReading: (mod: string) => void,
): Promise<ReadMods> {
  const sent: StageMod[] = [];
  const gameFiles = new Map<string, GameFile>();
  const refused: ItemRefusal<string>[] = [];
  for (const mod of mods) {
    onReading(mod);
    const read = await readMod(adapter, mod, dataFolder, (filesByMod.get(mod) ?? []).map((file) => file.relativePath));
    if ('refusal' in read) { refused.push({ item: mod, reason: read.refusal }); continue; }
    sent.push(read.read);
    for (const file of read.gameFiles) gameFiles.set(file.path.toLowerCase(), file);
  }
  return { sent, gameFiles: [...gameFiles.values()], refused };
}

async function discardOnce(
  client: ModlistSourceCommandsDeps['client'], mods: readonly DiscardMod[], facts: DiscardFacts, onProgress: (progress: ModlistProgress) => void,
): Promise<({ applied: true } & DiscardOutcome) | Extract<DiscardResult, { applied: false }>> {
  let done = 0;
  const outcome = await client.discardChanges(mods, facts, {
    onProgress: (progress) => {
      if (progress.mod) done = progress.modsDone;
      onProgress(progress);
    },
  });
  return isRefused(outcome)
    ? { applied: false, refusal: outcome.message, unfinished: mods.slice(done).map((mod) => mod.name) }
    : { applied: true, ...outcome };
}

async function downloadedArchives(
  adapter: Adapter, downloads: DiscardInstance['downloads'], onReading: (file: string) => void,
): Promise<{ read: readonly InstallationFile[]; unread: readonly ItemRefusal<string>[] }> {
  const read: InstallationFile[] = [];
  const unread: ItemRefusal<string>[] = [];
  for (const row of downloads.kind === 'listed' ? downloads.rows.filter((file) => isArchiveName(file.name)) : []) {
    onReading(row.name);
    const hashed = await adapter.downloadedFile(row.path);
    if (hashed.kind === 'read') read.push(hashed.answer);
    else unread.push({ item: row.name, reason: hashed.reason });
  }
  return { read, unread };
}

async function namedGameFiles(
  adapter: Adapter, dataFolder: string, notFound: readonly NotFound[],
): Promise<{ found: readonly GameFile[]; unread: string }> {
  const paths = [...new Set(notFound.flatMap(({ gameFiles }) => gameFiles))];
  if (paths.length === 0) return { found: [], unread: '' };
  const found = await adapter.overriddenGameFiles(dataFolder, paths);
  return found.kind === 'read' ? { found: found.answer, unread: '' } : { found: [], unread: ` The game files could not be read: ${found.reason}.` };
}

const notSearched = (unread: readonly ItemRefusal<string>[]): string => {
  const named = unread.map(({ item, reason }) => `"${item}" (${reason})`).join(', ');
  return unread.length === 0 ? '' : ` Not searched for it: ${named}.`;
};

async function discardChanges(
  { client, adapter }: ModlistSourceCommandsDeps, mods: readonly string[], instance: DiscardInstance,
  onProgress: (status: DiscardStatus) => void,
): Promise<DiscardResult> {
  const { gameFolder } = instance;
  if (gameFolder.kind !== 'found') return { applied: false, refusal: 'Could not discard changes: the game folder was not found.', unfinished: [] };
  const read = await readMods(adapter, mods, gameFolder.dataFolder, instance, (mod) => { onProgress({ phase: 'ReadingFiles', mod }); });
  if (read.sent.length === 0) return { applied: true, landed: [], refused: read.refused };
  const sent = read.sent.map(({ name, folder, installationFiles }) => ({ name, folder, installationFiles }));
  const facts: DiscardFacts = {
    gameFiles: [...read.gameFiles], dataFolder: gameFolder.dataFolder, buildFolder: adapter.buildFolder,
    downloadsFolder: instance.paths.downloadsDir ?? null, downloadedFiles: [],
  };
  const discarding = (progress: ModlistProgress): void => { onProgress({ phase: 'Discarding', ...progress }); };
  const first = await discardOnce(client, sent, facts, discarding);
  if (!first.applied) return first;
  if (first.notFound.length === 0) return { applied: true, landed: first.landed, refused: [...first.refused, ...read.refused] };

  const retried = new Set(first.notFound.map(({ mod }) => mod));
  const named = await namedGameFiles(adapter, gameFolder.dataFolder, first.notFound);
  const archives = first.notFound.some(({ deltas }) => deltas)
    ? await downloadedArchives(adapter, instance.downloads, (file) => { onProgress({ phase: 'ReadingDownloadedFile', file }); })
    : { read: [], unread: [] };
  const gameFiles = new Map([...facts.gameFiles, ...named.found].map((file) => [file.path.toLowerCase(), file]));
  const second = await discardOnce(
    client, sent.filter((mod) => retried.has(mod.name)), { ...facts, gameFiles: [...gameFiles.values()], downloadedFiles: archives.read.map(wireFile) },
    discarding);
  if (!second.applied) return second;
  const unreadFor = new Map(second.notFound.map(({ mod, gameFiles: lacked, deltas }) =>
    [mod, (deltas ? notSearched(archives.unread) : '') + (lacked.length > 0 ? named.unread : '')]));
  return {
    applied: true,
    landed: [...first.landed, ...second.landed],
    refused: [
      ...first.refused.filter((refused) => !retried.has(refused.item)),
      ...second.refused.map((refused) => ({ ...refused, reason: refused.reason + (unreadFor.get(refused.item) ?? '') })),
      ...read.refused,
    ],
  };
}

function modsHolding(files: readonly string[], { paths }: Pick<DiscardInstance, 'paths'>): { mods: readonly string[]; refused: readonly ItemRefusal<string>[] } {
  const held = files.map((file) => ({ file, mod: [...paths.modDirs].find(([, folder]) => samePath(dirname(file), folder))?.[0] }));
  return {
    mods: [...new Set(held.flatMap(({ mod }) => (mod === undefined ? [] : [mod])))],
    refused: held.flatMap(({ file, mod }) => (mod === undefined ? [{ item: file, reason: 'it is not in a mod folder' }] : [])),
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
    /** Makes the repository and its ignore list, and stages nothing. Refused when the instance folder holds one already. */
    init: async ({ holdsRepository }: { readonly holdsRepository: boolean }): Promise<CommandResult<object>> => {
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
     *  here, naming why, and mEdit stages the rest. */
    stage: async (
      mods: readonly string[], instance: StageInstance, options: { onProgress?: (status: StageStatus) => void } = {},
    ): Promise<StageResult> => {
      const { gameFolder } = instance;
      if (gameFolder.kind !== 'found') return { applied: false, refusal: 'Could not stage: the game folder was not found.' };
      const { sent, gameFiles, refused } = await readMods(
        adapter, mods, gameFolder.dataFolder, instance, (mod) => options.onProgress?.({ phase: 'ReadingFiles', mod }));
      if (sent.length === 0) return { applied: true, landed: [], refused };
      const outcome = await client.stage(sent, {
        gameFiles: [...gameFiles], dataFolder: gameFolder.dataFolder, buildFolder: adapter.buildFolder, deltaShare: DELTA_SHARE,
      }, { onProgress: (progress) => options.onProgress?.({ phase: 'Staging', ...progress }) });
      return isRefused(outcome) ? { applied: false, refusal: outcome.message } : { applied: true, landed: outcome.landed, refused: [...outcome.refused, ...refused] };
    },

    discardChanges: (
      mods: readonly string[], instance: DiscardInstance, options: { onProgress?: (status: DiscardStatus) => void } = {},
    ): Promise<DiscardResult> => discardChanges(deps, mods, instance, (status) => options.onProgress?.(status)),

    modsHolding,
  };
}

export type ModlistSourceCommands = ReturnType<typeof modlistSourceCommands>;
