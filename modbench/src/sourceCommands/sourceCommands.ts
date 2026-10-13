import { isRefused, type InitMod, type InitOutcome, type InitStatus, type MEditClient, type WriteRefused } from '../client';
import type { InstallationFile, InstanceAdapter } from '../instanceAdapter/instanceAdapter';
import type { ItemRefusal } from '../ports/selectionOutcome';

interface SourceCommandsDeps {
  client: Pick<MEditClient, 'build' | 'init'>;
  adapter: Pick<InstanceAdapter, 'installationFiles' | 'managerFilesInModFolder' | 'sourceFolder'>;
}

/** The source mod gestures, bound to the mEdit client and handing it the instance's facts. */
export function sourceCommands({ client, adapter }: SourceCommandsDeps) {
  return {
    build: (mods: readonly string[]) => client.build(mods),

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
