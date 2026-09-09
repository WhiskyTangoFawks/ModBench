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

// The record filter scopes which records a plugin row's children show — a distinct concern from
// the record-panel and reveal commands, so it is its own registration.
export function registerFilterCommands(scriptsPath: string, controller: EditingController): vscode.Disposable[] {
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
      await controller.setFilter(sql, picked.label);
    }),
    vscode.commands.registerCommand('modbench.setFilterFromDocument', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) return;
      const sql = editor.document.getText();
      await controller.setFilter(sql, editor.document.isUntitled ? 'document' : path.basename(editor.document.fileName));
    }),
    vscode.commands.registerCommand('modbench.clearFilter', () => controller.clearFilter()),
  ];
}
