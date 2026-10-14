import {
  isRefused, type RestoreFacts, type RestoreMod, type RestoreOutcome, type MEditClient, type ModlistProgress, type NotFound, type UpdateManifestMod,
  type UpdateManifestOutcome, type ModlistCallOptions,
} from '../client';
import type { CommandResult } from '../coreLib/commandResult';
import {
  isArchiveName, type GameFile, type GameFolder, type InstallationFile, type InstanceAdapter, type OverriddenGameFiles,
} from '../instanceAdapter/instanceAdapter';
import { errorMessage } from '../ports/errorMessage';
import { refuse } from '../ports/refuse';
import type { ItemRefusal } from '../ports/selectionOutcome';

const DELTA_SHARE = 0.5;

type Adapter = Pick<InstanceAdapter,
  'installationFiles' | 'downloadedFile' | 'managerFilesInModFolder' | 'modFolderPath' | 'overriddenGameFiles' | 'gameFilesOverriddenBy' | 'buildFolder'
  | 'writeIgnoreList' | 'removeIgnoreList'>;

interface ModlistSourceCommandsDeps {
  client: Pick<MEditClient, 'updateManifest' | 'restoreFromManifest'>;
  adapter: Adapter;
  instanceRoot: string;
  /** VS Code's git makes the instance folder a repository. */
  makeRepository: () => Promise<void>;
}

/** The slice of the instance value update manifest reads: where the game's files are. */
export interface UpdateManifestInstance {
  readonly gameFolder: GameFolder;
}

export interface RestoreInstance extends UpdateManifestInstance {
  readonly paths: { readonly downloadsDir: string | undefined };
  readonly downloads: { readonly kind: 'listed'; readonly rows: readonly { readonly name: string; readonly path: string }[] } | { readonly kind: 'unresolved' };
}

/** What update manifest answers: each mod updated or refused, and each entry a mod folder's listing skipped, or the
 *  whole gesture refused, as a message to show. */
export type UpdateManifestResult = ({ applied: true; notes: readonly string[] } & UpdateManifestOutcome) | { applied: false; refusal: string };

/** Where update manifest is: the Instance adapter reading a mod's files, or mEdit updating manifests. */
export type UpdateManifestStatus = { readonly phase: 'ReadingFiles'; readonly mod: string } | ({ readonly phase: 'Updating' } & ModlistProgress);

export type RestoreResult =
  | ({ applied: true } & Omit<RestoreOutcome, 'notFound'>)
  | { applied: false; refusal: string; unfinished: readonly string[] };

export type RestoreStatus =
  | { readonly phase: 'ReadingFiles'; readonly mod: string }
  | ({ readonly phase: 'Restoring' } & ModlistProgress)
  | { readonly phase: 'ReadingDownloadedFile'; readonly file: string };

interface ReadMods {
  readonly sent: readonly UpdateManifestMod[];
  readonly gameFiles: readonly GameFile[];
  readonly refused: readonly ItemRefusal<string>[];
  readonly notes: readonly string[];
}

const wireFile = (file: InstallationFile): UpdateManifestMod['installationFiles'][number] => ({ ...file, entries: [...file.entries] });

async function readMod(
  adapter: Adapter, mod: string, dataFolder: string,
): Promise<{ read: UpdateManifestMod; overridden: OverriddenGameFiles } | { refusal: string }> {
  const folder = await adapter.modFolderPath(mod);
  if (folder === undefined) return { refusal: 'its name gives it no folder' };
  const installed = await adapter.installationFiles(mod);
  if (installed.kind === 'unreadable') return { refusal: installed.reason };
  const overridden = await adapter.gameFilesOverriddenBy(dataFolder, mod);
  if (overridden.kind === 'unreadable') return { refusal: overridden.reason };
  return {
    read: { name: mod, folder, installationFiles: installed.answer.map(wireFile), committedFiles: [...adapter.managerFilesInModFolder] },
    overridden: overridden.answer,
  };
}

async function readMods(
  adapter: Adapter, mods: readonly string[], dataFolder: string, { onProgress, signal }: ModlistCallOptions<{ phase: 'ReadingFiles'; mod: string }>,
): Promise<ReadMods> {
  const sent: UpdateManifestMod[] = [];
  const gameFiles = new Map<string, GameFile>();
  const refused: ItemRefusal<string>[] = [];
  const notes: string[] = [];
  for (const mod of mods) {
    if (signal?.aborted) break;
    onProgress?.({ phase: 'ReadingFiles', mod });
    const read = await readMod(adapter, mod, dataFolder);
    if ('refusal' in read) { refused.push({ item: mod, reason: read.refusal }); continue; }
    sent.push(read.read);
    for (const file of read.overridden.gameFiles) gameFiles.set(file.path.toLowerCase(), file);
    notes.push(...read.overridden.notes.map((note) => `${mod}: ${note}`));
  }
  return { sent: signal?.aborted ? [] : sent, gameFiles: [...gameFiles.values()], refused, notes };
}

