import * as vscode from 'vscode';
import * as path from 'node:path';

/** Tints the Loadout tree's pinned Overwrite row (issue #83) a theme-adaptive
 *  muted red, so the read-only purge-sink fixture reads differently from the mod
 *  rows around it. A `FileDecorationProvider` is VS Code's native row-coloring
 *  mechanism (modbench/CLAUDE.md: don't rebuild what VS Code already does).
 *
 *  Stateless: the overwrite folder path is constant (`<instanceRoot>/overwrite`,
 *  derived exactly as #82's OverwriteNode builds its `resourceUri`, so the fsPath
 *  matches byte-for-byte). VS Code only consults a decoration provider for a URI
 *  it is actually rendering, so a static "decorate that one path" answer is
 *  correct whether or not the row is currently shown — no event, no coupling back
 *  into the tree provider.
 *
 *  `gitDecoration.deletedResourceForeground` is theme-adaptive for light/dark;
 *  `list.errorForeground` is the fallback if it reads too much like "deleted"
 *  (a manual-eyeball visual call, not a code branch). */
export class OverwriteDecorationProvider implements vscode.FileDecorationProvider {
  private readonly overwriteDir: string;

  constructor(instanceRoot: string) {
    this.overwriteDir = path.join(instanceRoot, 'overwrite');
  }

  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    if (uri.fsPath !== this.overwriteDir) return undefined;
    return { color: new vscode.ThemeColor('gitDecoration.deletedResourceForeground') };
  }
}
