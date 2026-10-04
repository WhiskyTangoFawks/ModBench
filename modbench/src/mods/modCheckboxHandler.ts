import * as vscode from 'vscode';
import type { ModlistNode, ModNode } from './ModListProvider';

/** Its own file to stay unit testable: `ModListProvider` is a type-only import, so loading this
 *  never evaluates a module that extends `vscode.TreeItem` under a minimal `vi.mock('vscode')`. */
export async function onModCheckboxChanged(e: vscode.TreeCheckboxChangeEvent<ModlistNode>): Promise<void> {
  const toggled = e.items.flatMap(([node, state]) =>
    (node.kind === 'mod' ? [{ node, checked: state === vscode.TreeItemCheckboxState.Checked }] : []));
  for (const checked of [true, false]) {
    const nodes: ModNode[] = toggled.filter((item) => item.checked === checked).map((item) => item.node);
    const [first] = nodes;
    if (first) await vscode.commands.executeCommand(checked ? 'modbench.mod.enable' : 'modbench.mod.disable', first, nodes);
  }
}
