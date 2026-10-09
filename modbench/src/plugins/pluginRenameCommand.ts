import * as vscode from 'vscode';
import type { MEditClient, SourceChanges } from '../client';
import type { Instance } from '../instanceLoader/instance';
import { confirmRename, renamePlugin, type SourceApplied, type PluginRenameAccess, type PluginRenameConfirmation } from '../pluginsCommands/renamePlugin';
import { registerGesture, singularArgument } from '../drivingLib/gestureEntry';
import { promptRename } from '../drivingLib/promptRename';
import { applyAndReport } from '../drivingLib/applyAnswered';
import type { SourceEditing } from '../drivingLib/sourceEditing';
import type { Reporter } from '../ports/reporter';
import { PLUGINS_KEY_ARGS } from './gestureEntry';
import { creatablePluginExtensionsOf, pluginNameRefusal } from './pluginName';
import { holdsPlugin } from './pluginPlaces';
import type { PluginsTreeNode } from './PluginsTreeProvider';

export interface RenamePluginDeps extends Omit<PluginRenameAccess, 'source'>, PluginRenameConfirmation {
  client: PluginRenameAccess['client'] & PluginRenameConfirmation['client'] & Pick<MEditClient, 'getCreatablePluginExtensions'>;
  source: SourceEditing;
  instance: Pick<Instance, 'value' | 'quiet'>;
  reporter: Reporter;
}

/** commands.md, `rename` under Plugin. */
export function registerRenamePluginCommand(
  { client, adapter, ask, instance, reporter, source }: RenamePluginDeps, viewSelection: () => readonly PluginsTreeNode[],
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

    const confirmed = await confirmRename({ adapter, client, ask }, plugin, newName, instance.value.gameRelease);
    if (!confirmed.confirmed) {
      if (confirmed.refusal !== undefined) reporter.report('error', confirmed.refusal);
      return;
    }

    await vscode.window.withProgress({ location: { viewId: PLUGINS_KEY_ARGS.view } }, () =>
      instance.quiet(() => source.oneAtATime(async () => {
        const applyAndSave = async (changes: SourceChanges): Promise<SourceApplied> => {
          const { applied, notSaved } = await applyAndReport(source, reporter, [changes], [plugin], {
            notApplied: `Could not rename "${plugin.name}" (${plugin.origin}): its plugin source may be partly renamed. Reverting the source rename in git undoes it.`,
            notSaved: `Could not save the rename of "${plugin.name}" (${plugin.origin}) in full. Reverting the source rename in git undoes it.`,
          });
          if (!applied) return 'notApplied';
          return notSaved.length > 0 ? 'unsaved' : 'saved';
        };
        const result = await renamePlugin({ adapter, client, source: { unsaved: source.unsaved, applyAndSave } }, plugin, newName, instance.value.gameRelease);
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
