import * as vscode from 'vscode';

/** A row with a `resourceUri` and no `iconPath` takes an icon from the file icon theme; this
 *  draws none. */
export function blankIcon(): vscode.ThemeIcon {
  return new vscode.ThemeIcon('blank');
}
