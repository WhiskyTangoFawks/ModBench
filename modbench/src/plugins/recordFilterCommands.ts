import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import type { EditingController } from '../medit/EditingController';
import type { InteriorLoadMoreNode, PluginTreeProvider } from './PluginTreeProvider';

// The row's own load-more gesture: a partial record page grew a synthetic "load more" leaf, and
// this is the only thing that leaf's click does.
export function registerLoadMoreCommand(treeProvider: PluginTreeProvider): vscode.Disposable {
  return vscode.commands.registerCommand('modbench.loadMore', (node: InteriorLoadMoreNode) => treeProvider.loadMore(node));
}

export interface FilterCommandDeps {
  scriptsPath: string;
  controller: EditingController;
  treeProvider: PluginTreeProvider;
  /** Symmetric on purpose: a stale `false` surviving a clear would leave a plugin permanently
   *  unexpandable (ADR-0035). */
  refreshMatchingPlugins: () => void;
  /** The record filter's single writer — the context key, the code lens's active SQL, and the
   *  Plugins tree's readout. */
  setFilterActive: (active: boolean, sql?: string, label?: string) => void;
}

// The record filter scopes which records a plugin row's children show — a distinct concern from
// the record-panel and reveal commands, so it is its own registration.
export function registerFilterCommands(deps: FilterCommandDeps): vscode.Disposable[] {
  const { scriptsPath, controller, treeProvider, refreshMatchingPlugins, setFilterActive } = deps;

  const applyFilter = async (sql: string, label?: string): Promise<void> => {
    const error = await controller.setFilter(sql);
    if (error) {
      void vscode.window.showErrorMessage(`mEdit: Filter failed — ${error}`);
      return;
    }
    setFilterActive(true, sql, label);
    treeProvider.refresh();
    refreshMatchingPlugins();
  };

  return [
    vscode.commands.registerCommand('modbench.setFilter', async () => {
      const files = fs.existsSync(scriptsPath)
        ? fs.readdirSync(scriptsPath).filter(f => f.endsWith('.sql'))
        : [];
      const NEW_FILTER_LABEL = '$(add) New filter…';
      const items: vscode.QuickPickItem[] = [
        ...files.map(f => ({ label: f, description: scriptsPath })),
        { label: NEW_FILTER_LABEL },
      ];
      const picked = await vscode.window.showQuickPick(items, { placeHolder: 'Select .sql filter file' });
      if (!picked) return;
      if (picked.label === NEW_FILTER_LABEL) {
        const doc = await vscode.workspace.openTextDocument({ language: 'sql' });
        await vscode.window.showTextDocument(doc);
        return;
      }
      const filePath = path.join(scriptsPath, picked.label);
      const sql = fs.readFileSync(filePath, 'utf8');
      await applyFilter(sql, picked.label);
    }),
    vscode.commands.registerCommand('modbench.setFilterFromDocument', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) return;
      const sql = editor.document.getText();
      await applyFilter(sql, editor.document.isUntitled ? 'document' : path.basename(editor.document.fileName));
    }),
    vscode.commands.registerCommand('modbench.clearFilter', async () => {
      await controller.clearFilter();
      setFilterActive(false);
      treeProvider.refresh();
      refreshMatchingPlugins();
    }),
  ];
}
