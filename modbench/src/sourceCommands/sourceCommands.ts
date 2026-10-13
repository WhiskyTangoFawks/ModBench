import {
  isRefused, type BuildMod, type BuildOutcome, type InitMod, type InitOutcome, type InitStatus, type MEditClient, type WriteRefused,
} from '../client';
import type { InstallationFile, InstanceAdapter } from '../instanceAdapter/instanceAdapter';
import type { ItemRefusal } from '../ports/selectionOutcome';
import { archiveVariantsOf } from '../tables/gamePaths';

interface SourceCommandsDeps {
  client: Pick<MEditClient, 'build' | 'init'>;
  adapter: Pick<InstanceAdapter,
    'installationFiles' | 'managerFilesInModFolder' | 'sourceFolder' | 'sourceMods' | 'modFolderPath' | 'excludedSuffix'>;
}

/** The source mod gestures, bound to the mEdit client and handing it the instance's facts. */
export function sourceCommands({ client, adapter }: SourceCommandsDeps) {
  return {
    /** A mod no repository builds, or whose folder or installation files the Instance adapter cannot answer, is
     *  refused here, naming why, and mEdit builds the rest with the release's archive variants. */
    build: async (mods: readonly string[], gameRelease: string | undefined): Promise<BuildOutcome | WriteRefused> => {
      const sources = await adapter.sourceMods();
      const sent: BuildMod[] = [];
      const refused: ItemRefusal<string>[] = [];
      for (const mod of mods) {
        const sourceFolder = sources.folderOf(mod);
        const folder = await adapter.modFolderPath(mod);
        const installed = await adapter.installationFiles(mod);
        if (sourceFolder === undefined) refused.push({ item: mod, reason: 'no repository in the source folder builds it' });
        else if (folder === undefined) refused.push({ item: mod, reason: 'its name gives it no folder' });
        else if (installed.kind === 'unreadable') refused.push({ item: mod, reason: installed.reason });
        else sent.push({ name: mod, sourceFolder, folder, installationFiles: installed.answer.map(onTheWire) });
      }
      if (sent.length === 0) return { landed: [], refused };
      const outcome = await client.build(sent, { excludedSuffix: adapter.excludedSuffix, archives: archiveVariantsOf(gameRelease) ?? null });
      return isRefused(outcome) ? outcome : { landed: outcome.landed, refused: [...outcome.refused, ...refused] };
    },

    /** A mod whose source folder or installation files the Instance adapter cannot answer is refused here, naming why,
     *  and mEdit inits the rest. */
    init: async (
      mods: readonly string[], options: { onProgress?: (status: InitStatus) => void } = {},
    ): Promise<InitOutcome | WriteRefused> => {
      const sent: InitMod[] = [];
      const refused: ItemRefusal<string>[] = [];
      for (const mod of mods) {
        const sourceFolder = adapter.sourceFolder(mod);
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

function onTheWire(file: InstallationFile): InitMod['installationFiles'][number] {
  return { ...file, entries: [...file.entries] };
}
