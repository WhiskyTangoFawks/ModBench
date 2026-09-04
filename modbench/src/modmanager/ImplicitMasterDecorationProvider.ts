import * as vscode from 'vscode';

/** Grays an implicit master's row as MO2 does for a `forceLoaded` row (ADR-0035);
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
    if (!dataFolder || !uri.fsPath.startsWith(dataFolder + '/')) return undefined;
    const name = uri.fsPath.slice(dataFolder.length + 1);
    if (!this.implicitMasterNames().has(name.toLowerCase())) return undefined;
    return { color: new vscode.ThemeColor('disabledForeground') };
  }
}
