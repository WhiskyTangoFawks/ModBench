import type * as vscode from 'vscode';
import { createModSync, createPluginSync, type Sync, type SyncChannel } from './drivingLib/syncFailureReport';
import type { Instance, InstanceValue } from './instanceLoader/instance';
import type { ModSyncRun } from './modCommands/modCommands';
import type { LastModStatuses, PluginSyncRun } from './pluginCommands/plugins';

export interface InstanceSyncs {
  dispose(): void;
  modSync: Sync;
  pluginSync: Sync;
}

interface InstanceSyncsDeps {
  instance: Pick<Instance, 'subscribe' | 'value'>;
  syncMods: ModSyncRun;
  syncPlugins: PluginSyncRun;
  channel: SyncChannel;
  /** Each mod's status as mEdit last answered it, which changes with what an enabled mod's manifest names. */
  modStatuses: Pick<LastModStatuses, 'onDidChange'>;
}

// Termination: a write re-enters through the Instance adapter's signal. The next value agrees with
// disk, so the sync writes nothing and the loop stops; a sync that wrote unconditionally never would.
export function instanceSyncs({ instance, syncMods, syncPlugins, channel, modStatuses }: InstanceSyncsDeps): InstanceSyncs {
  const { modOrderFile } = instance.value.managerNames;
  const modSync = createModSync(syncMods, channel, modOrderFile);
  const pluginSync = createPluginSync(syncPlugins, channel);
  const subscription = instance.subscribe(() => {
    void modSync.run();
    void pluginSync.run();
  });
  const statusesChanged = modStatuses.onDidChange(() => { void pluginSync.run(); });
  return { modSync, pluginSync, dispose: () => { subscription.dispose(); statusesChanged.dispose(); } };
}

export function registerSyncCommands(
  register: (command: string, handler: () => unknown) => vscode.Disposable, { modSync, pluginSync }: Pick<InstanceSyncs, 'modSync' | 'pluginSync'>,
): vscode.Disposable[] {
  return [
    register('modbench.mod.sync', () => modSync.run()),
    register('modbench.plugin.sync', () => pluginSync.run()),
  ];
}

type LoadOrderPut = (value: InstanceValue) => void;

export function loadOrderPutHandler(
  editing: { onRecompute(source: InstanceValue['loadOrderSnapshot'], stringsLanguage: string | undefined): void }, stringsLanguage: () => string | undefined,
): LoadOrderPut {
  return (value) => { editing.onRecompute(value.loadOrderSnapshot, stringsLanguage()); };
}

export function loadOrderPutOnEachValue(instance: Pick<Instance, 'subscribe'>, put: LoadOrderPut) {
  return instance.subscribe(put);
}

export function loadOrderPutOnEachLanguageChange<S>(
  onLanguageChange: (listener: () => void) => S, instance: Pick<Instance, 'value'>, put: LoadOrderPut,
): S {
  return onLanguageChange(() => { put(instance.value); });
}
