import * as vscode from 'vscode';

/** Colour only, no badge: Show excluded is additive, so excluded rows sit alongside included ones
 *  and this tint is the only cue telling them apart — MO2 itself draws none. */
export class ExcludedDownloadDecorationProvider implements vscode.FileDecorationProvider {
  private readonly _onDidChangeFileDecorations = new vscode.EventEmitter<vscode.Uri[] | undefined>();
  readonly onDidChangeFileDecorations = this._onDidChangeFileDecorations.event;

  constructor(
    // Read fresh on every decoration, not captured once: `download_directory` can move while
    // Modbench runs, and a stale prefix would silently stop matching every row.
    private readonly downloadsDirOf: () => string,
    private readonly excludedNames: () => ReadonlySet<string>,
  ) {}

  /** VS Code never re-queries a `FileDecorationProvider` on its own — call this whenever the rows
   *  it decorates may have changed, exclude and include alike. */
  refresh(): void {
    this._onDidChangeFileDecorations.fire(undefined);
  }

  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    // `.path`, never `.fsPath`: on Windows, `Uri.file` turns a backslash-separated path into
    // `.path`'s forward-slash form, and `.fsPath` turns it back — a hardcoded `/` prefix against
    // `.fsPath` never survives that round trip.
    const prefix = `${vscode.Uri.file(this.downloadsDirOf()).path}/`;
    if (!uri.path.startsWith(prefix)) return undefined;
    const name = uri.path.slice(prefix.length);
    if (!this.excludedNames().has(name)) return undefined;
    // How much dim reads as "excluded" vs "disabled"/"deleted" is a visual call against
    // both a light and dark theme — this colour is a provisional pick.
    return { color: new vscode.ThemeColor('disabledForeground') };
  }
}
