import * as vscode from 'vscode';
import type { Instance } from '../instanceLoader/instance';
import type { PluginNode, PluginsTreeNode } from './pluginRows';
import { runWritingGesture } from '../drivingLib/writingGesture';
import { PLUGINS_KEY_ARGS, pluginOf } from './gestureEntry';
import { registerAgentGesture, type AgentGesture } from '../drivingLib/agentGesture';
import { pluralArgument } from '../drivingLib/gestureEntry';
import type { PluginParticipation, PluginsCommands, SelectionResult } from '../pluginsCommands/plugins';
import type { Reporter } from '../ports/reporter';

// modbench.plugin.enable / modbench.plugin.disable: the whole selection through the entry
// (plugins.md, Menus and keys, story 3 — behaves as in Mods).
export function registerPluginEnableCommands(
  commands: Pick<PluginsCommands, 'setPluginsEnabled'>, instance: Pick<Instance, 'value' | 'refresh'>,
  viewSelection: () => readonly PluginsTreeNode[], reporter: Reporter,
): vscode.Disposable[] {
  const gesture = (enabled: boolean): AgentGesture<PluginsTreeNode, readonly string[], SelectionResult<string>> => ({
    fromView: (entry) => {
      const names = pluralArgument(entry, 'plugin').map((n: PluginNode) => n.plugin.name);
      return names.length === 0 ? undefined : names;
    },
    fromAgent: ({ argument }) => argument.map((one) => pluginOf(one).name),
    run: (names) => runWritingGesture(PLUGINS_KEY_ARGS.view, instance, () => commands.setPluginsEnabled(instance.value.activeProfile, names, enabled)),
    report: (result, names) => reportPluginsParticipation(result, names.map((name) => ({ name, enabled })), reporter),
  });
  return [
    registerAgentGesture('modbench.plugin.enable', viewSelection, gesture(true)),
    registerAgentGesture('modbench.plugin.disable', viewSelection, gesture(false)),
  ];
}

// The verb every entry shares, or "update" when the entries ask for more than one state — the
// check box's own case, when several rows toggled at once land in different directions.
function participationVerb(entries: readonly PluginParticipation[]): string {
  const [first, ...rest] = entries;
  if (first === undefined) return 'update';
  if (rest.some((entry) => entry.enabled !== first.enabled)) return 'update';
  return first.enabled ? 'enable' : 'disable';
}

// Shared by the menu/key path above and the check box, so both read one outcome the same way.
export function reportPluginsParticipation(
  result: SelectionResult<string>, entries: readonly PluginParticipation[], reporter: Reporter,
): void {
  const verb = participationVerb(entries);
  if (!result.applied) {
    reporter.report('error', `Failed to ${verb} plugins.`, result.refusal);
    return;
  }
  reporter.selectionOutcome(
    `Could not ${verb} ${result.outcome.refused.length} of ${entries.length} plugins.`,
    result.outcome, (name) => name,
  );
}
