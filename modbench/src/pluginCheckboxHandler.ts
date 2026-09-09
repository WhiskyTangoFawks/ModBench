import * as vscode from 'vscode';
import type { PluginListProvider, PluginListNode } from './modmanager/PluginListProvider';
import type { PluginTreeNode } from './plugins/PluginTreeProvider';
import { makeReporter } from './reporter';

/** ADR-0026: a failed toggle must surface and resync, never leave the checkbox disagreeing with
 *  plugins.txt. At the composition root because the checkbox fires on the merged tree, whose rows
 *  belong to both bounded contexts. */
export async function onPluginCheckboxChanged(
  e: vscode.TreeCheckboxChangeEvent<PluginListNode | PluginTreeNode>,
  pluginListProvider: PluginListProvider,
  outputChannel: vscode.LogOutputChannel,
): Promise<void> {
  for (const [node, state] of e.items) {
    if (node.kind !== 'plugin') continue;
    try {
      await pluginListProvider.setPluginEnabled(node.plugin.name, state === vscode.TreeItemCheckboxState.Checked);
    } catch (err) {
      makeReporter(outputChannel, 'pluginListTree.checkbox').report(
        'error', `Failed to update "${node.plugin.name}".`, err instanceof Error ? err.message : String(err));
      pluginListProvider.invalidate();
    }
  }
}
