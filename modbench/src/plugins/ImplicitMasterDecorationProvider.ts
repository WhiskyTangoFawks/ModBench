import * as vscode from 'vscode';
import { posix } from 'node:path';

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
    // A getter, not a settled Promise — `modbench.mods.gameDirectory` is editable while
    // Modbench runs, so a value captured once at construction could go stale for the life of the
    // provider. Each call re-reads through the single game-directory resolver.
    private readonly dataFolder: () => Promise<string | undefined>,
    private readonly implicitMasterNames: () => ReadonlySet<string>,
  ) {}

  async provideFileDecoration(uri: vscode.Uri): Promise<vscode.FileDecoration | undefined> {
    if (uri.scheme !== LOCKED_ROW_SCHEME) return undefined;
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
