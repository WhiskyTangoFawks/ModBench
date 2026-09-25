import * as vscode from 'vscode';
import type { PluginsTreeNode } from './plugins/PluginsTreeProvider';
import { reportPluginsParticipation } from './plugins/pluginParticipationCommands';
import { setPluginsParticipation } from './pluginsCommands/plugins';
import type { Reporter } from './ports/reporter';

/** ADR-0019: a failed toggle must surface and resync, never leave a checkbox disagreeing with
 *  plugins.txt. Every toggled box, however many and whichever state each asks for, is one call
 *  to `setPluginsParticipation`'s core: one splice, one report. */
export async function onPluginCheckboxChanged(
  e: vscode.TreeCheckboxChangeEvent<PluginsTreeNode>,
  instanceRoot: string, profile: () => string, reporter: Reporter, invalidate: () => void,
): Promise<void> {
  const entries = e.items
    .filter((item): item is [Extract<PluginsTreeNode, { kind: 'plugin' }>, vscode.TreeItemCheckboxState] => item[0].kind === 'plugin')
    .map(([node, state]) => ({ name: node.plugin.name, enabled: state === vscode.TreeItemCheckboxState.Checked }));
  if (entries.length === 0) return;
  const result = await setPluginsParticipation(instanceRoot, profile(), entries);
  if (reportPluginsParticipation(result, entries, reporter)) invalidate();
}
