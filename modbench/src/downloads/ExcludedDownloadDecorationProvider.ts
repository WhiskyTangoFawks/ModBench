import * as vscode from 'vscode';

/** Colour only, no badge: Show excluded is additive, so excluded rows sit alongside included ones
 *  and this tint is the only cue telling them apart — MO2 itself draws none. */
export class ExcludedDownloadDecorationProvider implements vscode.FileDecorationProvider {
  constructor(
    private readonly downloadsDir: string,
    private readonly excludedNames: () => ReadonlySet<string>,
  ) {}

  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    if (!uri.fsPath.startsWith(this.downloadsDir + '/')) return undefined;
    const name = uri.fsPath.slice(this.downloadsDir.length + 1);
    if (!this.excludedNames().has(name)) return undefined;
    // How much dim reads as "excluded" vs "disabled"/"deleted" is a visual call against
    // both a light and dark theme — this colour is a provisional pick.
    return { color: new vscode.ThemeColor('disabledForeground') };
  }
}
