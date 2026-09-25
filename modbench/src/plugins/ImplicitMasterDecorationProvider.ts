import * as vscode from 'vscode';
import { posix } from 'node:path';

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
    // `.path`, never `.fsPath` (Windows round-trips a backslash path through it). The row's
    // parent must equal the Data folder's own URI — a prefix match also catches a sibling.
    if (posix.dirname(uri.path) !== vscode.Uri.file(dataFolder).path) return undefined;
    if (!this.implicitMasterNames().has(posix.basename(uri.path).toLowerCase())) return undefined;
    return { color: new vscode.ThemeColor('disabledForeground') };
  }
}
