import * as vscode from 'vscode';
import { createPluginSync, type Sync, type SyncChannel } from '../drivingLib/syncFailureReport';
import { refreshWritten } from '../drivingLib/writingGesture';
import type { Instance } from '../instanceLoader/instance';
import { WrittenFiles } from '../instanceLoader/writtenFiles';
import { isolatingWrites } from '../instanceLoader/ambientWrites';
import type { PluginSyncRun } from '../pluginCommands/plugins';

export interface PluginSyncOn {
  dispose(): void;
  pluginSync: Sync;
}

interface PluginSyncDeps {
  instance: Pick<Instance, 'refresh'> & { subscribeWriter(subscriber: () => Promise<void>): { dispose(): void } };
  syncPlugins: PluginSyncRun;
  channel: SyncChannel;
}

// Termination: a write re-enters through the Instance adapter's signal. The next value agrees with
// disk, so the sync writes nothing and the loop stops; a sync that wrote unconditionally never would.
export function pluginSyncOn({ instance, syncPlugins, channel }: PluginSyncDeps): PluginSyncOn {
  const pluginSync = createPluginSync(syncPlugins, channel);
  const subscription = instance.subscribeWriter(async () => {
    const written = new WrittenFiles();
    const synced = await isolatingWrites(written, () => pluginSync.run());
    if (synced?.wrote) await refreshWritten(instance, written);
  });
  return { pluginSync, dispose: () => { subscription.dispose(); } };
}

export function registerPluginSyncCommand(
  pluginSync: Pick<Sync, 'run'>,
  register: (command: string, handler: () => unknown) => vscode.Disposable = (command, handler) => vscode.commands.registerCommand(command, handler),
): vscode.Disposable {
  return register('modbench.plugin.sync', () => pluginSync.run());
}
