import * as vscode from 'vscode';
import type { PluginsTreeNode } from './plugins/PluginsTreeProvider';
import { reportPluginsEnabled } from './plugins/pluginParticipationCommands';
import { setPluginsEnabled } from './pluginsCommands/plugins';
import type { Reporter } from './ports/reporter';

/** ADR-0019: a failed toggle must surface and resync, never leave a checkbox disagreeing with
 *  plugins.txt. Several boxes toggled together are one entry to `setPluginsEnabled`'s core, one
 *  splice per target state. */
export async function onPluginCheckboxChanged(
  e: vscode.TreeCheckboxChangeEvent<PluginsTreeNode>,
  instanceRoot: string, profile: () => string, reporter: Reporter, invalidate: () => void,
): Promise<void> {
  const byState = new Map<boolean, string[]>();
  for (const [node, state] of e.items) {
    if (node.kind !== 'plugin') continue;
    const enabled = state === vscode.TreeItemCheckboxState.Checked;
    byState.set(enabled, [...(byState.get(enabled) ?? []), node.plugin.name]);
  }
  for (const [enabled, names] of byState) {
    const result = await setPluginsEnabled(instanceRoot, profile(), names, enabled);
    if (reportPluginsEnabled(result, names, enabled, reporter)) invalidate();
  }
}
