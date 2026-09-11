import * as vscode from 'vscode';
import { downloadsDir } from './mo2/layout';

/** Colour only, no badge: Show hidden is additive, so hidden rows sit alongside visible ones
 *  and this tint is the only cue telling them apart — MO2 itself draws none. */
export class HiddenDownloadDecorationProvider implements vscode.FileDecorationProvider {
  private readonly downloadsDir: string;

  constructor(
    instanceRoot: string,
    private readonly hiddenNames: () => ReadonlySet<string>,
  ) {
    this.downloadsDir = downloadsDir(instanceRoot);
  }

  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    if (!uri.fsPath.startsWith(this.downloadsDir + '/')) return undefined;
    const name = uri.fsPath.slice(this.downloadsDir.length + 1);
    if (!this.hiddenNames().has(name)) return undefined;
    // How much dim reads as "hidden" vs "disabled"/"deleted" is a visual call against
    // both a light and dark theme — this colour is a provisional pick.
    return { color: new vscode.ThemeColor('disabledForeground') };
  }
}
