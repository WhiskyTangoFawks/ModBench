import * as vscode from 'vscode';
import type { WorkingTreeState } from '../client';
import { parseRecordResourceUri } from './recordResourceUri';

/** Editor's own view of the tree whose rows it badges: a structural shape, not
 *  `PluginTreeProvider` itself, since Editor names no Plugins-view type. */
export interface RecordBadgeSource {
  workingTreeStateOf(plugin: string, origin: string, formKey: string): WorkingTreeState | undefined;
  /** The rows a read from mEdit just answered, so their badges follow that read. */
  onDidReadRecords(listener: (uris: readonly vscode.Uri[]) => void): vscode.Disposable;
}

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
    const identity = parseRecordResourceUri(uri);
    if (!identity) return undefined;
    const state = this.source.workingTreeStateOf(identity.plugin, identity.origin, identity.formKey);
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
