import * as vscode from 'vscode';
import type { RecordBrowser } from './RecordBrowser';

export type RecordBadgeSource = Pick<RecordBrowser, 'workingTreeStateOf' | 'onDidReadRecords'>;


/** Record-row M/A badges in git's vocabulary; a deleted record has no row, so no D. VS Code keeps
 *  a decoration until its provider names the URI, so each read from mEdit names its rows. */
export class RecordDecorationProvider implements vscode.FileDecorationProvider, vscode.Disposable {
  private readonly _onDidChangeFileDecorations = new vscode.EventEmitter<vscode.Uri | vscode.Uri[] | undefined>();
  readonly onDidChangeFileDecorations = this._onDidChangeFileDecorations.event;
  private readonly reads: vscode.Disposable;

  constructor(private readonly source: RecordBadgeSource) {
    this.reads = source.onDidReadRecords((uris) => { this._onDidChangeFileDecorations.fire([...uris]); });
  }

  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    const state = this.source.workingTreeStateOf(uri);
    if (state === 'Modified') {
      return { badge: 'M', color: new vscode.ThemeColor('gitDecoration.modifiedResourceForeground'), tooltip: 'Modified' };
    }
    if (state === 'Added') {
      return { badge: 'A', color: new vscode.ThemeColor('gitDecoration.addedResourceForeground'), tooltip: 'Added' };
    }
    return undefined;
  }

  dispose(): void {
    this.reads.dispose();
    this._onDidChangeFileDecorations.dispose();
  }
}