async function restoreOnce(
  client: ModlistSourceCommandsDeps['client'], mods: readonly RestoreMod[], facts: RestoreFacts, { onProgress, signal }: ModlistCallOptions,
): Promise<({ applied: true } & RestoreOutcome) | Extract<RestoreResult, { applied: false }>> {
  let done = 0;
  const outcome = await client.restoreFromManifest(mods, facts, {
    onProgress: (progress) => {
      if (progress.mod) done = progress.modsDone;
      onProgress?.(progress);
    },
    signal,
  });
  return isRefused(outcome)
    ? { applied: false, refusal: outcome.message, unfinished: mods.slice(done).map((mod) => mod.name) }
    : { applied: true, ...outcome };
}

async function downloadedArchives(
  adapter: Adapter, downloads: RestoreInstance['downloads'], onReading: (file: string) => void,
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

function cancelRefused(...latestFirst: (string | undefined)[]): { cancelRefusal?: string } {
  const [cancelRefusal] = latestFirst.filter((refusal) => refusal !== undefined);
  return cancelRefusal === undefined ? {} : { cancelRefusal };
}

async function restoreFromManifest(
  { client, adapter }: ModlistSourceCommandsDeps, mods: readonly string[], instance: RestoreInstance,
  { onProgress, signal }: ModlistCallOptions<RestoreStatus>,
): Promise<RestoreResult> {
  const { gameFolder } = instance;
  if (gameFolder.kind !== 'found') return { applied: false, refusal: 'Could not restore from manifest: the game folder was not found.', unfinished: [] };
  const read = await readMods(adapter, mods, gameFolder.dataFolder, { onProgress, signal });
  if (read.sent.length === 0) return { applied: true, landed: [], refused: read.refused };
  const sent = read.sent.map(({ name, folder, installationFiles }) => ({ name, folder, installationFiles }));
  const facts: RestoreFacts = {
    gameFiles: [...read.gameFiles], dataFolder: gameFolder.dataFolder, buildFolder: adapter.buildFolder,
    downloadsFolder: instance.paths.downloadsDir ?? null, downloadedFiles: [],
  };
  const restoring = { onProgress: (progress: ModlistProgress): void => { onProgress?.({ phase: 'Restoring', ...progress }); }, signal };
  const first = await restoreOnce(client, sent, facts, restoring);
  if (!first.applied) return first;
  const { cancelRefusal } = first;
  if (first.notFound.length === 0 || signal?.aborted) {
    return { applied: true, landed: first.landed, refused: [...first.refused, ...read.refused], ...cancelRefused(cancelRefusal) };
  }

  const retried = new Set(first.notFound.map(({ mod }) => mod));
  const named = await namedGameFiles(adapter, gameFolder.dataFolder, first.notFound);
  const archives = first.notFound.some(({ deltas }) => deltas)
    ? await downloadedArchives(adapter, instance.downloads, (file) => { onProgress?.({ phase: 'ReadingDownloadedFile', file }); })
    : { read: [], unread: [] };
  const gameFiles = new Map([...facts.gameFiles, ...named.found].map((file) => [file.path.toLowerCase(), file]));
  const second = await restoreOnce(
    client, sent.filter((mod) => retried.has(mod.name)), { ...facts, gameFiles: [...gameFiles.values()], downloadedFiles: archives.read.map(wireFile) },
    restoring);
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
      mods: readonly string[], instance: UpdateManifestInstance, { onProgress, signal }: ModlistCallOptions<UpdateManifestStatus> = {},
    ): Promise<UpdateManifestResult> => {
      const { gameFolder } = instance;
      if (gameFolder.kind !== 'found') return { applied: false, refusal: 'Could not update manifests: the game folder was not found.' };
      const { sent, gameFiles, refused, notes } = await readMods(adapter, mods, gameFolder.dataFolder, { onProgress, signal });
      if (sent.length === 0) return { applied: true, landed: [], refused, notes };
      const outcome = await client.updateManifest(sent, {
        gameFiles: [...gameFiles], dataFolder: gameFolder.dataFolder, buildFolder: adapter.buildFolder, deltaShare: DELTA_SHARE,
      }, { onProgress: (progress) => onProgress?.({ phase: 'Updating', ...progress }), signal });
      return isRefused(outcome) ? { applied: false, refusal: outcome.message } : { applied: true, ...outcome, refused: [...outcome.refused, ...refused], notes };
    },

    restoreFromManifest: (
      mods: readonly string[], instance: RestoreInstance, options: ModlistCallOptions<RestoreStatus> = {},
    ): Promise<RestoreResult> => restoreFromManifest(deps, mods, instance, options),
  };
}

export type ModlistSourceCommands = ReturnType<typeof modlistSourceCommands>;
