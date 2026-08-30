import * as vscode from 'vscode';
import { join } from 'node:path';

/** Dims a hidden download's row in the Downloads tree (#238 slice 4) — colour only, no
 *  badge, reserved exclusively for the hidden axis (`.meta` `removed=true`). It exists only
 *  because Show hidden is additive (hidden rows appear ALONGSIDE visible ones, not in a
 *  separate list): it's the sole cue telling the two apart, since MO2 itself draws none.
 *
 *  Stateless per call, like OverwriteDecorationProvider — no `onDidChangeFileDecorations`
 *  wiring, because every state change that could flip a row's hidden-ness (Hide/Unhide,
 *  the Show-hidden toggle) already goes through DownloadsProvider.invalidate(), and a
 *  TreeDataProvider firing onDidChangeTreeData makes VS Code re-fetch and redraw the
 *  affected items, which re-queries FileDecorationProvider for each redrawn URI — so there's
 *  no state change this provider could miss without its own event. `hiddenNames` is read
 *  lazily on each call rather than captured once, so it always reflects the provider's live
 *  cache. */
export class HiddenDownloadDecorationProvider implements vscode.FileDecorationProvider {
  private readonly downloadsDir: string;

  constructor(
    instanceRoot: string,
    private readonly hiddenNames: () => ReadonlySet<string>,
  ) {
    this.downloadsDir = join(instanceRoot, 'downloads');
  }

  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    if (!uri.fsPath.startsWith(this.downloadsDir + '/')) return undefined;
    const name = uri.fsPath.slice(this.downloadsDir.length + 1);
    if (!this.hiddenNames().has(name)) return undefined;
    // needs-solo-load order (#238): how much dim reads as "hidden" vs "disabled"/"deleted" is a
    // visual call against both a light and dark theme — this colour is a provisional pick.
    return { color: new vscode.ThemeColor('disabledForeground') };
  }
}
