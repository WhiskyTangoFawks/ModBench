import * as vscode from 'vscode';

/** The one failure prefix in the Plugins tree (ADR-0026's error tier): a plugin that failed to
 *  load, one whose masters do not resolve, and every node with an unreadable record on or below
 *  it all carry this same icon, so the tree reads as one signal rather than four. */
export function failurePrefixIcon(): vscode.ThemeIcon {
  return new vscode.ThemeIcon('error', new vscode.ThemeColor('problemsErrorIcon.foreground'));
}
