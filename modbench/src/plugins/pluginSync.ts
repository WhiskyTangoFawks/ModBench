import * as vscode from 'vscode';
import { createPluginSync, type Sync, type SyncChannel } from '../drivingLib/syncFailureReport';
import { refreshWritten, whenNoChangeIsRunning } from '../drivingLib/writingGesture';
import type { Concerns, Instance } from '../instanceLoader/instance';
import { WrittenFiles } from '../instanceLoader/writtenFiles';
import { isolatingWrites } from '../instanceLoader/ambientWrites';
import type { PluginSyncRun } from '../pluginCommands/plugins';
import { isPluginFile } from '../tables/pluginFile';
import { MANIFEST_SUFFIX } from '../repositoriesLib/manifestPath';

// What a sync reads from the adapter, as the facts that change with it.
const SYNC_READS = { plugins: true, pluginsLoadedWithNoLine: true, mods: true, holdsRepository: true } as const;

// A plugin's masters, which mEdit answers, and the plugins a manifest names change with their files.
const readsFile = (path: string): boolean => isPluginFile(path) || path.toLowerCase().endsWith(MANIFEST_SUFFIX);

export interface PluginSyncOn {
  dispose(): void;
  pluginSync: Sync;
}

interface PluginSyncDeps {
  instance: Pick<Instance, 'refresh'> & {
    subscribe(subscriber: () => Promise<void>, concerns: Concerns<keyof typeof SYNC_READS>, readsFile: (path: string) => boolean): { dispose(): void };
  };
  syncPlugins: PluginSyncRun;
  channel: SyncChannel;
}

// Termination: a write re-enters through the Instance adapter's signal. The next value agrees with
// disk, so the sync writes nothing and the loop stops; a sync that wrote unconditionally never would.
export function pluginSyncOn({ instance, syncPlugins, channel }: PluginSyncDeps): PluginSyncOn {
  const pluginSync = createPluginSync(syncPlugins, channel);
  const gated = whenNoChangeIsRunning(async () => {
    const written = new WrittenFiles();
    const synced = await isolatingWrites(written, () => pluginSync.run());
    if (synced?.wrote) await refreshWritten(instance, written);
  });
  const subscription = instance.subscribe(gated.run, SYNC_READS, readsFile);
  return { pluginSync, dispose: () => { subscription.dispose(); gated.dispose(); } };
}

export function registerPluginSyncCommand(
  pluginSync: Pick<Sync, 'run'>,
  register: (command: string, handler: () => unknown) => vscode.Disposable = (command, handler) => vscode.commands.registerCommand(command, handler),
): vscode.Disposable {
  return register('modbench.plugin.sync', () => pluginSync.run());
}
