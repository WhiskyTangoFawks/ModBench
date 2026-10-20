import {
  isRefused, type BuildFacts, type BuildMod, type BuildOutcome, type DecompileAndCommitMod, type DecompileAndCommitOutcome, type DecompileAndCommitProgress, type MEditClient, type WriteRefused,
} from '../client';
import type { InstanceAdapter } from '../instanceAdapter/instanceAdapter';
import type { ItemRefusal } from '../ports/selectionOutcome';
import { ba2VersionsOf } from '../tables/gamePaths';

interface SourceCommandsDeps {
  client: Pick<MEditClient, 'build' | 'decompileAndCommit' | 'latestLoadOrder'>;
  adapter: Pick<InstanceAdapter,
    'modMetadata' | 'metadataFilesInModFolder' | 'sourceFolder' | 'sourceMods' | 'gameRelease' | 'modFolderPath' | 'excludedSuffix' | 'statCacheFolder' | 'sourceHost'>;
}

export const metadataUnreadable = (reason: string): string => `its metadata could not be read: ${reason}`;

/** The source mod gestures, bound to the mEdit client. mEdit reads each mod's plugins in the load order it holds,
 *  which lacks a snapshot still waiting to be put, so each first waits for the newest to reconcile. */
export function sourceCommands({ client, adapter }: SourceCommandsDeps) {
  return {
    /** A mod no repository builds, or whose folder or metadata the Instance adapter cannot answer, is
     *  refused here, naming why, and mEdit builds the rest with the release's archive variants. */
    build: async (mods: readonly string[]): Promise<BuildOutcome | WriteRefused> => {
      const sourceMods = await adapter.sourceMods();
      const sent: BuildMod[] = [];
      const refused: ItemRefusal<string>[] = [];
      for (const mod of mods) {
        const sourceFolder = sourceMods.folderOf(mod);
        const folder = await adapter.modFolderPath(mod);
        const metadata = await adapter.modMetadata(mod);
        const host = sourceFolder === undefined ? undefined : await adapter.sourceHost(sourceFolder);
        if (sourceFolder === undefined || host === undefined) refused.push({ item: mod, reason: 'no repository in the source folder builds it' });
        else if (folder === undefined) refused.push({ item: mod, reason: 'its name gives it no folder' });
        else if (metadata.kind === 'unreadable') refused.push({ item: mod, reason: metadataUnreadable(metadata.reason) });
        else if (host.kind === 'unreadable') refused.push({ item: mod, reason: `its remote could not be read: ${host.reason}` });
        else {
          sent.push({
            name: mod, sourceFolder, folder, metadataFiles: [...adapter.metadataFilesInModFolder],
            version: metadata.answer.version, isSubmodule: host.answer.kind === 'host',
          });
        }
      }
      if (sent.length === 0) return { landed: [], refused };
      await client.latestLoadOrder();
      const outcome = await client.build(
        sent, { excludedSuffix: adapter.excludedSuffix, archives: archiveVariants(await adapter.gameRelease()), statCache: adapter.statCacheFolder });
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
