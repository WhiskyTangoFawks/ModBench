import * as vscode from 'vscode';

/** Grays an implicit master's row (#276 / ADR-0035) — MO2's `foregroundData()` grays
 *  `COL_NAME` for a `forceLoaded` row; this is the same effect via the same mechanism
 *  `HiddenDownloadDecorationProvider` (#238) already uses for a comparable "not a state
 *  you can change" row, since `TreeItem` has no direct label-color property
 *  (`modbench/CLAUDE.md`: row coloring is `FileDecorationProvider`, not a bespoke widget).
 *
 *  Stateless per call, same as `OverwriteDecorationProvider`/`HiddenDownloadDecorationProvider`
 *  — every state change that could add/remove an implicit master already goes through
 *  `PluginListProvider.invalidate()`, whose `onDidChangeTreeData` makes VS Code re-fetch and
 *  redraw, which re-queries this provider for each redrawn URI. `implicitMasterNames` is read
 *  lazily (live, not a snapshot) — `PluginListProvider.implicitMasterNames()`. */
export class ImplicitMasterDecorationProvider implements vscode.FileDecorationProvider {
  constructor(
    // #357: a getter, not a settled Promise — `modbench.mods.gameDirectory` is editable while
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
