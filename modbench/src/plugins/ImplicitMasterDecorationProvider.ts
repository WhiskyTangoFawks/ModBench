import * as vscode from 'vscode';

// Not `file:`: a Data-origin diagnosis is published on the plugin file's own URI, and VS Code
// badges any tree row whose resourceUri carries diagnostics — a badge plugins.md's locked row
// does not draw.
const LOCKED_ROW_SCHEME = 'modbench-locked-plugin';

/** The locked row's identity: its plugin file's path, under a scheme no diagnostic is published on. */
export function lockedRowUri(pluginFile: string): vscode.Uri {
  return vscode.Uri.from({ scheme: LOCKED_ROW_SCHEME, path: vscode.Uri.file(pluginFile).path });
}

/** Grays an implicit master's row as MO2 does for a `forceLoaded` row (ADR-0013);
 *  `TreeItem` has no label-color property, so row coloring must be a
 *  `FileDecorationProvider`. */
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
