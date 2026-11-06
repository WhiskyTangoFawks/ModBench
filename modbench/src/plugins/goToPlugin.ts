import * as vscode from 'vscode';
import { pluginArgumentOf } from '../drivingLib/argument';
import { goToRowOrFile } from '../drivingLib/goToRow';
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
    await goToRowOrFile({
      name: `"${plugin.name}" (${plugin.origin})`, row: rowOf(plugin), file: fileOf(plugin), reveal, reporter,
      nowhere: 'Plugins shows no row for it and no file holds it.',
    });
  });
}
