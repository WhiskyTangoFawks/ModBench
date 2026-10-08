import * as vscode from 'vscode';
import type { RecordBrowser } from './RecordBrowser';

export type RecordBadgeSource = Pick<
  RecordBrowser, 'workingTreeStateOf' | 'statesBeneathOf' | 'isExpanded' | 'onDidReadRecords' | 'onDidReadBeneath'
>;

const MODIFIED = 'gitDecoration.modifiedResourceForeground';
const ADDED = 'gitDecoration.addedResourceForeground';

/** M/A badges in git's vocabulary, and a dot on a collapsed row with changes beneath it, as
 *  VS Code's Explorer draws a collapsed folder. VS Code keeps a decoration until its provider
 *  names the URI. */
export class RecordDecorationProvider implements vscode.FileDecorationProvider, vscode.Disposable {
  private readonly _onDidChangeFileDecorations = new vscode.EventEmitter<vscode.Uri | vscode.Uri[] | undefined>();
  readonly onDidChangeFileDecorations = this._onDidChangeFileDecorations.event;
  private readonly subscriptions: vscode.Disposable[];

  constructor(
    private readonly source: RecordBadgeSource,
    // The locked rows' URIs, whose grey a colour from here would override.
    private readonly lockedRows: () => ReadonlySet<string>,
  ) {
    this.subscriptions = [
      source.onDidReadRecords((uris) => { this._onDidChangeFileDecorations.fire([...uris]); }),
      source.onDidReadBeneath(() => { this._onDidChangeFileDecorations.fire(undefined); }),
    ];
  }

  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    const state = this.source.workingTreeStateOf(uri);
    if (state === 'Modified') {
      return { badge: 'M', color: new vscode.ThemeColor(MODIFIED), tooltip: 'Modified' };
    }
    if (state === 'Added') {
      return { badge: 'A', color: new vscode.ThemeColor(ADDED), tooltip: 'Added' };
    }
    if (this.source.isExpanded(uri) || this.lockedRows().has(uri.toString())) return undefined;
    const beneath = this.source.statesBeneathOf(uri);
    if (beneath.length === 0) return undefined;
    return { badge: '•', color: new vscode.ThemeColor(beneath.includes('Modified') ? MODIFIED : ADDED), tooltip: 'Contains emphasized items' };
  }

  dispose(): void {
    for (const subscription of this.subscriptions) subscription.dispose();
    this._onDidChangeFileDecorations.dispose();
  }
}
