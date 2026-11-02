import {
  isRefused, type ModToInitSourceMod, type InitSourceModOutcome, type InitSourceModProgress, type MEditClient, type WriteRefused,
} from '../client';
import { isPluginSourcePath, type InstanceAdapter } from '../instanceAdapter/instanceAdapter';
import {
  buildFileIn, exclusionsOf, manifestIn, sourceModsOf, type BuildFile, type SourceMods,
} from '../manifestAdapter/manifestAdapter';
import { errorMessage } from '../ports/errorMessage';
import type { ItemRefusal } from '../ports/selectionOutcome';
import type { MoveToTrash } from '../ports/trash';
import { archiveVariants, buildSourceMod, type BuildPass, type BuildRefusal, type ModBuilt, type SourceBuildOutcome, type SourceModToBuild } from './buildSourceMod';
import { gameToHand } from './gameFolderFacts';
import { inModOrder } from './inModOrder';
import { downloadedPackagesOf, foldersNotLinked, newRepositoryOf, type MadeRepository } from './newRepository';
import type { StepTasks } from './steps';
import { whyNotIndexed } from './whyNotIndexed';

interface SourceCommandsDeps {
  client: Pick<MEditClient, 'build' | 'initSourceMod' | 'getPluginIndexing' | 'onLoadOrderStatus'>;
  adapter: Pick<InstanceAdapter,
    'reading' | 'modOrder' | 'entryKey' | 'downloadedFile' | 'downloadedFilesHashed' | 'downloadedFileHolding' | 'installationFile' | 'metadataFilesInModFolder' | 'sourceFolder' | 'sourceRepositories'
    | 'gameRelease' | 'modFolderPath' | 'exclusionMark' | 'pathInFolder' | 'ownPath' | 'nexusFileAt' | 'gamePlaces' | 'gameFiles' | 'gameFilesTakenBy' | 'textHash' | 'filesIn'
    | 'originFileHash' | 'flaggedHash' | 'keepFlaggedHash' | 'folderValue' | 'writeFilesIn' | 'trashFileIn' | 'trashingReplaced' | 'fileStamp' | 'copyDownloadedFile' | 'putDownloadedFile' | 'sourceFolderValue'>;
  /** Saves the unsaved plugin source under a folder, as Text documents holds it; answers the paths VS Code left unsaved. */
  saveUnsaved: (folder: string, isPluginSource: (path: string) => boolean) => Promise<string[]>;
  tasks: StepTasks;
  trash: MoveToTrash;
}

/** A mod's progress through init source mod, reading its files here before mEdit's phases. */
export type InitProgress = Omit<InitSourceModProgress, 'phase'> & { phase?: InitSourceModProgress['phase'] | 'ReadingFiles' };

/** What init source mod answers; `notes` is why a downloaded file could not be read whole, which leaves the packages right. */
export type InitializedSourceMod = InitSourceModOutcome & { readonly notes?: readonly string[] };

const unsavedRefusal = (mod: string, paths: readonly string[]): ItemRefusal<string> =>
  ({ item: mod, reason: `VS Code did not save its plugin source: ${paths.join(', ')}` });

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

// A manifest that cannot be read names no repository, and says why.
async function noRepository(folder: string | undefined): Promise<string> {
  const held = folder === undefined ? undefined : await manifestIn(folder).catch(() => undefined);
  return held !== undefined && 'refused' in held ? `was not built: ${held.refused}.` : 'no repository in the source folder builds it';
}

// mods.md, A source mod, story 2: the build keeps the exclusions the folder holds, and those its manifest records, and the
// paths its manifest ignores (modlist-repository.md, The manifest, story 11).
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

// source.md, Build, story 5: the mod is built from the plugin source as VS Code shows it.
async function sourceModOf(
  { adapter, saveUnsaved }: Pick<SourceCommandsDeps, 'adapter' | 'saveUnsaved'>, mod: string, sourceMods: SourceMods,
): Promise<SourceModToBuild | ItemRefusal<string>> {
  const sourceFolder = sourceMods.folderOf(mod);
  const unsaved = sourceFolder === undefined ? [] : await saveUnsaved(sourceFolder, isPluginSourcePath);
  return unsaved.length > 0 ? unsavedRefusal(mod, unsaved) : sourceModRead(adapter, mod, sourceMods);
}

async function sourceModRead(adapter: Adapter, mod: string, sourceMods: SourceMods): Promise<SourceModToBuild | ItemRefusal<string>> {
  const sourceFolder = sourceMods.folderOf(mod);
  const folder = await adapter.modFolderPath(mod);
  if (sourceFolder === undefined) return { item: mod, reason: await noRepository(folder) };
  if (folder === undefined) return { item: mod, reason: 'its name gives it no folder' };
  const buildFile = await heldBuildFile(sourceFolder);
  if ('reason' in buildFile) return { item: mod, reason: buildFile.reason };
  const kept = await keptByBuildIn(adapter, folder);
  if ('reason' in kept) return { item: mod, reason: kept.reason };
  return { name: mod, folder, ...kept, sourceFolder, buildFile };
}

/** The source mod gestures, bound to the mEdit client. mEdit reads each mod's plugins in the load order it holds,
 *  which lacks a snapshot still waiting to be put, so each first waits for the newest to reconcile. */
export function sourceCommands({ client, adapter, saveUnsaved, tasks, trash }: SourceCommandsDeps) {
  const sourceModsNow = async (): Promise<SourceMods> =>
    sourceModsOf((await adapter.modOrder()).modFolders, await adapter.sourceRepositories(), (name) => adapter.entryKey({ kind: 'mod', name }));
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
        const why = previous === undefined ? undefined : (await whyNotIndexed({ client, adapter }, [previous])).get(previous);
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

    /** A mod whose name gives it no source folder, or whose files or metadata cannot be read, is refused here, naming why,
     *  and mEdit makes the rest source mods. */
    initSourceMod: async (
      mods: readonly string[], { commit, onProgress }: { commit: boolean; onProgress?: (status: InitProgress) => void },
    ): Promise<InitializedSourceMod | WriteRefused> => {
      const made = new Map<string, MadeRepository>();
      const refused: ItemRefusal<string>[] = [];
      const sourceMods = await sourceModsNow();
      const game = await gameToHand(adapter, sourceMods);
      const downloaded = await downloadedPackagesOf(adapter);
      const notes = downloaded.notes.length > 0 ? { notes: downloaded.notes } : {};
      for (const [at, mod] of mods.entries()) {
        onProgress?.({ mod, modsDone: at, modsTotal: mods.length, phase: 'ReadingFiles' });
        const decided = await newRepositoryOf(adapter, mod, game, downloaded.files);
        if ('refusal' in decided) refused.push({ item: mod, reason: decided.refusal });
        else made.set(mod, decided);
      }
      if (made.size === 0) return { landed: [], refused, ...notes };
      const sent: ModToInitSourceMod[] = [...made].map(([name, { modFolder, repository }]) => ({ name, modFolder, repository, commit }));
      const outcome = await client.initSourceMod(sent, onProgress === undefined ? {} : { onProgress });
      if (isRefused(outcome)) return outcome;
      const notLinked = [...await foldersNotLinked(adapter, made, outcome.landed.map(({ mod }) => mod))].map(([item, why]) => ({ item, reason: `was ${commit ? 'committed' : 'initialized'}, but ${why}.` }));
      return { landed: outcome.landed, refused: [...outcome.refused, ...refused, ...notLinked], ...notes };
    },
  };
}

export type SourceCommands = ReturnType<typeof sourceCommands>;
