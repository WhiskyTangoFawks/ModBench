// mods-conflicts.md, Opening and States: a mod's conflict table, a read-only custom editor over an
// address of its own, so preview, an open tab and restore-after-reload are VS Code's.

import * as vscode from 'vscode';
import type { InstanceView } from '../instanceLoader/instance';
import { showWebviewPage } from '../drivingLib/webviewPage';
import {
  CONFLICT_TABLE_SHOWN, isConflictTableReady, modOfConflictColumn, type ConflictTable, type ConflictTableShown,
} from '../wire/conflictTable';
import { conflictTable } from './conflictTable';
import { modsGestureEntry, singularArgument } from './gestureEntry';
import type { ModlistNode } from './ModListProvider';

export const CONFLICT_TABLE_VIEW_TYPE = 'modbench.conflicts';

const SCHEME = 'modbench-conflicts';
const SUFFIX = '.modbench-conflicts';

export const conflictTableUri = (mod: string): vscode.Uri =>
  vscode.Uri.from({ scheme: SCHEME, path: `/${encodeURIComponent(mod)}${SUFFIX}` });

class ConflictTableDocument implements vscode.CustomDocument {
  readonly mod: string;
  constructor(readonly uri: vscode.Uri) {
    this.mod = decodeURIComponent(uri.path.slice(1, -SUFFIX.length));
  }
  dispose(): void { /* no owned resources */ }
}

type TableInstance = Pick<InstanceView, 'value' | 'sequence' | 'subscribe'>;

class ConflictTableEditorProvider implements vscode.CustomReadonlyEditorProvider<ConflictTableDocument> {
  constructor(private readonly instance: TableInstance, private readonly extensionUri: vscode.Uri) {}

  openCustomDocument(uri: vscode.Uri): ConflictTableDocument {
    return new ConflictTableDocument(uri);
  }

  resolveCustomEditor({ mod }: ConflictTableDocument, panel: vscode.WebviewPanel): void {
    panel.title = `Conflicts: ${mod}`;
    const show = (table: ConflictTable) => {
      const message: ConflictTableShown = { type: CONFLICT_TABLE_SHOWN, table };
      void panel.webview.postMessage(message);
    };
    const subscription = this.instance.subscribe((value, sequence) => show(conflictTable({ value, sequence }, mod)));
    panel.onDidDispose(() => subscription.dispose());
    panel.webview.onDidReceiveMessage((message: unknown) => {
      if (isConflictTableReady(message)) show(conflictTable(this.instance, mod));
    });
    showWebviewPage(panel.webview, this.extensionUri, { script: 'conflicts.js' });
  }
}

/** commands.md, `open conflicts`: the mod of a Mods row, a column header, or the palette's one
 *  selected mod. */
export function registerConflictTable(
  instance: TableInstance, extensionUri: vscode.Uri, viewSelection: () => readonly ModlistNode[],
): vscode.Disposable[] {
  return [
    vscode.window.registerCustomEditorProvider(
      CONFLICT_TABLE_VIEW_TYPE, new ConflictTableEditorProvider(instance, extensionUri),
      { webviewOptions: { retainContextWhenHidden: true } }),
    vscode.commands.registerCommand('modbench.mod.openConflicts', async (clicked?: unknown, selected?: readonly ModlistNode[]) => {
      const mod = modOfConflictColumn(clicked)
        ?? singularArgument(modsGestureEntry(clicked, selected, viewSelection), 'mod')?.mod.name;
      if (mod === undefined) return;
      await vscode.commands.executeCommand('vscode.openWith', conflictTableUri(mod), CONFLICT_TABLE_VIEW_TYPE, { preview: true });
    }),
  ];
}
