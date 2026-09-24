import * as vscode from 'vscode';

/** Colour only, no badge: Show excluded is additive, so excluded rows sit alongside included ones
 *  and this tint is the only cue telling them apart — MO2 itself draws none. */
export class ExcludedDownloadDecorationProvider implements vscode.FileDecorationProvider {
  // `.path`, never `.fsPath`: a URI's path is always forward-slash, so a Windows `fsPath`
  // (backslash) still compares correctly, where a hardcoded `/` prefix never could.
  private readonly downloadsDirPath: string;
  private readonly _onDidChangeFileDecorations = new vscode.EventEmitter<vscode.Uri[] | undefined>();
  readonly onDidChangeFileDecorations = this._onDidChangeFileDecorations.event;

  constructor(
    downloadsDir: string,
    private readonly excludedNames: () => ReadonlySet<string>,
  ) {
    this.downloadsDirPath = vscode.Uri.file(downloadsDir).path;
  }

  /** VS Code never re-queries a `FileDecorationProvider` on its own — call this whenever the rows
   *  it decorates may have changed, exclude and include alike. */
  refresh(): void {
    this._onDidChangeFileDecorations.fire(undefined);
  }

  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    const prefix = `${this.downloadsDirPath}/`;
    if (!uri.path.startsWith(prefix)) return undefined;
    const name = uri.path.slice(prefix.length);
    if (!this.excludedNames().has(name)) return undefined;
    // How much dim reads as "excluded" vs "disabled"/"deleted" is a visual call against
    // both a light and dark theme — this colour is a provisional pick.
    return { color: new vscode.ThemeColor('disabledForeground') };
  }
}
