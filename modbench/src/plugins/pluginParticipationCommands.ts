import * as vscode from 'vscode';
import type { Instance } from '../instanceLoader/instance';
import type { PluginNode, PluginsTreeNode } from './pluginRows';
import { runWritingGesture } from '../drivingLib/writingGesture';
import { PLUGINS_KEY_ARGS, pluginOf } from './gestureEntry';
import { registerAgentGesture, type AgentGesture } from '../drivingLib/agentGesture';
import { pluralArgument } from '../drivingLib/gestureEntry';
import type { PluginParticipation, PluginCommands, SelectionResult } from '../pluginCommands/plugins';
import type { PluginAddress } from '../wire/pluginAddress';
import { present } from '../ports/present';
import type { Reporter } from '../ports/reporter';

// modbench.plugin.enable / modbench.plugin.disable: the whole selection through the entry
// (plugins.md, Menus and keys, story 3 — behaves as in Mods).
export function registerPluginEnableCommands(
  commands: Pick<PluginCommands, 'setPluginsEnabled'>, instance: Pick<Instance, 'value' | 'refresh'>,
  viewSelection: () => readonly PluginsTreeNode[], reporter: Reporter,
): vscode.Disposable[] {
  const gesture = (enabled: boolean): AgentGesture<PluginsTreeNode, readonly PluginAddress[], SelectionResult<PluginAddress>> => ({
    fromView: (entry) => {
      const plugins = pluralArgument(entry, 'plugin').map(({ plugin, origin }: PluginNode) => ({ name: plugin.name, origin }));
      return plugins.length === 0 ? undefined : plugins;
    },
    fromAgent: ({ argument }) => argument.map(pluginOf),
    run: async (plugins) => {
      const result = await runWritingGesture(PLUGINS_KEY_ARGS.view, instance, () =>
        commands.setPluginsEnabled(instance.value.activeProfile, plugins.map(({ name }) => name), enabled));
      if (!result.applied) return result;
      const addressOf = (name: string): PluginAddress => present(plugins.find((plugin) => plugin.name === name), `the plugin given as ${name}`);
      const { landed, refused } = result.outcome;
      return { applied: true, outcome: { landed: landed.map(addressOf), refused: refused.map(({ item, reason }) => ({ item: addressOf(item), reason })) } };
    },
    report: (result, plugins) => reportPluginsParticipation(namesOf(result), plugins.map(({ name }) => ({ name, enabled })), reporter),
  });
  return [
    registerAgentGesture('modbench.plugin.enable', viewSelection, gesture(true)),
    registerAgentGesture('modbench.plugin.disable', viewSelection, gesture(false)),
  ];
}

const namesOf = (result: SelectionResult<PluginAddress>): SelectionResult<string> => result.applied
  ? { applied: true, outcome: { landed: result.outcome.landed.map(({ name }) => name), refused: result.outcome.refused.map(({ item, reason }) => ({ item: item.name, reason })) } }
  : result;

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
