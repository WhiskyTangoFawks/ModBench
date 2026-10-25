import * as vscode from 'vscode';
import type { RecordTabs } from './recordTabs';

const CONTEXT_KEY = 'modbench.record.noConflictCollapsed';

/** The context key outlives an extension host restart, so each activation tells it every row shows. */
export function registerNoConflictLens(tabs: Pick<RecordTabs, 'collapseNoConflict'>): vscode.Disposable[] {
  const show = (collapsed: boolean) => {
    tabs.collapseNoConflict(collapsed);
    void vscode.commands.executeCommand('setContext', CONTEXT_KEY, collapsed);
  };
  void vscode.commands.executeCommand('setContext', CONTEXT_KEY, false);
  return [
    vscode.commands.registerCommand('modbench.record.collapseNoConflict', () => { show(true); }),
    vscode.commands.registerCommand('modbench.record.showNoConflict', () => { show(false); }),
  ];
}
