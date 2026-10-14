import { isRefused, type MEditClient, type StageMod, type StageOutcome, type StageProgress } from '../client';
import type { CommandResult } from '../coreLib/commandResult';
import type { GameFile, GameFolder, InstanceAdapter, OriginFile } from '../instanceAdapter/instanceAdapter';
import { refuse } from '../ports/refuse';
import type { ItemRefusal } from '../ports/selectionOutcome';

const DELTA_SHARE = 0.5;

interface ModlistSourceCommandsDeps {
  client: Pick<MEditClient, 'stage'>;
  adapter: Pick<InstanceAdapter,
    'installationFiles' | 'managerFilesInModFolder' | 'modFolderPath' | 'overriddenGameFiles' | 'buildFolder' | 'writeIgnoreList'>;
  instanceRoot: string;
  /** VS Code's git makes the instance folder a repository. */
  makeRepository: () => Promise<void>;
}

/** The slice of the instance value stage reads: each mod's files, and where the game's files are. */
export interface StageInstance {
  readonly filesByMod: ReadonlyMap<string, readonly Pick<OriginFile, 'relativePath'>[]>;
  readonly gameFolder: GameFolder;
}

/** What stage answers: each mod staged or refused, or the whole stage refused, as a message to show. */
export type StageResult = ({ applied: true } & StageOutcome) | { applied: false; refusal: string };

/** Where stage is: the Instance adapter reading a mod's files, or mEdit staging mods. */
export type StageStatus = { readonly phase: 'ReadingFiles'; readonly mod: string } | ({ readonly phase: 'Staging' } & StageProgress);

/** The modlist gestures, bound to the mEdit client and handing it the instance's facts. */
export function modlistSourceCommands({ client, adapter, instanceRoot, makeRepository }: ModlistSourceCommandsDeps) {
  return {
    /** Makes the repository and its ignore list, and stages nothing. Refused when the instance folder holds one already. */
    init: async ({ holdsRepository }: { readonly holdsRepository: boolean }): Promise<CommandResult<object>> => {
      if (holdsRepository) return { applied: false, refusal: `${instanceRoot} already holds a repository.` };
      try {
        await makeRepository();
        await adapter.writeIgnoreList();
        return { applied: true };
      } catch (err) {
        return refuse(err);
      }
    },

    /** A mod whose folder, installation files or overridden game files the Instance adapter cannot answer is refused
     *  here, naming why, and mEdit stages the rest. */
    stage: async (
      mods: readonly string[], { filesByMod, gameFolder }: StageInstance, options: { onProgress?: (status: StageStatus) => void } = {},
    ): Promise<StageResult> => {
      if (gameFolder.kind !== 'found') return { applied: false, refusal: 'Could not stage: the game folder was not found.' };
      const sent: StageMod[] = [];
      const gameFiles = new Map<string, GameFile>();
      const refused: ItemRefusal<string>[] = [];
      for (const mod of mods) {
        options.onProgress?.({ phase: 'ReadingFiles', mod });
        const folder = await adapter.modFolderPath(mod);
        const installed = await adapter.installationFiles(mod);
        const overridden = await adapter.overriddenGameFiles(gameFolder.dataFolder, (filesByMod.get(mod) ?? []).map((file) => file.relativePath));
        if (folder === undefined) refused.push({ item: mod, reason: 'its name gives it no folder' });
        else if (installed.kind === 'unreadable') refused.push({ item: mod, reason: installed.reason });
        else if (overridden.kind === 'unreadable') refused.push({ item: mod, reason: overridden.reason });
        else {
          sent.push({
            name: mod, folder, installationFiles: installed.answer.map((file) => ({ ...file, entries: [...file.entries] })),
            committedFiles: [...adapter.managerFilesInModFolder],
          });
          for (const file of overridden.answer) gameFiles.set(file.path.toLowerCase(), file);
        }
      }
      if (sent.length === 0) return { applied: true, landed: [], refused };
      const outcome = await client.stage(sent, {
        gameFiles: [...gameFiles.values()], dataFolder: gameFolder.dataFolder, buildFolder: adapter.buildFolder, deltaShare: DELTA_SHARE,
      }, { onProgress: (progress) => options.onProgress?.({ phase: 'Staging', ...progress }) });
      return isRefused(outcome) ? { applied: false, refusal: outcome.message } : { applied: true, landed: outcome.landed, refused: [...outcome.refused, ...refused] };
    },
  };
}

export type ModlistSourceCommands = ReturnType<typeof modlistSourceCommands>;
