import * as vscode from 'vscode';
import type { Instance } from '../instanceLoader/instance';
import type { PluginNode, PluginsTreeNode } from './PluginsTreeProvider';
import { pluralArgument, registerPluginsGesture, type GestureEntry } from './gestureEntry';
import { setPluginsEnabled, type PluginsSelectionResult } from '../pluginsCommands/plugins';
import type { Reporter } from '../ports/reporter';

// modbench.plugin.enable / modbench.plugin.disable: the whole selection through the entry
// (plugins.md, Menus and keys, story 5 — behaves as in Mods). Its own light module: the check
// box (pluginCheckboxHandler.ts) reaches this same core without loading pluginRowCommands.ts.
export function registerPluginEnableCommands(
  instanceRoot: string, instance: Pick<Instance, 'value'>,
  viewSelection: () => readonly PluginsTreeNode[], reporter: Reporter,
): vscode.Disposable[] {
  const run = (enabled: boolean) => async (entry: GestureEntry) => {
    const names = pluralArgument(entry, 'plugin').map((n: PluginNode) => n.plugin.name);
    if (names.length === 0) return;
    const result = await setPluginsEnabled(instanceRoot, instance.value.activeProfile, names, enabled);
    reportPluginsEnabled(result, names, enabled, reporter);
  };
  return [
    registerPluginsGesture('modbench.plugin.enable', viewSelection, run(true)),
    registerPluginsGesture('modbench.plugin.disable', viewSelection, run(false)),
  ];
}

// Shared by the menu/key path above and the check box, so both read one outcome the same way.
// The return says whether a row needs a resync.
export function reportPluginsEnabled(
  result: PluginsSelectionResult, pluginNames: readonly string[], enabled: boolean, reporter: Reporter,
): boolean {
  const verb = enabled ? 'enable' : 'disable';
  if (!result.applied) {
    reporter.report('error', `Failed to ${verb} plugins.`, result.refusal);
    return true;
  }
  reporter.selectionOutcome(
    `Could not ${verb} ${result.outcome.refused.length} of ${pluginNames.length} plugins.`,
    result.outcome, (name) => name,
  );
  return result.outcome.refused.length > 0;
}
