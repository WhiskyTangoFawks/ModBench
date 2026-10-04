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
import type { Reporter } from '../ports/reporter';
import { reportFailure } from '../drivingLib/reportFailure';

export const CONFLICT_TABLE_VIEW_TYPE = 'modbench.conflicts';

const SCHEME = 'modbench-conflicts';
const SUFFIX = '.modbench-conflicts';

export const conflictTableUri = (mod: string): vscode.Uri =>
  vscode.Uri.from({ scheme: SCHEME, path: `/${encodeURIComponent(mod)}${SUFFIX}` });

const modOfUri = (uri: vscode.Uri): string => decodeURIComponent(uri.path.slice(1, -SUFFIX.length));

type TableInstance = Pick<InstanceView, 'value' | 'sequence' | 'subscribe'>;

class ConflictTableEditorProvider implements vscode.CustomReadonlyEditorProvider {
  constructor(private readonly instance: TableInstance, private readonly extensionUri: vscode.Uri) {}

  openCustomDocument(uri: vscode.Uri): vscode.CustomDocument {
    return { uri, dispose: () => undefined };
  }

  resolveCustomEditor({ uri }: vscode.CustomDocument, panel: vscode.WebviewPanel): void {
    const mod = modOfUri(uri);
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
  instance: TableInstance, extensionUri: vscode.Uri, viewSelection: () => readonly ModlistNode[], reporter: Reporter,
): vscode.Disposable[] {
  return [
    vscode.window.registerCustomEditorProvider(
      CONFLICT_TABLE_VIEW_TYPE, new ConflictTableEditorProvider(instance, extensionUri),
      { webviewOptions: { retainContextWhenHidden: true } }),
    vscode.commands.registerCommand('modbench.mod.openConflicts', async (clicked?: unknown, selected?: readonly ModlistNode[]) => {
      const mod = modOfConflictColumn(clicked)
        ?? singularArgument(modsGestureEntry(clicked, selected, viewSelection), 'mod')?.mod.name;
      if (mod === undefined) return;
      await reportFailure(reporter, `Failed to open the conflicts of "${mod}".`, async () => {
        await vscode.commands.executeCommand('vscode.openWith', conflictTableUri(mod), CONFLICT_TABLE_VIEW_TYPE, { preview: true });
      });
    }),
  ];
}
