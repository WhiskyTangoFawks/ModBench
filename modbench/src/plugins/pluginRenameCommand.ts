import * as vscode from 'vscode';
import type { MEditClient } from '../client';
import type { Instance } from '../instanceLoader/instance';
import { confirmRename, renamePlugin, type PluginRenameAccess, type PluginRenameConfirmation } from '../pluginsCommands/renamePlugin';
import { registerGesture, singularArgument } from '../drivingLib/gestureEntry';
import { promptRename } from '../drivingLib/promptRename';
import type { Reporter } from '../ports/reporter';
import { PLUGINS_KEY_ARGS } from './gestureEntry';
import { lightPluginsSupportedOf, pluginNameRefusal } from './pluginName';
import { holdsPlugin } from './pluginPlaces';
import type { PluginsTreeNode } from './PluginsTreeProvider';

export interface RenamePluginDeps extends PluginRenameAccess, PluginRenameConfirmation {
  client: PluginRenameAccess['client'] & PluginRenameConfirmation['client'] & Pick<MEditClient, 'getLightPluginsSupported'>;
  instance: Pick<Instance, 'value' | 'quiet'>;
  reporter: Reporter;
}

/** commands.md, `rename` under Plugin. */
export function registerRenamePluginCommand(
  { client, adapter, ask, instance, reporter }: RenamePluginDeps, viewSelection: () => readonly PluginsTreeNode[],
): vscode.Disposable {
  return registerGesture('modbench.plugin.rename', viewSelection, async (entry) => {
    const row = singularArgument(entry, 'plugin');
    if (!row) return;
    const plugin = { name: row.plugin.name, origin: row.origin };
    const lightPluginsSupported = await lightPluginsSupportedOf(client, reporter);
    if (lightPluginsSupported === undefined) return;

    const refusal = (value: string): string | undefined => {
      if (value === '' || value === plugin.name) return undefined;
      return pluginNameRefusal(value, lightPluginsSupported)
        ?? (holdsPlugin(instance.value, { name: value, origin: plugin.origin }) ? `"${plugin.origin}" already holds "${value}".` : undefined);
    };
    const newName = await promptRename('Rename plugin', plugin.name, refusal);
    if (newName === undefined) return;

    const confirmed = await confirmRename({ adapter, client, ask }, plugin, newName, instance.value.gameRelease);
    if (!confirmed.confirmed) {
      if (confirmed.refusal !== undefined) reporter.report('error', confirmed.refusal);
      return;
    }

    await vscode.window.withProgress({ location: { viewId: PLUGINS_KEY_ARGS.view } }, () =>
      instance.quiet(async () => {
        const result = await renamePlugin({ adapter, client }, plugin, newName, instance.value.gameRelease);
        if (result.applied) return;
        if (!result.sourceRenamed) {
          reporter.report('error', result.refusal);
          return;
        }
        reporter.report('error',
          `Could not rename "${plugin.name}" (${plugin.origin}): its plugin source was renamed, its file and lines were not. Reverting the source rename in git undoes it.`,
          result.refusal);
      }));
  });
}
