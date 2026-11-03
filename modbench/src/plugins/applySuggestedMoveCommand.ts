import * as vscode from 'vscode';
import type { Instance } from '../instanceLoader/instance';
import { registerAgentGesture, type AgentGesture, type GestureResult } from '../drivingLib/agentGesture';
import { singularArgument } from '../drivingLib/gestureEntry';
import { Refusal } from '../drivingLib/refusal';
import type { OfferedMove } from '../pluginCommands/pluginOrder';
import type { PluginCommands, PluginsDrop } from '../pluginCommands/plugins';
import type { Reporter } from '../ports/reporter';
import type { PluginAddress } from '../wire/pluginAddress';
import { pluginOf } from './gestureEntry';
import { movePlugins } from './pluginMoveCommand';
import type { PluginsTreeNode } from './pluginRows';

export interface ApplySuggestedMoveDeps {
  commands: Pick<PluginCommands, 'reorderPlugins'>;
  instance: Pick<Instance, 'value' | 'refresh'>;
  reporter: Reporter;
  movesOf: (plugin: PluginAddress) => readonly OfferedMove[];
}

/** A move already chosen: a code action hands it to the command as its third argument. */
export interface ChosenMove {
  readonly plugin: PluginAddress;
  readonly drop: PluginsDrop;
}

export const chosenMoveOf = ({ mover, drop }: OfferedMove): ChosenMove => ({ plugin: mover, drop });

function isChosenMove(value: unknown): value is ChosenMove {
  return typeof value === 'object' && value !== null && 'plugin' in value && 'drop' in value;
}

/** `modbench.plugin.applySuggestedMove` (commands.md): the plugin's one offered move, else the one picked or named. */
export function registerApplySuggestedMoveCommand(
  { commands, instance, reporter, movesOf }: ApplySuggestedMoveDeps, viewSelection: () => readonly PluginsTreeNode[],
): vscode.Disposable {
  const gesture: AgentGesture<PluginsTreeNode, ChosenMove, GestureResult<PluginAddress>, { rule?: string }> = {
    fromView: async (entry, option) => {
      if (isChosenMove(option)) return option;
      const row = singularArgument(entry, 'plugin');
      if (!row) return undefined;
      const plugin = { name: row.plugin.name, origin: row.origin };
      const offered = movesOf(plugin);
      const [only, ...more] = offered;
      if (only === undefined) {
        reporter.report('error', `No suggested move for "${plugin.name}".`);
        return undefined;
      }
      if (more.length === 0) return chosenMoveOf(only);
      const picked = await vscode.window.showQuickPick(offered.map((move) => ({ label: move.rule.reason, move })), { placeHolder: 'Apply the move that keeps…' });
      return picked && chosenMoveOf(picked.move);
    },
    fromAgent: ({ argument, options: { rule } }) => {
      const [only, ...more] = argument;
      if (only === undefined || more.length > 0) throw new Refusal('An agent call to apply a suggested move carries one plugin.');
      const plugin = pluginOf(only);
      const offered = movesOf(plugin).filter((move) => rule === undefined || move.rule.reason === rule);
      const [chosen, ...others] = offered;
      if (chosen === undefined) throw new Refusal(`"${plugin.name}" has no suggested move${rule === undefined ? '' : ` for "${rule}"`}.`);
      if (others.length > 0) throw new Refusal(`"${plugin.name}" has several suggested moves: name the broken rule.`);
      return chosenMoveOf(chosen);
    },
    run: ({ plugin, drop }) => movePlugins(commands, instance, [plugin], drop),
    report: (result) => {
      if (!result.applied) reporter.report('error', result.refusal, result.detail);
    },
  };
  return registerAgentGesture('modbench.plugin.applySuggestedMove', viewSelection, gesture);
}
