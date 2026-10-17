import * as vscode from 'vscode';
import type { PluginAddress } from '../client';
import { pluginNameKey } from '../wire/pluginAddress';
import type { Instance } from '../instanceLoader/instance';
import { registerAgentGesture, type AgentGesture, type GestureResult } from '../drivingLib/agentGesture';
import { pluralArgument } from '../drivingLib/gestureEntry';
import { runWritingGesture } from '../drivingLib/writingGesture';
import type { PluginCommands, PluginsDrop } from '../pluginCommands/plugins';
import { errorMessage } from '../ports/errorMessage';
import type { Reporter } from '../ports/reporter';
import { PLUGINS_KEY_ARGS, pluginOf } from './gestureEntry';
import { type PluginsTreeProvider } from './PluginsTreeProvider';
import type { PluginsTreeNode } from './pluginRows';

function isDrop(value: unknown): value is PluginsDrop {
  if (typeof value !== 'object' || value === null || !('kind' in value)) return false;
  if (value.kind === 'winningEnd' || value.kind === 'losingEnd') return true;
  return (value.kind === 'before' || value.kind === 'after') && 'name' in value && typeof value.name === 'string';
}

type DropBeside = Extract<PluginsDrop, { name: string }>;

const dropsOnMoving = (plugins: readonly PluginAddress[], drop: PluginsDrop): drop is DropBeside =>
  'name' in drop && plugins.some(({ name }) => pluginNameKey(name) === pluginNameKey(drop.name));

interface MoveView extends Pick<PluginsTreeProvider, 'movePlaces'> {
  selection: () => readonly PluginsTreeNode[];
}

interface Move {
  readonly plugins: readonly PluginAddress[];
  readonly drop: PluginsDrop;
}

/** `modbench.plugin.move`: the plugins and the drop where they land. Left out, the plugins are the
 *  view's selection and the drop is picked. A tree drop is one entry point into it. */
export function registerPluginMoveCommand(
  commands: Pick<PluginCommands, 'reorderPlugins'>, instance: Pick<Instance, 'value' | 'refresh'>,
  view: MoveView, reporter: Reporter,
): vscode.Disposable {
  const gesture: AgentGesture<PluginsTreeNode, Move, GestureResult<PluginAddress>, { drop: PluginsDrop }> = {
    fromView: async (entry, option) => {
      const plugins = pluralArgument(entry, 'plugin').map(({ plugin, origin }) => ({ name: plugin.name, origin }));
      if (plugins.length === 0) return undefined;
      const drop = isDrop(option)
        ? option
        : (await vscode.window.showQuickPick(view.movePlaces(plugins.map(({ name }) => name)), { placeHolder: 'Move above…' }))?.drop;
      return drop && { plugins, drop };
    },
    fromAgent: ({ argument, options }) => ({ plugins: argument.map(pluginOf), drop: options.drop }),
    run: async ({ plugins, drop }) => {
      if (dropsOnMoving(plugins, drop)) {
        return { applied: true, outcome: { landed: [], refused: plugins.map((item) => ({ item, reason: `The drop is on "${drop.name}", which is moving.` })) } };
      }
      try {
        const { activeProfile, pluginsLoadedWithNoLine } = instance.value;
        const result = await runWritingGesture(PLUGINS_KEY_ARGS.view, instance, () => commands.reorderPlugins(
          activeProfile, plugins, drop, (pluginsLoadedWithNoLine ?? []).map(({ name }) => name)));
        return result.applied
          ? { applied: true, outcome: { landed: plugins, refused: [] } }
          : { applied: false, refusal: 'Could not move plugins.', detail: result.refusal };
      } catch (e) {
        return { applied: false, refusal: 'Failed to move plugins.', detail: errorMessage(e) };
      }
    },
    report: (result) => {
      if (!result.applied) reporter.report('error', result.refusal, result.detail);
    },
  };
  return registerAgentGesture('modbench.plugin.move', view.selection, gesture);
}
