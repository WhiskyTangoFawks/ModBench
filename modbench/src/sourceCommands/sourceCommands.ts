import {
  isRefused, type DecompileAndCommitMod, type DecompileAndCommitOutcome, type DecompileAndCommitProgress, type MEditClient, type WriteRefused,
} from '../client';
import { isPluginSourcePath, type InstanceAdapter } from '../instanceAdapter/instanceAdapter';
import {
  buildFileIn, exclusionsOf, folderAgainst, lineAtFolderPath, manifestIn, sourceModsOf, type BuildFile, type Manifest, type SourceMods,
} from '../manifestAdapter/manifestAdapter';
import { errorMessage } from '../ports/errorMessage';
import type { ItemRefusal } from '../ports/selectionOutcome';
import type { MoveToTrash } from '../ports/trash';
import { archiveVariants, buildSourceMod, type BuildPass, type BuildRefusal, type ModBuilt, type SourceBuildOutcome, type SourceModToBuild } from './buildSourceMod';
import { gameToHand, namedGameFolder } from './gameFolderFacts';
import { inModOrder } from './inModOrder';
import { foldersNotLinked, newRepositoryOf, type MadeRepository } from './newRepository';
import { downloadedNow, packagesRead } from './packagesRead';
import type { StepTasks } from './steps';
import { whyNotIndexed } from './whyNotIndexed';

interface SourceCommandsDeps {
  client: Pick<MEditClient, 'build' | 'decompileAndCommit' | 'getPluginIndexing' | 'onLoadOrderStatus'>;
  adapter: Pick<InstanceAdapter,
    'reading' | 'modOrder' | 'entryKey' | 'downloadedFile' | 'installationFile' | 'modMetadata' | 'metadataFilesInModFolder' | 'sourceFolder' | 'sourceRepositories'
    | 'gameRelease' | 'modFolderPath' | 'exclusionMark' | 'sourceHost' | 'gamePlaces' | 'gameFiles' | 'gameFilesTakenBy' | 'textHash' | 'filesIn'
    | 'originFileHash' | 'fileStamp' | 'packageEntries' | 'writeFilesIn' | 'trashFileIn'>;
  /** Saves the unsaved plugin source under a folder, as Text documents holds it; answers the paths VS Code left unsaved. */
  saveUnsaved: (folder: string, isPluginSource: (path: string) => boolean) => Promise<string[]>;
  tasks: StepTasks;
  trash: MoveToTrash;
}

/** In each source mod's folder, each file that differs from its manifest, which build overwrites or sends to the trash.
 *  A mod whose files could not be read is refused. */
export interface WhatBuildDestroys {
  readonly mods: readonly string[];
  readonly destroys: readonly { readonly mod: string; readonly files: readonly string[] }[];
  readonly refused: readonly ItemRefusal<string>[];
}

/** A mod's progress through decompile and commit, reading its files here before mEdit's phases. */
export type DecompileProgress = Omit<DecompileAndCommitProgress, 'phase'> & { phase?: DecompileAndCommitProgress['phase'] | 'ReadingFiles' };

const unsavedRefusal = (mod: string, paths: readonly string[]): ItemRefusal<string> =>
  ({ item: mod, reason: `VS Code did not save its plugin source: ${paths.join(', ')}` });

export const metadataUnreadable = (reason: string): string => `its metadata could not be read: ${reason}`;

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

// mods.md, A source mod, story 2: the build keeps the exclusions the folder holds, and those its manifest records.
async function exclusionsIn(adapter: Adapter, folder: string): Promise<readonly string[] | { readonly reason: string }> {
  try {
    const held = await manifestIn(folder);
    if (held !== undefined && 'refused' in held) return { reason: `was not built: ${held.refused}.` };
    return exclusionsOf(held?.manifest, await adapter.filesIn(folder), adapter.exclusionMark);
  } catch (err) {
    return { reason: `was not built: its folder could not be read: ${errorMessage(err)}.` };
  }
}

const NO_LINE: Manifest = { packages: [], exclude: [], archives: [], files: [] };

// mods.md, A source mod, story 4: each file whose bytes differ from its line at the path the build writes it, and each
// file no line names. A manifest that cannot be read refuses the build, which writes nothing.
async function differingIn(adapter: Adapter, folder: string): Promise<string[]> {
  const read = await manifestIn(folder);
  if (read !== undefined && 'refused' in read) return [];
  const manifest = read?.manifest ?? NO_LINE;
  const exclude = exclusionsOf(manifest, await adapter.filesIn(folder), adapter.exclusionMark);
  const lines = manifest.files.map((line) => lineAtFolderPath({ ...manifest, exclude }, line, adapter.exclusionMark));
  const against = await folderAgainst({ ...manifest, files: lines }, folder, adapter);
  const differing = against.lines.flatMap(({ onDisk, holdsItsBytes }) => (holdsItsBytes === false && onDisk !== undefined ? [onDisk] : []));
  return [...differing, ...against.namedByNoLine].sort();
}

