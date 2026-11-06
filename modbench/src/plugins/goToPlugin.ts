import * as vscode from 'vscode';
import { pluginArgumentOf } from '../drivingLib/argument';
import type { Reporter } from '../ports/reporter';
import type { PluginAddress } from '../wire/pluginAddress';
import { PLUGIN_ROW_KINDS, onlySelected } from './gestureEntry';
import type { PluginListNode, PluginsTreeNode } from './pluginRows';

interface GoToPluginDeps {
  rowOf: (plugin: PluginAddress) => PluginListNode | undefined;
  fileOf: (plugin: PluginAddress) => string | undefined;
  reveal: (row: PluginListNode) => PromiseLike<void>;
  reporter: Pick<Reporter, 'report'>;
}

/** `go to` on a plugin: Go to Definition, Go to Symbol and the palette are its entry points (commands.md). */
export function registerGoToCommand(
  { rowOf, fileOf, reveal, reporter }: GoToPluginDeps, viewSelection: () => readonly PluginsTreeNode[],
): vscode.Disposable {
  return vscode.commands.registerCommand('modbench.plugin.goTo', async (clicked?: unknown) => {
    const plugin = pluginArgumentOf(clicked ?? onlySelected(viewSelection(), ...PLUGIN_ROW_KINDS))?.plugin;
    if (plugin === undefined) return;
    const row = rowOf(plugin);
    if (row !== undefined) {
      await reveal(row);
      return;
    }
    const file = fileOf(plugin);
    if (file === undefined) {
      reporter.report('error', `Could not go to "${plugin.name}" (${plugin.origin}): Plugins shows no row for it and no file holds it.`);
      return;
    }
    await vscode.commands.executeCommand('revealInExplorer', vscode.Uri.file(file));
  });
}
