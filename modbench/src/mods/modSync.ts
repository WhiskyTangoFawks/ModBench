import { createSync, type Sync, type SyncChannel } from '../drivingLib/syncFailureReport';
import type { ModSyncArguments } from '../instanceLoader/instance';
import type { ModSyncResult } from '../modlist/modlist';

/** Mod sync's runs and its failure, whose message is the Mods view's, until a run lands. */
export type ModSync = Sync<ModSyncArguments>;

export function createModSync(
  sync: (args: ModSyncArguments) => Promise<ModSyncResult>, channel: SyncChannel, modOrderFile: string,
): ModSync {
  return createSync(sync, channel, {
    command: 'mod sync',
    prefix: '[modlist]',
    unsynced: `${modOrderFile} is not synced`,
    added: `${modOrderFile} line(s) for folder(s) in mods/ with no line`,
    dropped: `${modOrderFile} line(s) whose folder is gone from mods/`,
  });
}
