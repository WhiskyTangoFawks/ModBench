import {
  isRefused, type BuildFacts, type BuildMod, type BuildOutcome, type DecompileAndCommitMod, type DecompileAndCommitOutcome, type DecompileAndCommitProgress, type MEditClient, type WriteRefused,
} from '../client';
import { isPluginSourcePath, type InstanceAdapter, type SourceMods } from '../instanceAdapter/instanceAdapter';
import type { ItemRefusal } from '../ports/selectionOutcome';
import { ba2VersionsOf } from '../tables/gamePaths';
import { inModOrder } from './inModOrder';
import { namedDownloadedFiles, wireFile } from './namedDownloadedFiles';
import { gameFilesOf, gameToHand, namedGameFiles, namedGameFolder, NONE_HELD, wireGameFolder } from './gameFolderFacts';
import type { StepTasks } from './steps';
import { whyNotIndexed } from './whyNotIndexed';

interface SourceCommandsDeps {
  client: Pick<MEditClient, 'build' | 'decompileAndCommit' | 'getPluginIndexing' | 'onLoadOrderStatus'>;
  adapter: Pick<InstanceAdapter,
    'reading' | 'modOrder' | 'entryKey' | 'downloadedFile' | 'installationFile' | 'modMetadata' | 'metadataFilesInModFolder' | 'sourceFolder' | 'sourceMods' | 'gameRelease' | 'modFolderPath' | 'exclusionMark' | 'statCacheFolder' | 'sourceHost' | 'gamePlaces' | 'gameFiles' | 'gameFilesTakenBy'>;
  /** Saves the unsaved plugin source under a folder, as Text documents holds it; answers the paths VS Code left unsaved. */
  saveUnsaved: (folder: string, isPluginSource: (path: string) => boolean) => Promise<string[]>;
  tasks: StepTasks;
}

const unsavedRefusal = (mod: string, paths: readonly string[]): ItemRefusal<string> =>
  ({ item: mod, reason: `VS Code did not save its plugin source: ${paths.join(', ')}` });

export const metadataUnreadable = (reason: string): string => `its metadata could not be read: ${reason}`;

/** The source mod gestures, bound to the mEdit client. mEdit reads each mod's plugins in the load order it holds,
 *  which lacks a snapshot still waiting to be put, so each first waits for the newest to reconcile. */
