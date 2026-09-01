import * as vscode from 'vscode';
import type { ModListProvider, ModlistNode } from './ModListProvider';
import { makeReporter } from '../reporter';

/** Enable/disable a mod from its row checkbox. ADR-0026: a failed toggle must surface, not
 *  silently leave the checkbox out of sync with disk — log detail, notify, and invalidate so
 *  the checkbox resyncs to what `modlist.txt` actually says.
 *
 *  Its own file, not inline in `modManagementCommands.ts`, so it stays independently unit
 *  testable (#655): `ModListProvider`/`ModlistNode` are used here only as types, so importing
 *  this file never evaluates `ModListProvider.ts`'s own real module body — which extends
 *  `vscode.TreeItem` at class-definition time and so cannot load under a minimal `vi.mock
 *  ('vscode')`, the same reason `pluginCheckboxHandler.ts` (its Editing-side twin) is its own
 *  file too. */
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
