import * as vscode from 'vscode';
import type { PluginsTreeNode } from './plugins/PluginsTreeProvider';
import { reportPluginsParticipation } from './plugins/pluginParticipationCommands';
import { setPluginsParticipation } from './pluginsCommands/plugins';
import type { Reporter } from './ports/reporter';

/** Every toggled box, however many and whichever state each asks for, is one call to
 *  `setPluginsParticipation`'s core: one splice, one report. The rows change when the Instance
 *  loader reads plugins.txt back (ADR-0015 invariant 2). */
export async function onPluginCheckboxChanged(
  e: vscode.TreeCheckboxChangeEvent<PluginsTreeNode>,
  instanceRoot: string, profile: () => string, reporter: Reporter,
): Promise<void> {
  const entries = e.items
    .filter((item): item is [Extract<PluginsTreeNode, { kind: 'plugin' }>, vscode.TreeItemCheckboxState] => item[0].kind === 'plugin')
    .map(([node, state]) => ({ name: node.plugin.name, enabled: state === vscode.TreeItemCheckboxState.Checked }));
  if (entries.length === 0) return;
  const result = await setPluginsParticipation(instanceRoot, profile(), entries);
  reportPluginsParticipation(result, entries, reporter);
}
