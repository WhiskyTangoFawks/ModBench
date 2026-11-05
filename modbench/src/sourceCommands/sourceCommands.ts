import {
  isRefused, type ModToVersionInGit, type VersionInGitOutcome, type VersionInGitProgress, type MEditClient, type SourceModIn, type WriteRefused,
} from '../client';
import { isPluginSourcePath, type InstanceAdapter } from '../instanceAdapter/instanceAdapter';
import { basename, dirname } from 'node:path';
import {
  buildFileIn, exclusionsOf, isBuildFileName, manifestIn, sourceModsOf, type BuildFile, type SourceMods,
} from '../manifestAdapter/manifestAdapter';
import { samePath } from '../symbolNames/symbolNames';
import { BUILD_FILE } from '../wire/sourceMod';
import { errorMessage } from '../ports/errorMessage';
import type { ItemRefusal } from '../ports/selectionOutcome';
import type { MoveToTrash } from '../ports/trash';
import { archiveVariants, buildSourceMod, type BuildPass, type BuildRefusal, type ModBuilt, type SourceBuildOutcome, type SourceModToBuild } from './buildSourceMod';
import { inModOrder } from './inModOrder';
import { modsPlaced, type MadeSourceFolder } from './newRepository';
import { modsPutWholeInGit } from './wholeFolderInGit';
import type { StepTasks } from './steps';
import { whyNotIndexed, type LoadOrderSnapshot } from './whyNotIndexed';

interface SourceCommandsDeps {
  client: Pick<MEditClient, 'build' | 'versionInGit' | 'getPluginIndexing' | 'onLoadOrderStatus'>;
  adapter: Pick<InstanceAdapter,
    'reading' | 'modOrder' | 'entryKey' | 'downloadedFile' | 'downloadedFilesHashed' | 'downloadedFileHolding' | 'installationFile' | 'metadataFilesInModFolder' | 'sourceFolder' | 'sourceModFolders'
    | 'gameRelease' | 'modFolderPath' | 'exclusionMark' | 'pathInFolder' | 'ownPath' | 'nexusFileAt' | 'gamePlaces' | 'gameFiles' | 'gameFilesTakenBy' | 'textHash' | 'filesIn'
    | 'originFileHash' | 'flaggedHash' | 'keepFlaggedHash' | 'folderValue' | 'writeFilesIn' | 'trashFileIn' | 'trashingReplaced' | 'fileStamp' | 'copyDownloadedFile' | 'putDownloadedFile' | 'unheldFolderValue'
    | 'repositoryOnDisk' | 'writeSourceModLines' | 'writeHeldWholeLines' | 'commitFolder' | 'foldersHeldWhole' | 'foldersInReach'>;
  /** Saves the unsaved documents under a folder that `picked` picks, as Text documents holds them; answers the paths VS
   *  Code left unsaved. */
  saveUnsaved: (folder: string, picked: (path: string) => boolean) => Promise<string[]>;
  loadOrderSnapshot: LoadOrderSnapshot;
  tasks: StepTasks;
  trash: MoveToTrash;
}

/** A mod's progress through version in git, reading its files here before mEdit's phases. */
export type InitProgress = Omit<VersionInGitProgress, 'phase'> & { phase?: VersionInGitProgress['phase'] | 'ReadingFiles' };

/** What version in git answers; `notes` is why a downloaded file could not be read whole, which leaves the packages right. */
export type InitializedSourceMod = VersionInGitOutcome & { readonly notes?: readonly string[] };

const unsavedRefusal = (mod: string, paths: readonly string[]): ItemRefusal<string> =>
  ({ item: mod, reason: `VS Code did not save its source: ${paths.join(', ')}` });

const builtFrom = (sourceFolder: string) => (path: string): boolean =>
  isPluginSourcePath(path) || (isBuildFileName(basename(path)) && samePath(dirname(path), sourceFolder));

type Adapter = SourceCommandsDeps['adapter'];

async function heldBuildFile(sourceFolder: string): Promise<BuildFile | { readonly reason: string }> {
  try {
    const held = await buildFileIn(sourceFolder);
    if (held === undefined) return { reason: `was not built: '${sourceFolder}' holds no build file.` };
    return 'refused' in held ? { reason: `was not built: ${held.refused}.` } : held.buildFile;
  } catch (err) {
    return { reason: `was not built: its build file could not be read: ${errorMessage(err)}.` };
  }
}

