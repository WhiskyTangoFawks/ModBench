import * as vscode from 'vscode';
import type { RecordTabs } from './recordTabs';

const CONTEXT_KEY = 'modbench.record.noConflictCollapsed';

/** The title-bar toggle of Collapse No Conflict. Like the sort direction, it is a lens: each
 *  activation starts showing every row, and the context key, which outlives an extension host
 *  restart, is told so. */
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
