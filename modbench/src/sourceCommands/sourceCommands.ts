import {
  isRefused, type BuildFacts, type BuildMod, type BuildOutcome, type DecompileAndCommitMod, type DecompileAndCommitOutcome, type DecompileAndCommitProgress, type MEditClient, type WriteRefused,
} from '../client';
import { isPluginSourcePath, type InstanceAdapter } from '../instanceAdapter/instanceAdapter';
import type { ItemRefusal } from '../ports/selectionOutcome';
import { ba2VersionsOf } from '../tables/gamePaths';

interface SourceCommandsDeps {
  client: Pick<MEditClient, 'build' | 'decompileAndCommit' | 'latestLoadOrder'>;
  adapter: Pick<InstanceAdapter,
    'modMetadata' | 'metadataFilesInModFolder' | 'sourceFolder' | 'sourceMods' | 'gameRelease' | 'modFolderPath' | 'exclusionMark' | 'statCacheFolder' | 'sourceHost'>;
  /** Saves the unsaved plugin source under a folder, as Text documents holds it; answers the paths VS Code left unsaved. */
  saveUnsaved: (folder: string, isPluginSource: (path: string) => boolean) => Promise<string[]>;
}

const unsavedRefusal = (mod: string, paths: readonly string[]): ItemRefusal<string> =>
  ({ item: mod, reason: `VS Code did not save its plugin source: ${paths.join(', ')}` });

export const metadataUnreadable = (reason: string): string => `its metadata could not be read: ${reason}`;

/** The source mod gestures, bound to the mEdit client. mEdit reads each mod's plugins in the load order it holds,
 *  which lacks a snapshot still waiting to be put, so each first waits for the newest to reconcile. */
export function sourceCommands({ client, adapter, saveUnsaved }: SourceCommandsDeps) {
  const buildMod = async (mod: string, sourceFolder: string | undefined): Promise<BuildMod | ItemRefusal<string>> => {
    const unsaved = sourceFolder === undefined ? [] : await saveUnsaved(sourceFolder, isPluginSourcePath);
    if (unsaved.length > 0) return unsavedRefusal(mod, unsaved);
    const folder = await adapter.modFolderPath(mod);
    const metadata = await adapter.modMetadata(mod);
    const host = sourceFolder === undefined ? undefined : await adapter.sourceHost(sourceFolder);
    if (sourceFolder === undefined || host === undefined) return { item: mod, reason: 'no repository in the source folder builds it' };
    if (folder === undefined) return { item: mod, reason: 'its name gives it no folder' };
    if (metadata.kind === 'unreadable') return { item: mod, reason: metadataUnreadable(metadata.reason) };
    if (host.kind === 'unreadable') return { item: mod, reason: `its remote could not be read: ${host.reason}` };
    return {
      name: mod, sourceFolder, folder, metadataFiles: [...adapter.metadataFilesInModFolder],
      version: metadata.answer.version, isSubmodule: host.answer.kind === 'host',
    };
  };

  return {
    /** A mod with plugin source VS Code leaves unsaved, no repository that builds it, or a folder or metadata
     *  the Instance adapter cannot answer is refused here, naming why, and mEdit builds the rest with the release's archive variants. */
    build: async (mods: readonly string[]): Promise<BuildOutcome | WriteRefused> => {
      const sourceMods = await adapter.sourceMods();
      const sent: BuildMod[] = [];
      const refused: ItemRefusal<string>[] = [];
      for (const mod of mods) {
        const decided = await buildMod(mod, sourceMods.folderOf(mod));
        if ('reason' in decided) refused.push(decided);
        else sent.push(decided);
      }
      if (sent.length === 0) return { landed: [], refused };
      await client.latestLoadOrder();
      const outcome = await client.build(
        sent, { exclusionMark: adapter.exclusionMark, archives: archiveVariants(await adapter.gameRelease()), statCache: adapter.statCacheFolder });
      return isRefused(outcome) ? outcome : { landed: outcome.landed, refused: [...outcome.refused, ...refused] };
    },

    /** A mod whose name gives it no source folder is refused here, naming why, and mEdit decompiles and commits the rest. */
    decompileAndCommit: async (
      mods: readonly string[], options: { onProgress?: (status: DecompileAndCommitProgress) => void } = {},
    ): Promise<DecompileAndCommitOutcome | WriteRefused> => {
      const sent: DecompileAndCommitMod[] = [];
      const refused: ItemRefusal<string>[] = [];
      for (const mod of mods) {
        const sourceFolder = adapter.sourceFolder(mod);
        if (sourceFolder === undefined) refused.push({ item: mod, reason: 'its name gives it no source folder' });
        else sent.push({ name: mod, sourceFolder, metadataFiles: [...adapter.metadataFilesInModFolder] });
      }
      if (sent.length === 0) return { landed: [], refused };
      await client.latestLoadOrder();
      const outcome = await client.decompileAndCommit(sent, options);
      return isRefused(outcome) ? outcome : { landed: outcome.landed, refused: [...outcome.refused, ...refused] };
    },
  };
}

export type SourceCommands = ReturnType<typeof sourceCommands>;

/** The release's archive variants, none when the table names none. Modbench packs a BA2 compressed, as the game's own are. */
export function archiveVariants(gameRelease: string): BuildFacts['archives'] {
  const versions = ba2VersionsOf(gameRelease);
  return versions === undefined
    ? null
    : { general: { ba2: { version: versions.general, compressed: true } }, textures: { ba2: { version: versions.textures, compressed: true } } };
}