const readOrUndefined = <T>(folder: string | undefined, read: (folder: string) => Promise<T>): Promise<T | undefined> =>
  folder === undefined ? Promise.resolve(undefined) : read(folder).catch(() => undefined);

async function whyNoRepositoryBuilds(adapter: Adapter, mod: string, modFolder: string | undefined): Promise<string> {
  const [manifest, buildFile] = await Promise.all([
    readOrUndefined(modFolder, manifestIn), readOrUndefined(adapter.sourceFolder(mod), buildFileIn),
  ]);
  if (manifest !== undefined && 'refused' in manifest) return `was not built: ${manifest.refused}.`;
  if (buildFile === undefined) return 'no repository in the source folder builds it';
  return 'refused' in buildFile ? `was not built: ${buildFile.refused}.` : `its ${BUILD_FILE} is not staged in the instance repository: stage it.`;
}

// mods.md, A source mod, story 2: the build keeps the exclusions the folder holds, and those its manifest records, and the
// paths its manifest ignores (instance-repository.md, The manifest, story 11).
async function keptByBuildIn(adapter: Adapter, folder: string): Promise<{ exclude: readonly string[]; ignore: readonly string[] } | { readonly reason: string }> {
  try {
    const held = await manifestIn(folder);
    if (held !== undefined && 'refused' in held && !('olderFormat' in held)) return { reason: `was not built: ${held.refused}.` };
    const manifest = held !== undefined && 'manifest' in held ? held.manifest : undefined;
    return { exclude: exclusionsOf(manifest, await adapter.folderValue(folder)), ignore: manifest?.ignore ?? [] };
  } catch (err) {
    return { reason: `was not built: its folder could not be read: ${errorMessage(err)}.` };
  }
}

// source.md, Build, story 5: the mod is built from its plugin source and build file as VS Code shows them.
async function sourceModOf(
  { adapter, saveUnsaved }: Pick<SourceCommandsDeps, 'adapter' | 'saveUnsaved'>, mod: string, sourceMods: SourceMods,
): Promise<SourceModToBuild | ItemRefusal<string>> {
  const sourceFolder = sourceMods.folderOf(mod);
  const unsaved = sourceFolder === undefined ? [] : await saveUnsaved(sourceFolder, builtFrom(sourceFolder));
  return unsaved.length > 0 ? unsavedRefusal(mod, unsaved) : sourceModRead(adapter, mod, sourceMods);
}

async function sourceModRead(adapter: Adapter, mod: string, sourceMods: SourceMods): Promise<SourceModToBuild | ItemRefusal<string>> {
  const sourceFolder = sourceMods.folderOf(mod);
  const folder = await adapter.modFolderPath(mod);
  if (sourceFolder === undefined) return { item: mod, reason: await whyNoRepositoryBuilds(adapter, mod, folder) };
  if (folder === undefined) return { item: mod, reason: 'its name gives it no folder' };
  const buildFile = await heldBuildFile(sourceFolder);
  if ('reason' in buildFile) return { item: mod, reason: buildFile.reason };
  const kept = await keptByBuildIn(adapter, folder);
  if ('reason' in kept) return { item: mod, reason: kept.reason };
  return { name: mod, folder, ...kept, sourceFolder, buildFile };
}

/** The source mod gestures, bound to the mEdit client. mEdit reads each mod's plugins in the load order it holds,
 *  which lacks a snapshot still waiting to be put, so each first waits for the newest to reconcile. */
