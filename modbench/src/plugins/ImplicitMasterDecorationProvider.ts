import * as vscode from 'vscode';

/** Grays an implicit master's row (plugins.md, A plugin the game loads with no line). `TreeItem`
 *  has no label-color property, so row coloring must be a `FileDecorationProvider`. */
export class ImplicitMasterDecorationProvider implements vscode.FileDecorationProvider {
  constructor(
    // The URIs of the locked rows the tree renders now, read at each call, so the grey follows
    // the rows and never a copy of them.
    private readonly lockedRowUris: () => ReadonlySet<string>,
  ) {}

  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    if (!this.lockedRowUris().has(uri.toString())) return undefined;
    return { color: new vscode.ThemeColor('disabledForeground') };
  }
}
