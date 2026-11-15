import * as vscode from 'vscode';
import type { RecordBrowser } from './RecordBrowser';
import { parseRecordResourceUri, parseRowResourceUri } from './recordResourceUri';
import { pluginAddressKey, type PluginAddress } from '../wire/pluginAddress';

export type RecordBadgeSource = Pick<
  RecordBrowser, 'workingTreeStateOf' | 'statesBeneathOf' | 'isExpanded' | 'onDidReadRecords' | 'onDidChangeStatesBeneath'
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
  // The rows VS Code asked a decoration of, by plugin: the rows a change of that plugin's states beneath asks again.
  private readonly asked = new Map<string, Map<string, vscode.Uri>>();

  constructor(
    private readonly source: RecordBadgeSource,
    // The locked rows' URIs, whose grey a colour from here would override.
    private readonly lockedRows: () => ReadonlySet<string>,
  ) {
    this.subscriptions = [
      source.onDidReadRecords((uris) => { this._onDidChangeFileDecorations.fire([...uris]); }),
      source.onDidChangeStatesBeneath((plugins) => { this.askAgain(plugins); }),
    ];
  }

  provideFileDecoration(uri: vscode.Uri): vscode.ProviderResult<vscode.FileDecoration> {
    this.remember(uri);
    const state = this.source.workingTreeStateOf(uri);
    if (state === 'Modified') {
      return { badge: 'M', color: new vscode.ThemeColor(MODIFIED), tooltip: 'Modified' };
    }
    if (state === 'Added') {
      return { badge: 'A', color: new vscode.ThemeColor(ADDED), tooltip: 'Added' };
    }
    if (this.source.isExpanded(uri) || this.lockedRows().has(uri.toString())) return undefined;
    return this.beneath(uri);
  }

  // The rows asked again are asked of again by VS Code if still shown, and remembered then.
  private askAgain(plugins: readonly PluginAddress[] | undefined): void {
    if (plugins === undefined) {
      this.asked.clear();
      this._onDidChangeFileDecorations.fire(undefined);
      return;
    }
    const keys = plugins.map(pluginAddressKey);
    this._onDidChangeFileDecorations.fire(keys.flatMap((key) => [...this.asked.get(key)?.values() ?? []]));
    for (const key of keys) this.asked.delete(key);
  }

  private remember(uri: vscode.Uri): void {
    const identity = parseRecordResourceUri(uri) ?? parseRowResourceUri(uri);
    if (identity === undefined) return;
    const key = pluginAddressKey(identity.plugin);
    const rows = this.asked.get(key) ?? new Map<string, vscode.Uri>();
    rows.set(uri.toString(), uri);
    this.asked.set(key, rows);
  }

  private async beneath(uri: vscode.Uri): Promise<vscode.FileDecoration | undefined> {
    const beneath = await this.source.statesBeneathOf(uri);
    if (beneath.length === 0) return undefined;
    return { badge: '•', color: new vscode.ThemeColor(beneath.includes('Modified') ? MODIFIED : ADDED), tooltip: 'Contains emphasized items' };
  }

  dispose(): void {
    for (const subscription of this.subscriptions) subscription.dispose();
    this._onDidChangeFileDecorations.dispose();
  }
}
