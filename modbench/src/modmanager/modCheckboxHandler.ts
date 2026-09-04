import * as vscode from 'vscode';
import type { ModListProvider, ModlistNode } from './ModListProvider';
import { makeReporter } from '../reporter';

/** Its own file to stay unit testable: `ModListProvider` is a type-only import, so loading
 *  this never evaluates a module that extends `vscode.TreeItem` at definition time and so
 *  cannot load under a minimal `vi.mock('vscode')`. */
export async function onModCheckboxChanged(
  e: vscode.TreeCheckboxChangeEvent<ModlistNode>,
  modListProvider: ModListProvider,
  outputChannel: vscode.LogOutputChannel,
): Promise<void> {
  for (const [node, state] of e.items) {
    if (node.kind !== 'mod') continue;
    try {
      await modListProvider.setModEnabled(node.mod.name, state === vscode.TreeItemCheckboxState.Checked);
    } catch (err) {
      makeReporter(outputChannel, 'modList.checkbox').report(
        'error', `Failed to update "${node.mod.name}".`, err instanceof Error ? err.message : String(err));
      modListProvider.invalidate();
    }
  }
}
