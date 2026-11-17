import * as vscode from 'vscode';
import type { Instance } from '../instanceLoader/instance';
import type { ModSyncRun } from '../modCommands/modCommands';
import { whenNoChangeIsRunning } from '../drivingLib/writingGesture';
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
  const run = async () => { await modSync.run(); };
  const runIfFailed = async () => { if (modSync.message() !== undefined) await modSync.run(); };
  const subscriptions = [
    instance.subscribe(() => whenNoChangeIsRunning(run), { mods: true, modFolders: true }),
    // Recovery is not gated (ADR-0003): a sync whose failure stands is tried again at each value, as the first one was.
    instance.subscribe(() => whenNoChangeIsRunning(runIfFailed)),
  ];
  return { modSync, dispose: () => { for (const subscription of subscriptions) subscription.dispose(); } };
}

export function registerModSyncCommand(
  modSync: Pick<Sync, 'run'>,
  register: (command: string, handler: () => unknown) => vscode.Disposable = (command, handler) => vscode.commands.registerCommand(command, handler),
): vscode.Disposable {
  return register('modbench.mod.sync', () => modSync.run());
}
