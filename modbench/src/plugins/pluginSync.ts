import { createSync, type Sync, type SyncChannel } from '../drivingLib/syncFailureReport';
import type { PluginSyncArguments } from '../instanceLoader/instance';
import type { PluginSyncResult } from '../pluginsCommands/plugins';

/** Plugin sync's runs and its failure, whose message is the Plugins view's, until a run lands. */
export type PluginSync = Sync<PluginSyncArguments>;

export function createPluginSync(
  sync: (args: PluginSyncArguments) => Promise<PluginSyncResult>, channel: SyncChannel,
): PluginSync {
  return createSync(sync, channel, {
    command: 'plugin sync',
    prefix: '[pluginsCommands]',
    unsynced: 'plugins.txt is not synced',
    added: 'disabled plugins.txt line(s) for plugin(s) on disk with no line',
    dropped: 'plugins.txt line(s) with no plugin on disk',
  });
}
