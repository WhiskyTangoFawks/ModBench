import * as vscode from 'vscode';
import type { Instance } from '../instanceLoader/instance';
import type { ModSyncRun } from '../modCommands/modCommands';
import { createModSync, type Sync, type SyncChannel } from '../drivingLib/syncFailureReport';

export interface ModSyncOn {
  dispose(): void;
  modSync: Sync;
}

interface ModSyncDeps {
  instance: Pick<Instance, 'subscribe' | 'value'>;
  syncMods: ModSyncRun;
  channel: SyncChannel;
}

// Termination: a write re-enters through the Instance adapter's signal. The next value agrees with
// disk, so the sync writes nothing and the loop stops; a sync that wrote unconditionally never would.
export function modSyncOn({ instance, syncMods, channel }: ModSyncDeps): ModSyncOn {
  const modSync = createModSync(syncMods, channel, instance.value.managerNames.modOrderFile);
  const subscription = instance.subscribe(() => { void modSync.run(); });
  return { modSync, dispose: () => { subscription.dispose(); } };
}

export function registerModSyncCommand(
  modSync: Pick<Sync, 'run'>,
  register: (command: string, handler: () => unknown) => vscode.Disposable = (command, handler) => vscode.commands.registerCommand(command, handler),
): vscode.Disposable {
  return register('modbench.mod.sync', () => modSync.run());
}
