import * as vscode from 'vscode';

/** Rendered instead of an empty list when a provider's read fails, so a failure is never
 *  indistinguishable from "nothing here" (ADR-0026). */
export class ErrorNode extends vscode.TreeItem {
  readonly kind = 'error' as const;
  constructor(message: string) {
    super(`⚠ Failed to load: ${message}`, vscode.TreeItemCollapsibleState.None);
    this.contextValue = 'error';
    this.tooltip = message;
    this.iconPath = new vscode.ThemeIcon('error');
  }
}
