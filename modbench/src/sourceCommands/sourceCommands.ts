import {
  isRefused, type DecompileAndCommitMod, type DecompileAndCommitOutcome, type DecompileAndCommitProgress, type MEditClient, type WriteRefused,
} from '../client';
import { isPluginSourcePath, type InstanceAdapter, type SourceMods } from '../instanceAdapter/instanceAdapter';
import { sourceManifestIn, type Manifest } from '../manifestAdapter/manifestAdapter';
import { errorMessage } from '../ports/errorMessage';
import type { ItemRefusal } from '../ports/selectionOutcome';
import { archiveVariants, buildSourceMod, type BuildPass, type BuildRefusal, type ModBuilt, type SourceBuildOutcome, type SourceModToBuild } from './buildSourceMod';
import { gameToHand, namedGameFolder } from './gameFolderFacts';
import { inModOrder } from './inModOrder';
import { folderManifestRemovedOrWhy, newRepositoryOf, type MadeRepository } from './newRepository';
import { downloadedNow, packagesRead } from './packagesRead';
import type { StepTasks } from './steps';
import { whyNotIndexed } from './whyNotIndexed';

interface SourceCommandsDeps {
  client: Pick<MEditClient, 'build' | 'decompileAndCommit' | 'getPluginIndexing' | 'onLoadOrderStatus'>;
  adapter: Pick<InstanceAdapter,
    'reading' | 'modOrder' | 'entryKey' | 'downloadedFile' | 'installationFile' | 'modMetadata' | 'metadataFilesInModFolder' | 'sourceFolder' | 'sourceMods'
    | 'gameRelease' | 'modFolderPath' | 'exclusionMark' | 'sourceHost' | 'gamePlaces' | 'gameFiles' | 'gameFilesTakenBy' | 'textHash' | 'filesIn'
    | 'originFileHash' | 'writeFilesIn' | 'keepPackageEntries'>;
  /** Saves the unsaved plugin source under a folder, as Text documents holds it; answers the paths VS Code left unsaved. */
  saveUnsaved: (folder: string, isPluginSource: (path: string) => boolean) => Promise<string[]>;
  tasks: StepTasks;
}

/** A mod's progress through decompile and commit, reading its files here before mEdit's phases. */
export type DecompileProgress = Omit<DecompileAndCommitProgress, 'phase'> & { phase?: DecompileAndCommitProgress['phase'] | 'ReadingFiles' };

const unsavedRefusal = (mod: string, paths: readonly string[]): ItemRefusal<string> =>
  ({ item: mod, reason: `VS Code did not save its plugin source: ${paths.join(', ')}` });

export const metadataUnreadable = (reason: string): string => `its metadata could not be read: ${reason}`;

type Adapter = SourceCommandsDeps['adapter'];

function noRepositoryRefusal(adapter: Adapter, mod: string, sourceMods: SourceMods): ItemRefusal<string> {
  const own = adapter.sourceFolder(mod);
  const claimed = own === undefined || sourceMods.folderOf(mod) !== undefined ? undefined : sourceMods.claimedOutput(own);
  if (claimed === undefined) return { item: mod, reason: 'no repository in the source folder builds it' };
  const sameMod = adapter.entryKey({ kind: 'mod', name: mod }) === adapter.entryKey({ kind: 'mod', name: claimed });
  return { item: mod, reason: sameMod ? `its repository's manifest is not named for its output "${claimed}"` : `its folder is "${mod}", but its repository's manifest builds "${claimed}"` };
}

async function heldSourceManifest(sourceFolder: string): Promise<Manifest | { readonly reason: string }> {
  try {
    const held = await sourceManifestIn(sourceFolder);
    if (held === undefined) return { reason: `was not built: '${sourceFolder}' holds no manifest.` };
    return 'refused' in held ? { reason: `was not built: ${held.refused}.` } : held.manifest;
  } catch (err) {
    return { reason: `was not built: its manifest could not be read: ${errorMessage(err)}.` };
  }
}