export function sourceCommands({ client, adapter, saveUnsaved, loadOrderSnapshot, tasks, trash }: SourceCommandsDeps) {
  const sourceModsNow = async (): Promise<SourceMods> =>
    sourceModsOf((await adapter.modOrder()).modFolders, await adapter.sourceModFolders(), (name) => adapter.entryKey({ kind: 'mod', name }));
  const toBuild = (sourceMods: SourceMods, asked: readonly string[], everySource: boolean): readonly string[] =>
    (everySource ? [...sourceMods.folders.keys()] : asked);
  return {
    /** A mod with plugin source VS Code leaves unsaved, no repository that builds it, or a folder, metadata or package the
     *  Instance adapter cannot answer is refused here, naming why, and mEdit builds the rest. */
    build: async (asked: readonly string[], everySource = false): Promise<SourceBuildOutcome | WriteRefused> => {
      const sourceMods = await sourceModsNow();
      const mods = toBuild(sourceMods, asked, everySource);
      const pass: BuildPass = {
        facts: { exclusionMark: adapter.exclusionMark, archives: archiveVariants(await adapter.gameRelease()) }, tasks: new Set(await tasks.labels()),
      };
      let landed: ModBuilt[] = [];
      const refused: BuildRefusal[] = [];
      const ordered = await inModOrder(adapter, mods);
      let previous: string | undefined;
      for (const [at, mod] of ordered.entries()) {
        const decided = await sourceModOf({ adapter, saveUnsaved }, mod, sourceMods);
        if ('reason' in decided) { refused.push(decided); continue; }
        // source.md, Build, story 11: this mod's script reads the plugins of the one built before it in the load order.
        const why = previous === undefined ? undefined : (await whyNotIndexed({ client, adapter, loadOrderSnapshot }, [previous])).get(previous);
        if (previous !== undefined && why !== undefined) {
          const waited = previous;
          landed = landed.map((built) => (built.mod === waited ? { ...built, failure: built.failure ?? `Its ${why}, so the mods after it were not built.` } : built));
          refused.push(...ordered.slice(at).map((item) => ({ item, reason: `was not built: ${waited}'s ${why}` })));
          break;
        }
        const outcome = await buildSourceMod({ client, adapter, tasks, trash }, decided, pass);
        if (isRefused(outcome)) {
          if (landed.length === 0 && refused.length === 0) return outcome;
          refused.push(...ordered.slice(at).map((item) => ({ item, reason: `was not built: ${outcome.message}` })));
          break;
        }
        if ('refusal' in outcome) { refused.push(outcome.refusal); previous = undefined; continue; }
        landed.push(outcome.landed);
        previous = mod;
      }
      return { landed, refused };
    },

    /** A mod that cannot go where `options.where` says is refused here, naming why. mEdit makes the rest source mods, and
     *  is not asked for a whole folder. */
    versionInGit: async (mods: readonly string[], options: VersionInGitOptions): Promise<InitializedSourceMod | WriteRefused> =>
      options.where === 'WholeFolder' ? modsPutWholeInGit(adapter, trash, { mods, ...options }) : modsVersionedInGit({ client, adapter }, mods, options),
  };
}

/** Where git holds a mod: its source folder in a repository of its own or the instance repository, or its whole folder in
 *  the instance repository. */
export type VersionInGitWhere = SourceModIn | 'WholeFolder';

type VersionInGitOptions = {
  readonly commit: boolean;
  readonly onProgress?: (status: InitProgress) => void;
} & ({ readonly where: SourceModIn } | { readonly where: 'WholeFolder' });

type VersionInGitDeps = Pick<SourceCommandsDeps, 'client' | 'adapter'>;

async function modsVersionedInGit(
  { client, adapter }: VersionInGitDeps, mods: readonly string[], { commit, where, onProgress }: Extract<VersionInGitOptions, { readonly where: SourceModIn }>,
): Promise<InitializedSourceMod | WriteRefused> {
  const sentOver = async (made: ReadonlyMap<string, MadeSourceFolder>): Promise<VersionInGitOutcome | WriteRefused> => {
    if (made.size === 0) return { landed: [], refused: [] };
    const sent: ModToVersionInGit[] = [...made].map(([name, { modFolder, sourceFolder }]) => ({ name, modFolder, sourceFolder, commit }));
    return client.versionInGit(sent, onProgress === undefined ? {} : { onProgress });
  };
  const placed = await modsPlaced(
    adapter, { mods, where, onProgress: (mod, modsDone, modsTotal) => onProgress?.({ mod, modsDone, modsTotal, phase: 'ReadingFiles' }) },
    sentOver, (outcome) => outcome.landed.map(({ mod }) => mod));
  if (isRefused(placed)) return placed;
  const { outcome, notMade, unfinished, notes } = placed;
  if (isRefused(outcome)) return outcome;
  const refused = [
    ...outcome.refused,
    ...[...notMade].map(([item, reason]) => ({ item, reason })),
    ...[...unfinished].map(([item, why]) => ({ item, reason: `was ${commit ? 'committed' : 'put under git'}, but ${why}.` })),
  ];
  return { landed: outcome.landed, refused, ...notes.length === 0 ? {} : { notes } };
}

export type SourceCommands = ReturnType<typeof sourceCommands>;