export function sourceCommands({ client, adapter, saveUnsaved, tasks }: SourceCommandsDeps) {
  const noRepositoryRefusal = (mod: string, sourceMods: SourceMods): ItemRefusal<string> => {
    const own = adapter.sourceFolder(mod);
    const claimed = own === undefined || sourceMods.folderOf(mod) !== undefined ? undefined : sourceMods.claimedOutput(own);
    if (claimed === undefined) return { item: mod, reason: 'no repository in the source folder builds it' };
    const sameMod = adapter.entryKey({ kind: 'mod', name: mod }) === adapter.entryKey({ kind: 'mod', name: claimed });
    return { item: mod, reason: sameMod ? `its repository's manifest is not named for its output "${claimed}"` : `its folder is "${mod}", but its repository's manifest builds "${claimed}"` };
  };

  const buildMod = async (mod: string, sourceMods: SourceMods): Promise<BuildMod | ItemRefusal<string>> => {
    const sourceFolder = sourceMods.folderOf(mod);
    const unsaved = sourceFolder === undefined ? [] : await saveUnsaved(sourceFolder, isPluginSourcePath);
    if (unsaved.length > 0) return unsavedRefusal(mod, unsaved);
    const folder = await adapter.modFolderPath(mod);
    const metadata = await adapter.modMetadata(mod);
    const host = sourceFolder === undefined ? undefined : await adapter.sourceHost(sourceFolder);
    if (sourceFolder === undefined || host === undefined) return noRepositoryRefusal(mod, sourceMods);
    if (folder === undefined) return { item: mod, reason: 'its name gives it no folder' };
    if (metadata.kind === 'unreadable') return { item: mod, reason: metadataUnreadable(metadata.reason) };
    if (host.kind === 'unreadable') return { item: mod, reason: `its remote could not be read: ${host.reason}` };
    return {
      name: mod, sourceFolder, folder, metadataFiles: [...adapter.metadataFilesInModFolder],
      version: metadata.answer.version, isSubmodule: host.answer.kind === 'host',
    };
  };

  // mods.md, Build, story 1: a mod's steps run once mEdit made its folder, and mEdit writes its manifest once they ran.
  const withManifestsOnceStepsRan = async (landed: BuildOutcome['landed'], sent: readonly BuildMod[], facts: BuildFacts): Promise<BuildOutcome['landed']> => {
    const failures = new Map<string, string>();
    const stepsRan: BuildMod[] = [];
    for (const built of landed) {
      const mod = sent.find(({ name }) => name === built.mod);
      if (built.steps.length === 0 || mod === undefined) continue;
      const why = await tasks.whyStepsFailed(built.steps, mod.folder);
      if (why === undefined) stepsRan.push({ ...mod, made: built.made });
      else failures.set(built.mod, `The build stopped as its ${why}, so its manifest was not written.`);
    }
    if (stepsRan.length > 0) for (const [mod, failure] of manifestFailures(stepsRan, await client.build(stepsRan, facts))) failures.set(mod, failure);
    return landed.map((built) => {
      const failure = failures.get(built.mod);
      return failure === undefined ? built : { ...built, failure };
    });
  };

  // modlist-repository.md, Restore from manifest, story 4: mEdit names what a package lacks, and the request hands it.
  const withPackages = async (outcome: BuildOutcome, sent: readonly BuildMod[], facts: BuildFacts): Promise<BuildOutcome | WriteRefused> => {
    const asking = outcome.refused.filter(({ installationFilesNotFound, gameFilesNotFound }) => (installationFilesNotFound?.length ?? 0) + (gameFilesNotFound?.length ?? 0) > 0);
    if (asking.length === 0) return outcome;
    const downloaded = await namedDownloadedFiles({ adapter }, asking.map(({ installationFilesNotFound }) => ({ installationFiles: installationFilesNotFound ?? [] })), {});
    const folder = await namedGameFolder(adapter, await adapter.gameRelease());
    const game = await namedGameFiles(adapter, folder, asking.map(({ item, gameFilesNotFound }) => ({ mod: item, gameFiles: gameFilesNotFound ?? [] })));
    const again = asking.flatMap(({ item, installationFilesNotFound }) => {
      const mod = sent.find(({ name }) => name === item);
      return mod === undefined ? [] : [{
        ...mod, installationFiles: (installationFilesNotFound ?? []).flatMap(({ name }) => wireFile(downloaded.handed(name)) ?? []),
        unreadableInstallationFiles: downloaded.unreadableAmong(installationFilesNotFound ?? []), unreadableGameFiles: game.unreadable(item),
      }];
    });
    const second = await client.build(again, { ...facts, gameFolder: wireGameFolder(folder, game.found, false) });
    if (isRefused(second)) return second;
    return { landed: [...outcome.landed, ...second.landed], refused: [...outcome.refused.filter((refused) => !asking.includes(refused)), ...second.refused] };
  };

  const builtWhole = async (mod: BuildMod, facts: BuildFacts): Promise<BuildOutcome | WriteRefused> => {
    const first = await client.build([mod], facts);
    if (isRefused(first)) return first;
    const outcome = await withPackages(first, [mod], facts);
    return isRefused(outcome) ? outcome : { ...outcome, landed: await withManifestsOnceStepsRan(outcome.landed, [mod], facts) };
  };

  return {
    /** A mod with plugin source VS Code leaves unsaved, no repository that builds it, or a folder or metadata
     *  the Instance adapter cannot answer is refused here, naming why, and mEdit builds the rest with the release's archive variants. */
    build: async (asked: readonly string[], everySource = false): Promise<BuildOutcome | WriteRefused> => {
      const sourceMods = await adapter.sourceMods();
      const mods = everySource ? [...sourceMods.folders.keys()] : asked;
      const gameRelease = await adapter.gameRelease();
      const facts: BuildFacts = {
        exclusionMark: adapter.exclusionMark, archives: archiveVariants(gameRelease), statCache: adapter.statCacheFolder,
        gameFolder: wireGameFolder(await namedGameFolder(adapter, gameRelease), NONE_HELD, false), tasks: [...await tasks.labels()],
      };
      let landed: BuildOutcome['landed'][number][] = [];
      const refused: ItemRefusal<string>[] = [];
      const ordered = await inModOrder(adapter, mods);
      let previous: string | undefined;
      for (const [at, mod] of ordered.entries()) {
        const decided = await buildMod(mod, sourceMods);
        if ('reason' in decided) { refused.push(decided); continue; }
        // mods.md, Build, story 11: this mod's script reads the plugins of the one built before it in the load order.
        const why = previous === undefined ? undefined : (await whyNotIndexed({ client, adapter }, [previous])).get(previous);
        if (previous !== undefined && why !== undefined) {
          const waited = previous;
          landed = landed.map((built) => (built.mod === waited ? { ...built, failure: built.failure ?? `Its ${why}, so the mods after it were not built.` } : built));
          refused.push(...ordered.slice(at).map((item) => ({ item, reason: `was not built: ${waited}'s ${why}` })));
          break;
        }
        const outcome = await builtWhole(decided, facts);
        if (isRefused(outcome)) {
          if (landed.length === 0 && refused.length === 0) return outcome;
          refused.push(...ordered.slice(at).map((item) => ({ item, reason: `was not built: ${outcome.message}` })));
          break;
        }
        landed.push(...outcome.landed);
        refused.push(...outcome.refused);
        previous = outcome.landed.length === 0 ? undefined : mod;
      }
      return { landed, refused };
    },

    /** A mod whose name gives it no source folder, or whose installation file or metadata cannot be read, is refused here, naming why, and mEdit decompiles and commits the rest. */
    decompileAndCommit: async (
      mods: readonly string[], options: { onProgress?: (status: DecompileAndCommitProgress) => void } = {},
    ): Promise<DecompileAndCommitOutcome | WriteRefused> => {
      const sent: DecompileAndCommitMod[] = [];
      const refused: ItemRefusal<string>[] = [];
      const game = await gameToHand(adapter, await adapter.sourceMods());
      for (const mod of mods) {
        const sourceFolder = adapter.sourceFolder(mod);
        if (sourceFolder === undefined) { refused.push({ item: mod, reason: 'its name gives it no source folder' }); continue; }
        const installation = await adapter.installationFile(mod);
        const metadata = await adapter.modMetadata(mod);
        const folder = await adapter.modFolderPath(mod);
        if (installation.kind === 'unreadable') { refused.push({ item: mod, reason: installation.reason }); continue; }
        if (metadata.kind === 'unreadable') { refused.push({ item: mod, reason: metadataUnreadable(metadata.reason) }); continue; }
        if (folder === undefined) { refused.push({ item: mod, reason: 'its name gives it no folder' }); continue; }
        const taken = await gameFilesOf(adapter, { mod, folder }, game, false);
        if ('refusal' in taken) { refused.push({ item: mod, reason: taken.refusal }); continue; }
        sent.push({
          name: mod, sourceFolder, metadataFiles: [...adapter.metadataFilesInModFolder], installationFile: wireFile(installation.answer), version: metadata.answer.version,
          gameFolder: wireGameFolder(game.folder, taken.gameFiles, true),
        });
      }
      if (sent.length === 0) return { landed: [], refused };
      const outcome = await client.decompileAndCommit(sent, options);
      return isRefused(outcome) ? outcome : { landed: outcome.landed, refused: [...outcome.refused, ...refused] };
    },
  };
}

export type SourceCommands = ReturnType<typeof sourceCommands>;

function manifestFailures(stepsRan: readonly BuildMod[], written: BuildOutcome | WriteRefused): [string, string][] {
  if (isRefused(written)) return stepsRan.map(({ name }) => [name, `Its manifest was not written: ${written.message}`]);
  return [
    ...written.landed.flatMap(({ mod, failure }): [string, string][] => (failure === undefined ? [] : [[mod, failure]])),
    ...written.refused.map(({ item, reason }): [string, string] => [item, `Its manifest was not written, as the mod ${reason}`]),
  ];
}

/** The release's archive variants, none when the table names none. Modbench packs a BA2 compressed, as the game's own are. */
export function archiveVariants(gameRelease: string): BuildFacts['archives'] {
  const versions = ba2VersionsOf(gameRelease);
  return versions === undefined
    ? null
    : { general: { ba2: { version: versions.general, compressed: true } }, textures: { ba2: { version: versions.textures, compressed: true } } };
}
