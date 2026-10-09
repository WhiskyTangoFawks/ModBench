import * as vscode from 'vscode';
import type { MEditClient, PluginAddress } from '../client';
import type { InstanceAdapter } from '../instanceAdapter/instanceAdapter';
import type { Instance } from '../instanceLoader/instance';
import { runWritingGesture } from '../drivingLib/writingGesture';
import { reorderPlugins, type PluginsDrop } from '../pluginsCommands/plugins';
import { errorMessage } from '../ports/errorMessage';
import type { Reporter } from '../ports/reporter';
import { isPluginAddress } from '../wire/messages';
import { PLUGINS_KEY_ARGS } from './gestureEntry';
import { PluginNode, type PluginsTreeNode, type PluginsTreeProvider } from './PluginsTreeProvider';

const isAddresses = (value: unknown): value is PluginAddress[] => Array.isArray(value) && value.every(isPluginAddress);

function isDrop(value: unknown): value is PluginsDrop {
  if (typeof value !== 'object' || value === null || !('kind' in value)) return false;
  if (value.kind === 'winningEnd' || value.kind === 'losingEnd') return true;
  return (value.kind === 'before' || value.kind === 'after') && 'name' in value && typeof value.name === 'string';
}

interface MoveView extends Pick<PluginsTreeProvider, 'movePlaces'> {
  selection: () => readonly PluginsTreeNode[];
}

/** `modbench.plugin.move`: the plugins as `(origin, filename)` addresses, and the drop where they
 *  land. Left out, the plugins are the view's selection and the drop is picked. A tree drop is
 *  one entry point into it. */
export function registerPluginMoveCommand(
  adapter: InstanceAdapter, masters: Pick<MEditClient, 'getPlugins'>, instance: Pick<Instance, 'value' | 'refresh'>,
  view: MoveView, reporter: Reporter,
): vscode.Disposable {
  return vscode.commands.registerCommand('modbench.plugin.move', async (plugins?: unknown, drop?: unknown) => {
    const moving = isAddresses(plugins)
      ? plugins
      : view.selection().filter((row): row is PluginNode => row instanceof PluginNode).map(({ plugin, origin }) => ({ name: plugin.name, origin }));
    if (moving.length === 0) return;
    const target = isDrop(drop)
      ? drop
      : (await vscode.window.showQuickPick(view.movePlaces(moving.map(({ name }) => name)), { placeHolder: 'Move above…' }))?.drop;
    if (target === undefined) return;
    try {
      const { activeProfile, pluginsLoadedWithNoLine } = instance.value;
      const result = await runWritingGesture(PLUGINS_KEY_ARGS.view, instance, () => reorderPlugins(
        adapter, masters, activeProfile, moving, target, (pluginsLoadedWithNoLine ?? []).map(({ name }) => name)));
      if (!result.applied) reporter.report('error', 'Could not move plugins.', result.refusal);
    } catch (e) {
      reporter.report('error', 'Failed to move plugins.', errorMessage(e));
    }
  });
}