// mods.md, Build, story 5: the mod is built from the plugin source as VS Code shows it.
async function sourceModOf(
  { adapter, saveUnsaved }: Pick<SourceCommandsDeps, 'adapter' | 'saveUnsaved'>, mod: string, sourceMods: SourceMods,
): Promise<SourceModToBuild | ItemRefusal<string>> {
  const sourceFolder = sourceMods.folderOf(mod);
  const unsaved = sourceFolder === undefined ? [] : await saveUnsaved(sourceFolder, isPluginSourcePath);
  if (unsaved.length > 0) return unsavedRefusal(mod, unsaved);
  const folder = await adapter.modFolderPath(mod);
  const metadata = await adapter.modMetadata(mod);
  const host = sourceFolder === undefined ? undefined : await adapter.sourceHost(sourceFolder);
  if (sourceFolder === undefined || host === undefined) return { item: mod, reason: await noRepository(folder) };
  if (folder === undefined) return { item: mod, reason: 'its name gives it no folder' };
  if (metadata.kind === 'unreadable') return { item: mod, reason: metadataUnreadable(metadata.reason) };
  if (host.kind === 'unreadable') return { item: mod, reason: `its remote could not be read: ${host.reason}` };
  const buildFile = await heldBuildFile(sourceFolder);
  if ('reason' in buildFile) return { item: mod, reason: buildFile.reason };
  const exclude = await exclusionsIn(adapter, folder);
  if ('reason' in exclude) return { item: mod, reason: exclude.reason };
  const game = await namedGameFolder(adapter, await adapter.gameRelease());
  const packages = await packagesRead(adapter, buildFile, { downloaded: await downloadedNow(adapter, buildFile), game });
  return { name: mod, folder, exclude, sourceFolder, buildFile, packages, version: metadata.answer.version, isSubmodule: host.answer.kind === 'host' };
}

/** The source mod gestures, bound to the mEdit client. mEdit reads each mod's plugins in the load order it holds,
 *  which lacks a snapshot still waiting to be put, so each first waits for the newest to reconcile. */
export function sourceCommands({ client, adapter, saveUnsaved, tasks, trash }: SourceCommandsDeps) {
  const sourceModsNow = async (): Promise<SourceMods> =>
    sourceModsOf((await adapter.modOrder()).modFolders, await adapter.sourceRepositories(), (name) => adapter.entryKey({ kind: 'mod', name }));
  return {
    whatBuildDestroys: async (asked: readonly string[], everySource = false): Promise<WhatBuildDestroys> => {
      const sourceMods = await sourceModsNow();
      const mods = everySource ? [...sourceMods.folders.keys()] : asked;
      const destroys: { mod: string; files: string[] }[] = [];
      const refused: ItemRefusal<string>[] = [];
      for (const mod of mods) {
        const folder = sourceMods.folderOf(mod) === undefined ? undefined : await adapter.modFolderPath(mod);
        if (folder === undefined) continue;
        try {
          const files = await differingIn(adapter, folder);
          if (files.length > 0) destroys.push({ mod, files });
        } catch (err) {
          refused.push({ item: mod, reason: `was not built: a file could not be read: ${errorMessage(err)}.` });
        }
      }
      return { mods, destroys, refused };
    },


    /** A mod with plugin source VS Code leaves unsaved, no repository that builds it, or a folder, metadata or package the
     *  Instance adapter cannot answer is refused here, naming why, and mEdit builds the rest. */
    build: async (asked: readonly string[], everySource = false): Promise<SourceBuildOutcome | WriteRefused> => {
      const sourceMods = await sourceModsNow();
      const mods = everySource ? [...sourceMods.folders.keys()] : asked;
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
        // mods.md, Build, story 11: this mod's script reads the plugins of the one built before it in the load order.
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

    /** A mod whose name gives it no source folder, or whose files, installation file or metadata cannot be read, is refused
     *  here, naming why, and mEdit decompiles and commits the rest. */
    decompileAndCommit: async (
      mods: readonly string[], options: { onProgress?: (status: DecompileProgress) => void } = {},
    ): Promise<DecompileAndCommitOutcome | WriteRefused> => {
      const made = new Map<string, MadeRepository>();
      const refused: ItemRefusal<string>[] = [];
      const sourceMods = await sourceModsNow();
      const game = await gameToHand(adapter, sourceMods);
      for (const [at, mod] of mods.entries()) {
        options.onProgress?.({ mod, modsDone: at, modsTotal: mods.length, phase: 'ReadingFiles' });
        const decided = await newRepositoryOf(adapter, mod, game);
        if ('refusal' in decided) refused.push({ item: mod, reason: decided.refusal });
        else made.set(mod, decided);
      }
      if (made.size === 0) return { landed: [], refused };
      const sent: DecompileAndCommitMod[] = [...made].map(([name, { repository }]) => ({ name, repository }));
      const outcome = await client.decompileAndCommit(sent, options);
      if (isRefused(outcome)) return outcome;
      const notLinked = [...await foldersNotLinked(adapter, made, outcome.landed.map(({ mod }) => mod))].map(([item, why]) => ({ item, reason: `was committed, but ${why}.` }));
      return { landed: outcome.landed, refused: [...outcome.refused, ...refused, ...notLinked] };
    },
  };
}

export type SourceCommands = ReturnType<typeof sourceCommands>;
