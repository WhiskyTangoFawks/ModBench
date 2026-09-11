import * as vscode from 'vscode';
import type { PluginsTreeProvider, PluginsTreeNode } from './plugins/PluginsTreeProvider';
import { makeReporter } from './reporter';

/** ADR-0019: a failed toggle must surface and resync, never leave the checkbox disagreeing with
 *  plugins.txt. At the composition root because the event is the `TreeView`'s, not the
 *  provider's. */
export async function onPluginCheckboxChanged(
  e: vscode.TreeCheckboxChangeEvent<PluginsTreeNode>,
  pluginsTree: PluginsTreeProvider,
  outputChannel: vscode.LogOutputChannel,
): Promise<void> {
  for (const [node, state] of e.items) {
    if (node.kind !== 'plugin') continue;
    try {
      await pluginsTree.setPluginEnabled(node.plugin.name, state === vscode.TreeItemCheckboxState.Checked);
    } catch (err) {
      makeReporter(outputChannel, 'pluginListTree.checkbox').report(
        'error', `Failed to update "${node.plugin.name}".`, err instanceof Error ? err.message : String(err));
      pluginsTree.invalidate();
    }
  }
}
