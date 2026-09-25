import * as vscode from 'vscode';

/** Grays an implicit master's row as MO2 does for a `forceLoaded` row (ADR-0013);
 *  `TreeItem` has no label-color property, so row coloring must be a
 *  `FileDecorationProvider`. */
export class ImplicitMasterDecorationProvider implements vscode.FileDecorationProvider {
  constructor(
    // A getter, not a settled Promise — `modbench.mods.gameDirectory` is editable while
    // Modbench runs, so a value captured once at construction could go stale for the life of the
    // provider. Each call re-reads through the single game-directory resolver.
    private readonly dataFolder: () => Promise<string | undefined>,
    private readonly implicitMasterNames: () => ReadonlySet<string>,
  ) {}

  async provideFileDecoration(uri: vscode.Uri): Promise<vscode.FileDecoration | undefined> {
    const dataFolder = await this.dataFolder();
    if (!dataFolder) return undefined;
    // `.path`, never `.fsPath`: on Windows, `Uri.file` turns a backslash-separated path into
    // `.path`'s forward-slash form, and `.fsPath` turns it back — a hardcoded `/` join against
    // `.fsPath` never survives that round trip.
    const prefix = `${vscode.Uri.file(dataFolder).path}/`;
    if (!uri.path.startsWith(prefix)) return undefined;
    const name = uri.path.slice(prefix.length);
    if (!this.implicitMasterNames().has(name.toLowerCase())) return undefined;
    return { color: new vscode.ThemeColor('disabledForeground') };
  }
}
