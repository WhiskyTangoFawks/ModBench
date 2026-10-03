import * as vscode from 'vscode';

/** The Plugins tree's red `$(error)` icon (plugins.md, A row), one signal for every failure. */
export function failurePrefixIcon(): vscode.ThemeIcon {
  return new vscode.ThemeIcon('error', new vscode.ThemeColor('problemsErrorIcon.foreground'));
}
