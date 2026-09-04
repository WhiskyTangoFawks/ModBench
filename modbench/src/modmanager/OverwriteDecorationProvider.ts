import * as vscode from 'vscode';
import * as path from 'node:path';

/** VS Code consults a decoration provider only for a URI it is rendering, so a static answer
 *  needs no event and no coupling back into the tree provider. The colour is theme-adaptive. */
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
