import * as vscode from 'vscode';

/** Inline error surface, shared by every Mod Management tree provider: rendered instead of an
 *  empty list when that provider's own read/scan fails, so a failure is never indistinguishable
 *  from "nothing here" (ADR-0026). Each provider decides for itself what counts as a failure
 *  worth this row (e.g. a missing folder is often a structural-absence empty state, not an error
 *  — see each provider's own `load()`/`getChildren()`) — this class only renders the row once
 *  that decision has been made. */
export class ErrorNode extends vscode.TreeItem {
  readonly kind = 'error' as const;
  constructor(message: string) {
    super(`⚠ Failed to load: ${message}`, vscode.TreeItemCollapsibleState.None);
    this.contextValue = 'error';
    this.tooltip = message;
    this.iconPath = new vscode.ThemeIcon('error');
  }
}
