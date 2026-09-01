import * as vscode from 'vscode';
import type { PluginListProvider, PluginListNode } from './modmanager/PluginListProvider';
import type { PluginTreeNode } from './medit/PluginTreeProvider';
import { makeReporter } from './reporter';

/** Enable/disable a plugin from its row checkbox on the merged Plugins tree. ADR-0026: a failed
 *  toggle must surface, not silently leave the checkbox out of sync with disk — log detail,
 *  notify, and invalidate so the checkbox resyncs to what plugins.txt actually says. Same shape
 *  as Mod Management's own `onModCheckboxChanged` (modmanager/modManagementCommands.ts) — #655:
 *  this one lived inline in `registerPluginListView` with no unit seam until now.
 *
 *  Lives at the composition root, not in modmanager/, for the same reason `PluginsTreeComposite`
 *  does: the checkbox fires on the *merged* tree, whose row type is `PluginListNode |
 *  PluginTreeNode` — both contexts' own row types — even though this handler only ever acts on
 *  the `'plugin'`-kind rows and touches nothing else. */
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
