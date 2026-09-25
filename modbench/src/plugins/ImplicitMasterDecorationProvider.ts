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
    // `.path`, never `.fsPath` (Windows round-trips a backslash path through it). `dirname`
    // never carries a trailing separator, so a Data folder setting that does needs stripping.
    const dataPath = vscode.Uri.file(dataFolder).path.replace(/\/+$/, '');
    if (posix.dirname(uri.path) !== dataPath) return undefined;
    if (!this.implicitMasterNames().has(posix.basename(uri.path).toLowerCase())) return undefined;
    return { color: new vscode.ThemeColor('disabledForeground') };
  }
}
