import * as vscode from 'vscode';
import type { ModListProvider, ModlistNode } from './ModListProvider';
import type { Reporter } from '../ports/reporter';
import { errorMessage } from '../ports/errorMessage';

/** Its own file to stay unit testable: `ModListProvider` is a type-only import, so loading
 *  this never evaluates a module that extends `vscode.TreeItem` at definition time and so
 *  cannot load under a minimal `vi.mock('vscode')`. */
export async function onModCheckboxChanged(
  e: vscode.TreeCheckboxChangeEvent<ModlistNode>,
  modListProvider: Pick<ModListProvider, 'setModEnabled' | 'markUnconfirmed' | 'forgetUnconfirmed'>,
  reporter: Reporter,
): Promise<void> {
  for (const [node, state] of e.items) {
    if (node.kind !== 'mod') continue;
    const enabled = state === vscode.TreeItemCheckboxState.Checked;
    modListProvider.markUnconfirmed(node.mod.name, enabled);
    try {
      await modListProvider.setModEnabled(node.mod.name, enabled);
    } catch (err) {
      reporter.report(
        'error', `Failed to update "${node.mod.name}".`, errorMessage(err));
      modListProvider.forgetUnconfirmed(node.mod.name);
    }
  }
}
