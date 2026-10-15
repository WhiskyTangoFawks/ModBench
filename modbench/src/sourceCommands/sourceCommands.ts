import {
  isRefused, type BuildFacts, type BuildMod, type BuildOutcome, type InitMod, type InitOutcome, type InitStatus, type MEditClient, type WriteRefused,
} from '../client';
import type { InstallationFile, InstanceAdapter } from '../instanceAdapter/instanceAdapter';
import type { ItemRefusal } from '../ports/selectionOutcome';
import { ba2VersionsOf } from '../tables/gamePaths';

/** mEdit's phases of decompile and commit, and before them the Instance adapter's reading of each mod's installation files. */
export type DecompileAndCommitProgress = InitStatus | { readonly mod: string; readonly phase: 'ReadingInstallationFiles' };

interface SourceCommandsDeps {
  client: Pick<MEditClient, 'build' | 'init'>;
  adapter: Pick<InstanceAdapter,
    'installationFiles' | 'modMetadata' | 'managerFilesInModFolder' | 'sourceFolder' | 'modFolderPath' | 'excludedSuffix' | 'statCacheFolder'>;
}

export const metadataUnreadable = (reason: string): string => `its metadata could not be read: ${reason}`;

/** The source mod gestures, bound to the mEdit client and handing it the instance's facts. */
export function sourceCommands({ client, adapter }: SourceCommandsDeps) {
  return {
    /** A mod no repository builds, or whose folder or installation files the Instance adapter cannot answer, is
     *  refused here, naming why, and mEdit builds the rest with the release's archive variants. */
    build: async (
      mods: readonly string[], gameRelease: string | undefined, sourceDirs: ReadonlyMap<string, string>,
    ): Promise<BuildOutcome | WriteRefused> => {
      const sent: BuildMod[] = [];
      const refused: ItemRefusal<string>[] = [];
      for (const mod of mods) {
        const sourceFolder = sourceDirs.get(mod);
        const folder = await adapter.modFolderPath(mod);
        const installed = await adapter.installationFiles(mod);
        const metadata = await adapter.modMetadata(mod);
        if (sourceFolder === undefined) refused.push({ item: mod, reason: 'no repository in the source folder builds it' });
        else if (folder === undefined) refused.push({ item: mod, reason: 'its name gives it no folder' });
        else if (installed.kind === 'unreadable') refused.push({ item: mod, reason: installed.reason });
        else if (metadata.kind === 'unreadable') refused.push({ item: mod, reason: metadataUnreadable(metadata.reason) });
        else {
          sent.push({
            name: mod, sourceFolder, folder, installationFiles: installed.answer.map(onTheWire), committedFiles: [...adapter.managerFilesInModFolder],
            version: metadata.answer.version,
          });
        }
      }
      if (sent.length === 0) return { landed: [], refused };
      const outcome = await client.build(
        sent, { excludedSuffix: adapter.excludedSuffix, archives: archiveVariants(gameRelease), statCache: adapter.statCacheFolder });
      return isRefused(outcome) ? outcome : { landed: outcome.landed, refused: [...outcome.refused, ...refused] };
    },

    /** A mod whose source folder or installation files the Instance adapter cannot answer is refused here, naming why,
     *  and mEdit decompiles and commits the rest. */
    decompileAndCommit: async (
      mods: readonly string[], options: { onProgress?: (status: DecompileAndCommitProgress) => void } = {},
    ): Promise<InitOutcome | WriteRefused> => {
      const sent: InitMod[] = [];
      const refused: ItemRefusal<string>[] = [];
      for (const mod of mods) {
        const sourceFolder = adapter.sourceFolder(mod);
        options.onProgress?.({ mod, phase: 'ReadingInstallationFiles' });
        const installed = await adapter.installationFiles(mod);
        if (sourceFolder === undefined) refused.push({ item: mod, reason: 'its name gives it no source folder' });
        else if (installed.kind === 'unreadable') refused.push({ item: mod, reason: installed.reason });
        else {
          sent.push({
            name: mod,
            sourceFolder,
            installationFiles: installed.answer.map(onTheWire),
            modManagerFiles: [...adapter.managerFilesInModFolder],
          });
        }
      }
      if (sent.length === 0) return { landed: [], refused };
      const outcome = await client.init(sent, options);
      return isRefused(outcome) ? outcome : { landed: outcome.landed, refused: [...outcome.refused, ...refused] };
    },
  };
}

export type SourceCommands = ReturnType<typeof sourceCommands>;

/** The release's archive variants, none when the table names none. Modbench packs a BA2 compressed, as the game's own are. */
export function archiveVariants(gameRelease: string | undefined): BuildFacts['archives'] {
  const versions = ba2VersionsOf(gameRelease);
  return versions === undefined
    ? null
    : { general: { ba2: { version: versions.general, compressed: true } }, textures: { ba2: { version: versions.textures, compressed: true } } };
}

function onTheWire(file: InstallationFile): InitMod['installationFiles'][number] {
  return { ...file, entries: [...file.entries] };
}
