import * as vscode from 'vscode';
import type { WorkingTreeState } from './ApiClient';
import { parseRecordResourceUri } from './recordResourceUri';

/** Record-row M/A badges in git's own vocabulary; no D badge, since a deleted record has no
 *  Effective row. Owns an emitter unlike the stateless providers here: a field edit flips a
 *  badge without redrawing the tree. */
export class RecordDecorationProvider implements vscode.FileDecorationProvider {
  private readonly _onDidChangeFileDecorations = new vscode.EventEmitter<vscode.Uri | vscode.Uri[] | undefined>();
  readonly onDidChangeFileDecorations = this._onDidChangeFileDecorations.event;

  constructor(
    private readonly lookup: (plugin: string, origin: string, formKey: string) => WorkingTreeState | undefined,
  ) {}

  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    const identity = parseRecordResourceUri(uri);
    if (!identity) return undefined;
    const state = this.lookup(identity.plugin, identity.origin, identity.formKey);
    if (state === 'Modified') {
      return { badge: 'M', color: new vscode.ThemeColor('gitDecoration.modifiedResourceForeground'), tooltip: 'Modified' };
    }
    if (state === 'Added') {
      return { badge: 'A', color: new vscode.ThemeColor('gitDecoration.addedResourceForeground'), tooltip: 'Added' };
    }
    return undefined;
  }

  refresh(uri: vscode.Uri): void {
    this._onDidChangeFileDecorations.fire(uri);
  }
}
