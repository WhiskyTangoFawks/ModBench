// mods-conflicts.md, Opening and States: a mod's conflict table, a read-only custom editor over an
// address of its own, so preview, an open tab and restore-after-reload are VS Code's.

import * as vscode from 'vscode';
import type { Instance, InstanceView } from '../instanceLoader/instance';
import { showWebviewPage } from '../drivingLib/webviewPage';
import {
  CONFLICT_CELL_VALUES, CONFLICT_TABLE_SHOWN, isConflictTableReady, modOfConflictColumn, type ConflictCellValue, type ConflictTable, type ConflictTableShown,
} from '../wire/conflictTable';
import { originLabel } from '../instanceLoader/fileConflictIndex';
import { conflictPaths, conflictTable } from './conflictTable';
import { gestureEntry, singularArgument } from '../drivingLib/gestureEntry';
import type { ModlistNode } from './ModListProvider';
import type { Reporter } from '../ports/reporter';
import { reportFailure } from '../drivingLib/reportFailure';
import { errorMessage } from '../ports/errorMessage';
import type { WorkspaceSettings } from './workspaceSettings';

export const CONFLICT_TABLE_VIEW_TYPE = 'modbench.conflicts';
export const CELL_VALUE_SETTING = 'modbench.mods.conflictTable.cellValue';

const SCHEME = 'modbench-conflicts';
const SUFFIX = '.modbench-conflicts';

const conflictTableUri = (mod: string): vscode.Uri =>
  vscode.Uri.from({ scheme: SCHEME, path: `/${encodeURIComponent(mod)}${SUFFIX}` });

const modOfUri = (uri: vscode.Uri): string => decodeURIComponent(uri.path.slice(1, -SUFFIX.length));

type TableInstance = Pick<InstanceView, 'value' | 'sequence' | 'subscribe'> & Pick<Instance, 'sameCopies'>;

class ConflictTableEditorProvider implements vscode.CustomReadonlyEditorProvider {
  constructor(
    private readonly instance: TableInstance, private readonly extensionUri: vscode.Uri, private readonly reporter: Reporter,
    private readonly settings: WorkspaceSettings,
  ) {}

  private cellValue(): ConflictCellValue {
    const chosen = CONFLICT_CELL_VALUES.find((value) => value === this.settings.getConfiguration().get(CELL_VALUE_SETTING));
    return chosen ?? 'size';
  }

  openCustomDocument(uri: vscode.Uri): vscode.CustomDocument {
    return { uri, dispose: () => undefined };
  }

  resolveCustomEditor({ uri }: vscode.CustomDocument, panel: vscode.WebviewPanel): void {
    const mod = modOfUri(uri);
    panel.title = `Conflicts: ${mod}`;
    let newest = 0;
    let told = new Set<string>();
    let lastGood: ConflictTable | undefined;
    const post = (table: ConflictTable, notice?: string) => {
      const message: ConflictTableShown = notice === undefined
        ? { type: CONFLICT_TABLE_SHOWN, table } : { type: CONFLICT_TABLE_SHOWN, table, notice };
      void panel.webview.postMessage(message);
    };
    const show = async (view: Pick<InstanceView, 'value' | 'sequence'>) => {
      const mine = ++newest;
      try {
        const copies = await this.instance.sameCopies(conflictPaths(view, mod));
        if (mine !== newest) return;
        const unreadable = copies.flatMap(({ relativePath, copies: each }) => each.flatMap((copy) =>
          (copy.kind === 'unreadable' ? [{ key: JSON.stringify([copy.origin, relativePath, copy.reason]), relativePath, copy }] : [])));
        for (const { key, relativePath, copy } of unreadable) {
          if (!told.has(key)) {
            this.reporter.shownOnSurface('warning', `Conflicts: "${originLabel(copy.origin)}"'s copy of ${relativePath} could not be read.`, copy.reason);
          }
        }
        told = new Set(unreadable.map(({ key }) => key));
        const table = conflictTable(view, mod, copies, this.cellValue());
        if (view.sequence > 0) lastGood = table;
        post(table);
      } catch (err) {
        if (mine !== newest) return;
        const reason = errorMessage(err);
        this.reporter.shownOnSurface('error', `Failed to read the copies of "${mod}"'s conflicts.`, reason);
        if (lastGood === undefined) post({ kind: 'error', reason });
        else post(lastGood, `Showing the last good read: ${reason}`);
      }
    };
    const subscription = this.instance.subscribe((value, sequence) => void show({ value, sequence }));
    const setting = this.settings.onDidChangeConfiguration((change) => {
      if (change.affectsConfiguration(CELL_VALUE_SETTING)) void show(this.instance);
    });
    panel.onDidDispose(() => {
      subscription.dispose();
      setting.dispose();
    });
    panel.webview.onDidReceiveMessage((message: unknown) => {
      if (isConflictTableReady(message)) void show(this.instance);
    });
    showWebviewPage(panel.webview, this.extensionUri, { script: 'conflicts.js' });
  }
}

/** commands.md, `open conflicts`: the mod of a Mods row, a column header, or the palette's one
 *  selected mod. */
export function registerConflictTable(
  instance: TableInstance, extensionUri: vscode.Uri, viewSelection: () => readonly ModlistNode[], reporter: Reporter,
  settings: WorkspaceSettings,
): vscode.Disposable[] {
  return [
    vscode.window.registerCustomEditorProvider(
      CONFLICT_TABLE_VIEW_TYPE, new ConflictTableEditorProvider(instance, extensionUri, reporter, settings),
      { webviewOptions: { retainContextWhenHidden: true } }),
    vscode.commands.registerCommand('modbench.mod.openConflicts', async (clicked?: unknown, selected?: readonly ModlistNode[]) => {
      const mod = modOfConflictColumn(clicked)
        ?? singularArgument(gestureEntry(clicked, selected, viewSelection), 'mod')?.mod.name;
      if (mod === undefined) return;
      await reportFailure(reporter, `Failed to open the conflicts of "${mod}".`, async () => {
        await vscode.commands.executeCommand('vscode.openWith', conflictTableUri(mod), CONFLICT_TABLE_VIEW_TYPE, { preview: true });
      });
    }),
  ];
}
