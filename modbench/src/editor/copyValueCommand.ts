import * as vscode from 'vscode';
import { referencedByCopyText, type ReferencedByTreeNode } from './ReferencedByTreeProvider';
import type { Reporter } from '../ports/reporter';
import { errorMessage } from '../ports/errorMessage';

export interface CopyValueCommandDeps {
  referencedByTreeView: vscode.TreeView<ReferencedByTreeNode>;
  // Mods' own adapter (modManagementCommands.ts): undefined when `clicked` is not a Mods row, so
  // this command falls back to Referenced By's own text.
  modsCopyValueText: (clicked: unknown, allSelected: readonly unknown[] | undefined) => string | undefined;
  reporterFor: (tag: string) => Reporter;
}

function referencedByFallbackText(
  referencedByTreeView: vscode.TreeView<ReferencedByTreeNode>, clicked: unknown, allSelected: unknown[] | undefined,
): string {
  const selected = allSelected as ReferencedByTreeNode[] | undefined;
  const nodes = selected?.length ? selected
    : referencedByTreeView.selection.length ? referencedByTreeView.selection
    : clicked ? [clicked as ReferencedByTreeNode] : [];
  return referencedByCopyText(nodes);
}

// xEdit parity (xeMainForm.pas's CopyInto). The catalog's one copy value id for every surface it
// names (commands.md, Record: copy value) — each row adapts itself to it, so no second command is
// registered for Mods.
export function registerCopyValueCommand(deps: CopyValueCommandDeps): vscode.Disposable {
  const { referencedByTreeView, modsCopyValueText, reporterFor } = deps;
  return vscode.commands.registerCommand('modbench.record.copyValue',
    async (clicked?: unknown, allSelected?: unknown[]) => {
      const modsText = modsCopyValueText(clicked, allSelected);
      const text = modsText ?? referencedByFallbackText(referencedByTreeView, clicked, allSelected);
      if (!text) return;
      try {
        await vscode.env.clipboard.writeText(text);
      } catch (err) {
        reporterFor(modsText !== undefined ? 'modList.copy' : 'referencedByTree.copy').report(
          'error', 'Could not copy to the clipboard.', errorMessage(err));
      }
    });
}
