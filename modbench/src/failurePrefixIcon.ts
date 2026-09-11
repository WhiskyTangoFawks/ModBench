import * as vscode from 'vscode';

/** The Plugins tree's one failure prefix (ADR-0019's error tier): load failure, unresolved
 *  masters and an unreadable record on or below a node all carry this icon, so the tree reads as
 *  one signal. */
export function failurePrefixIcon(): vscode.ThemeIcon {
  return new vscode.ThemeIcon('error', new vscode.ThemeColor('problemsErrorIcon.foreground'));
}