// mods.md, Build, story 5: the mod is built from the plugin source as VS Code shows it.
async function sourceModOf(
  { adapter, saveUnsaved }: Pick<SourceCommandsDeps, 'adapter' | 'saveUnsaved'>, mod: string, sourceMods: SourceMods, pass: BuildPass,
): Promise<SourceModToBuild | ItemRefusal<string>> {
  const sourceFolder = sourceMods.folderOf(mod);
  const unsaved = sourceFolder === undefined ? [] : await saveUnsaved(sourceFolder, isPluginSourcePath);
  if (unsaved.length > 0) return unsavedRefusal(mod, unsaved);
  const folder = await adapter.modFolderPath(mod);
  const metadata = await adapter.modMetadata(mod);
  const host = sourceFolder === undefined ? undefined : await adapter.sourceHost(sourceFolder);
  if (sourceFolder === undefined || host === undefined) return noRepositoryRefusal(adapter, mod, sourceMods);
  if (folder === undefined) return { item: mod, reason: 'its name gives it no folder' };
  if (metadata.kind === 'unreadable') return { item: mod, reason: metadataUnreadable(metadata.reason) };
  if (host.kind === 'unreadable') return { item: mod, reason: `its remote could not be read: ${host.reason}` };
  const manifest = await heldSourceManifest(sourceFolder);
  if ('reason' in manifest) return { item: mod, reason: manifest.reason };
  const game = await namedGameFolder(adapter, await adapter.gameRelease());
  const packages = await packagesRead(adapter, manifest, { downloaded: await downloadedNow(adapter, manifest), game, tasks: pass.tasks });
  return { name: mod, folder, sourceFolder, manifest, packages, version: metadata.answer.version, isSubmodule: host.answer.kind === 'host' };
}

/** The source mod gestures, bound to the mEdit client. mEdit reads each mod's plugins in the load order it holds,
 *  which lacks a snapshot still waiting to be put, so each first waits for the newest to reconcile. */
export function sourceCommands({ client, adapter, saveUnsaved, tasks }: SourceCommandsDeps) {
  return {
    /** A mod with plugin source VS Code leaves unsaved, no repository that builds it, or a folder, metadata or package the
     *  Instance adapter cannot answer is refused here, naming why, and mEdit builds the rest. */
    build: async (asked: readonly string[], everySource = false): Promise<SourceBuildOutcome | WriteRefused> => {
      const sourceMods = await adapter.sourceMods();
      const mods = everySource ? [...sourceMods.folders.keys()] : asked;
      const pass: BuildPass = {
        facts: { exclusionMark: adapter.exclusionMark, archives: archiveVariants(await adapter.gameRelease()) }, tasks: new Set(await tasks.labels()),
      };
      let landed: ModBuilt[] = [];
      const refused: BuildRefusal[] = [];
      const ordered = await inModOrder(adapter, mods);
      let previous: string | undefined;
      for (const [at, mod] of ordered.entries()) {
        const decided = await sourceModOf({ adapter, saveUnsaved }, mod, sourceMods, pass);
        if ('reason' in decided) { refused.push(decided); continue; }
        // mods.md, Build, story 11: this mod's script reads the plugins of the one built before it in the load order.
        const why = previous === undefined ? undefined : (await whyNotIndexed({ client, adapter }, [previous])).get(previous);
        if (previous !== undefined && why !== undefined) {
          const waited = previous;
          landed = landed.map((built) => (built.mod === waited ? { ...built, failure: built.failure ?? `Its ${why}, so the mods after it were not built.` } : built));
          refused.push(...ordered.slice(at).map((item) => ({ item, reason: `was not built: ${waited}'s ${why}` })));
          break;
        }
        const outcome = await buildSourceMod({ client, adapter, tasks }, decided, pass);
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
     *  here, naming why, and mEdit decompiles and commits the rest; each that lands loses its folder's manifest. */
    decompileAndCommit: async (
      mods: readonly string[], options: { onProgress?: (status: DecompileProgress) => void } = {},
    ): Promise<DecompileAndCommitOutcome | WriteRefused> => {
      const made = new Map<string, MadeRepository>();
      const refused: ItemRefusal<string>[] = [];
      const game = await gameToHand(adapter, await adapter.sourceMods());
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
      const notRemoved: ItemRefusal<string>[] = [];
      for (const { mod } of outcome.landed) {
        const repository = made.get(mod);
        const why = repository === undefined ? undefined : await folderManifestRemovedOrWhy(repository);
        if (why !== undefined) notRemoved.push({ item: mod, reason: `was decompiled and committed, but ${why}` });
      }
      return { landed: outcome.landed, refused: [...outcome.refused, ...refused, ...notRemoved] };
    },
  };
}

export type SourceCommands = ReturnType<typeof sourceCommands>;
