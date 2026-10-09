import * as vscode from 'vscode';
import type { MEditClient, SourceChanges } from '../client';
import type { Instance } from '../instanceLoader/instance';
import type { PluginsCommands } from '../pluginsCommands/plugins';
import { registerGesture, singularArgument } from '../drivingLib/gestureEntry';
import { promptRename } from '../drivingLib/promptRename';
import { applyAnswered } from '../drivingLib/applyAnswered';
import type { SourceEditing } from '../drivingLib/sourceEditing';
import type { AskQuestion } from '../ports/dialog';
import type { Reporter } from '../ports/reporter';
import { PLUGINS_KEY_ARGS } from './gestureEntry';
import { creatablePluginExtensionsOf, pluginNameRefusal } from './pluginName';
import { holdsPlugin } from './pluginPlaces';
import type { PluginsTreeNode } from './pluginRows';

export interface RenamePluginDeps {
  commands: Pick<PluginsCommands, 'confirmRename' | 'renamePlugin'>;
  ask: AskQuestion;
  client: Pick<MEditClient, 'getCreatablePluginExtensions'>;
  source: SourceEditing;
  instance: Pick<Instance, 'value' | 'quiet'>;
  reporter: Reporter;
}

/** commands.md, `rename` under Plugin. */
export function registerRenamePluginCommand(
  { client, commands, ask, instance, reporter, source }: RenamePluginDeps, viewSelection: () => readonly PluginsTreeNode[],
): vscode.Disposable {
  return registerGesture('modbench.plugin.rename', viewSelection, async (entry) => {
    const row = singularArgument(entry, 'plugin');
    if (!row) return;
    const plugin = { name: row.plugin.name, origin: row.origin };
    const creatableExtensions = await creatablePluginExtensionsOf(client, reporter);
    if (creatableExtensions === undefined) return;

    const refusal = (value: string): string | undefined => {
      if (value === '' || value === plugin.name) return undefined;
      return pluginNameRefusal(value, creatableExtensions)
        ?? (holdsPlugin(instance.value, { name: value, origin: plugin.origin }) ? `"${plugin.origin}" already holds "${value}".` : undefined);
    };
    const newName = await promptRename('Rename plugin', plugin.name, refusal);
    if (newName === undefined) return;

    const confirmed = await commands.confirmRename(ask, plugin, newName, instance.value.gameRelease);
    if (!confirmed.confirmed) {
      if (confirmed.refusal !== undefined) reporter.report('error', confirmed.refusal);
      return;
    }

    await vscode.window.withProgress({ location: { viewId: PLUGINS_KEY_ARGS.view } }, () =>
      instance.quiet(() => source.oneAtATime(async () => {
        const apply = (changes: SourceChanges) => applyAnswered(source, reporter, [changes], [plugin],
          `Could not rename "${plugin.name}" (${plugin.origin}): its plugin source may be partly renamed. Reverting the source rename in git undoes it.`);
        const result = await commands.renamePlugin({ apply }, plugin, newName, instance.value.gameRelease);
        if (result.applied || 'reported' in result) return;
        if (!result.sourceRenamed) {
          reporter.report('error', result.refusal);
          return;
        }
        reporter.report('error',
          `Could not rename "${plugin.name}" (${plugin.origin}): its plugin source was renamed, its file and lines were not. Reverting the source rename in git undoes it.`,
          result.refusal);
      })));
  });
}
