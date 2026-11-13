import * as vscode from 'vscode';
import { createPluginSync, type Sync, type SyncChannel } from '../drivingLib/syncFailureReport';
import type { Instance } from '../instanceLoader/instance';
import { WrittenFiles } from '../instanceLoader/writtenFiles';
import { collectingWrites } from '../instanceLoader/ambientWrites';
import type { PluginSyncRun } from '../pluginCommands/plugins';

export interface PluginSyncOn {
  dispose(): void;
  pluginSync: Sync;
}

interface PluginSyncDeps {
  instance: Pick<Instance, 'subscribe' | 'refresh'>;
  syncPlugins: PluginSyncRun;
  channel: SyncChannel;
}

// Termination: a write re-enters through the Instance adapter's signal. The next value agrees with
// disk, so the sync writes nothing and the loop stops; a sync that wrote unconditionally never would.
export function pluginSyncOn({ instance, syncPlugins, channel }: PluginSyncDeps): PluginSyncOn {
  let wrote = false;
  const pluginSync = createPluginSync(async () => {
    const outcome = await syncPlugins();
    wrote = outcome.applied && outcome.wrote;
    return outcome;
  }, channel);
  const subscription = instance.subscribe(async () => {
    const written = new WrittenFiles();
    wrote = false;
    await collectingWrites(written, () => pluginSync.run());
    if (wrote) await instance.refresh(written.named);
  });
  return { pluginSync, dispose: () => { subscription.dispose(); } };
}

export function registerPluginSyncCommand(
  pluginSync: Pick<Sync, 'run'>,
  register: (command: string, handler: () => unknown) => vscode.Disposable = (command, handler) => vscode.commands.registerCommand(command, handler),
): vscode.Disposable {
  return register('modbench.plugin.sync', () => pluginSync.run());
}
