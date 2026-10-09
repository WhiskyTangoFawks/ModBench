import * as vscode from 'vscode';
import type { MEditClient } from '../client';
import { pluginAddressOf, samePluginAddress } from '../wire/pluginAddress';
import { showWebviewPage } from '../drivingLib/webviewPage';
import { routeRecordPanelMessage, routerDepsForTab, type SharedRecordPanelDeps, type TabDocument } from './recordPanelMessageRouter';
import type { EditAddress, RecordTab } from './recordTab';
import type { RecordTabs } from './recordTabs';
import type { FileMove } from '../drivingLib/applyWorkspaceChanges';
import { recordTitle } from './recordTitle';
import { inTabsStead, type TabShowOptions } from './inTabsStead';
import type { CopyChanged } from './recordCopy';
import { fileText } from './fileText';
import {
  CHILD_RECORD_SCHEME, RENDERED_DOCUMENT_SCHEME, copyDocument, copyOf, type RecordCopy, type RecordDocument,
} from '../drivingLib/recordDocument';
import { errorMessage } from '../ports/errorMessage';
import { EXTENSION_TO_WEBVIEW, WEBVIEW_TO_EXTENSION, parseWebviewToExtension, type ViewState } from '../wire/messages';

export const RECORD_VIEW_TYPE = 'modbench.record';

interface RecordEditorProviderDeps {
  context: Pick<vscode.ExtensionContext, 'extensionUri'>;
  tabs: RecordTabs;
  routerDeps: SharedRecordPanelDeps;
  client: Pick<MEditClient, 'getRecordOwner' | 'getCopyDocument' | 'getRecordOfFile'>;
  channel: Pick<vscode.LogOutputChannel, 'warn'>;
}

interface GridPage { columns: readonly RecordCopy[]; place?: ViewState }

// What a file's tab shows once an edit moves the file.
interface MovedTab extends RecordCopy { from?: string; columns: readonly RecordCopy[]; place: ViewState | undefined }

// Where `uri` stands once each move is made in order, each against the tree the one before it left.
const movedTo = (uri: vscode.Uri, moves: readonly FileMove[]): vscode.Uri => moves.reduce((at, { from, to }) => {
  if (at.path === from.path) return to;
  return at.path.startsWith(`${from.path}/`) ? to.with({ path: to.path + at.path.slice(from.path.length) }) : at;
}, uri);

// The grid as VS Code's editor for a record's file, a child's or a rendered document. A file's
// tab restored before mEdit holds the load order asks again on each load-order status.
export class RecordEditorProvider implements vscode.CustomTextEditorProvider {
  // The columns and place an open asks for, until the tab it opens takes them.
  private readonly toShow = new Map<string, GridPage>();
  private readonly moved = new Map<string, MovedTab>();
  // The copies mEdit reported changed while the child records' tabs were following theirs.
  private toFollow: CopyChanged | undefined;
  private following = false;

  constructor(private readonly deps: RecordEditorProviderDeps) {}

  /** Opens the grid on `uri`, with `columns` beside the document's own copy, and none when there
   *  are none, so a tab shown again shows every active plugin's copy. */
  async open(uri: vscode.Uri, columns: readonly RecordCopy[], options: TabShowOptions, place?: ViewState): Promise<void> {
    const key = uri.toString();
    this.toShow.set(key, { columns, place });
    let untaken: readonly RecordCopy[] | undefined;
    try {
      await vscode.commands.executeCommand('vscode.openWith', uri, RECORD_VIEW_TYPE, options);
    } finally {
      untaken = this.toShow.get(key)?.columns;
      this.toShow.delete(key);
    }
    if (!untaken) return;
    // No new tab took them, so VS Code showed the document's tab already open in the group, which
    // is active now (editor.md, Opening, story 3).
    for (const tab of this.deps.tabs) {
      if (tab.copy && tab.document.toString() === key && tab.panel.active) tab.postOnceListening({ type: EXTENSION_TO_WEBVIEW.SHOW_COLUMNS, columns: [...untaken] });
    }
  }

  /** Each child record's tab whose record mEdit reports changed follows it to the document that carries
   *  it now, as a file's tab follows its file (editor.md, Opening, story 10). */
  followCarried(affects: CopyChanged): Promise<void> {
    const queued = this.toFollow;
    this.toFollow = queued ? (copy) => queued(copy) || affects(copy) : affects;
    return this.following ? Promise.resolve() : this.followQueued();
  }

  private async followQueued(): Promise<void> {
    this.following = true;
    try {
      for (let changed = this.takeQueued(); changed; changed = this.takeQueued()) {
        // One tab at a time, as each opens and closes tabs in its group.
        for (const tab of [...this.deps.tabs]) {
          const { copy } = tab;
          if (tab.document.scheme === CHILD_RECORD_SCHEME && copy && changed(copy)) await this.follow(tab, copy);
        }
      }
    } finally {
      this.following = false;
    }
  }

  private takeQueued(): CopyChanged | undefined {
    const queued = this.toFollow;
    this.toFollow = undefined;
    return queued;
  }

  private async follow(tab: RecordTab, copy: RecordCopy): Promise<void> {
    const uri = tab.document;
    const staying = `${copy.formKey}'s tab stays on ${uri.toString(true)}`;
    try {
      const carrying = await copyDocument(this.deps.client, copy);
      if ('refused' in carrying) {
        this.deps.channel.warn(`${staying}: ${carrying.refused}`);
        return;
      }
      if (carrying.uri.toString() === uri.toString()) return;
      const shownIn = vsCodeTabOf(tab);
      if (!shownIn) {
        this.deps.channel.warn(`${staying}: VS Code shows the tab in no group.`);
        return;
      }
      const [columns, place] = [tab.columns, tab.place];
      await inTabsStead(shownIn, (options) => this.open(carrying.uri, columns, options, place));
    } catch (err) {
      this.deps.channel.warn(`${staying}: ${errorMessage(err)}`);
    }
  }

  /** The document carrying the record: the tab's that shows it, or the one it opens as. */
  documentCarrying({ formKey, plugin }: EditAddress): Promise<RecordDocument> {
    for (const tab of this.deps.tabs) {
      const { copy } = tab;
      if (copy?.formKey === formKey && samePluginAddress(copy.plugin, plugin)) return Promise.resolve({ uri: tab.document });
    }
    return copyDocument(this.deps.client, { formKey, plugin });
  }

  /** Each file's tab a move takes along shows, where it lands, the record it showed, or the one the
   *  edit moved it to, with the same columns and place. Answers what undoes that for a move not made. */
  moving(moves: readonly FileMove[], edited: EditAddress, newFormKey: string | undefined): () => void {
    const landings: string[] = [];
    for (const tab of this.deps.tabs) {
      const { document: uri, copy } = tab;
      const to = movedTo(uri, moves);
      if (uri.scheme !== 'file' || to === uri || !copy) continue;
      const kept = { plugin: copy.plugin, columns: tab.columns, place: tab.place };
      const rekeyed = newFormKey !== undefined && copy.formKey === edited.formKey && samePluginAddress(copy.plugin, edited.plugin);
      this.moved.set(to.toString(), rekeyed ? { ...kept, formKey: newFormKey, from: copy.formKey } : { ...kept, formKey: copy.formKey });
      landings.push(to.toString());
    }
    return () => { for (const landing of landings) this.moved.delete(landing); };
  }

  async resolveCustomTextEditor(document: vscode.TextDocument, panel: vscode.WebviewPanel): Promise<void> {
    const key = document.uri.toString();
    const { columns, place } = this.toShow.get(key) ?? { columns: [] };
    this.toShow.delete(key);
    const tab = this.deps.tabs.open(panel, document.uri);
    if (document.uri.scheme === RENDERED_DOCUMENT_SCHEME) {
      const copy = copyOf(document.uri);
      const documentText = (pluginActive: boolean) => Promise.resolve(pluginActive ? undefined : document.getText());
      this.show(panel, tab, copy, { columns, place }, { titleFromRead: () => undefined, plugin: copy.plugin, documentText });
      return;
    }
    if (document.uri.scheme === CHILD_RECORD_SCHEME) {
      // The file is the container's, so its name is not the child's.
      const copy = copyOf(document.uri);
      panel.title = recordTitle(copy.formKey, undefined);
      this.showFile(panel, tab, document, copy, { columns, place }, (read, titled) => { panel.title = recordTitle(read, titled, copy.plugin); });
      return;
    }
    const moved = this.moved.get(key);
    if (moved) {
      this.moved.delete(key);
      this.showFile(panel, tab, document, moved, moved, () => undefined);
      if (moved.from) tab.moved(moved.plugin, moved.from, moved.formKey);
      return;
    }
    const { fsPath } = document.uri;
    let shownReason: string | undefined;
    const read = async (): Promise<void> => {
      try {
        const record = await this.deps.client.getRecordOfFile(fsPath);
        if (!tab.awaitsRecord) return;
        if (record === null) {
          await this.reopenAsText(tab);
          return;
        }
        const { formKey, ...copy } = record;
        this.showFile(panel, tab, document, { formKey, plugin: pluginAddressOf(copy) }, { columns, place }, () => undefined);
      } catch (err) {
        const reason = errorMessage(err);
        if (reason === shownReason || !tab.awaitsRecord) return;
        shownReason = reason;
        this.deps.channel.warn(`Failed to read ${fsPath}: ${reason}`);
        showWebviewPage(panel.webview, this.deps.context.extensionUri, { script: 'main.js', globals: { mEditLoadError: reason } });
      }
    };
    await tab.askWhichRecord(read);
  }

  // A file that holds no record opens as any JSON file does (editor.md, Opening, story 11).
  private async reopenAsText(tab: RecordTab): Promise<void> {
    const { document } = tab;
    const shownIn = vsCodeTabOf(tab);
    if (!shownIn) {
      this.deps.channel.warn(`${document.fsPath} holds no record, but VS Code shows its tab in no group to reopen in the text editor.`);
      return;
    }
    await inTabsStead(shownIn, async (options) => { await vscode.commands.executeCommand('vscode.openWith', document, 'default', options); });
  }

  readAgain(): void {
    for (const tab of this.deps.tabs) tab.askWhichRecordAgain();
  }

  // Saved, the read model wins (commands.md, Principles), but mEdit compares no inactive plugin's
  // copy, nor a record an edit moved before mEdit reports it, so the file's column reads the document then.
  private showFile(
    panel: vscode.WebviewPanel, tab: RecordTab, document: vscode.TextDocument, copy: RecordCopy, page: GridPage,
    titleFromRead: TabDocument['titleFromRead'],
  ): void {
    const documentText = async (pluginActive: boolean) => {
      if (document.isDirty || tab.waitingFor()) return document.getText();
      return pluginActive ? undefined : savedText(document.uri);
    };
    this.show(panel, tab, copy, page, { titleFromRead, plugin: copy.plugin, documentText });
    tab.own(vscode.workspace.onDidChangeTextDocument((change) => {
      if (change.document === document && change.contentChanges.length > 0) tab.refresh();
    }));
  }

  private show(panel: vscode.WebviewPanel, tab: RecordTab, { formKey, plugin }: RecordCopy, { columns, place }: GridPage, document: TabDocument): void {
    const { tabs, routerDeps, context } = this.deps;
    tab.show({ formKey, plugin });
    // A reply and a follow reach the one tab that asked, never a broadcast.
    const tabRouterDeps = routerDepsForTab(routerDeps, tab, tabs, document);
    tab.own(panel.webview.onDidReceiveMessage((message: unknown) => {
      if (isRecordLoadRequest(message)) tab.listens();
      void routeRecordPanelMessage(message, tabRouterDeps);
    }));
    // The FormKey is shown before the tab takes the focus, so a new tab retargets Referenced By once.
    // A tab's view state announces only its gaining the focus: losing it is another tab's event.
    tabs.focus(tab);
    tab.own(panel.onDidChangeViewState(() => { if (panel.active) tabs.focus(tab); }));
    showWebviewPage(panel.webview, context.extensionUri, {
      script: 'main.js', globals: { mEditFormKey: formKey, mEditColumns: columns, ...(place && { mEditViewState: place }) },
    });
  }
}

function isRecordLoadRequest(message: unknown): boolean {
  try {
    return parseWebviewToExtension(message).type === WEBVIEW_TO_EXTENSION.REQUEST_RECORD_LOAD;
  } catch {
    return false;
  }
}

// The file on disk, as VS Code misses a write to a file outside the workspace while its tab is
// hidden. A document's text has no byte order mark. A file gone is mEdit's to answer.
async function savedText(uri: vscode.Uri): Promise<string | undefined> {
  try {
    return (await fileText(uri)).replace(/^\uFEFF/, '');
  } catch (err) {
    if (err instanceof vscode.FileSystemError && err.code === 'FileNotFound') return undefined;
    throw err;
  }
}

const vsCodeTabOf = ({ document, panel: { viewColumn } }: RecordTab): vscode.Tab | undefined =>
  vscode.window.tabGroups.all.find((group) => group.viewColumn === viewColumn)?.tabs.find(({ input }) =>
    input instanceof vscode.TabInputCustom && input.viewType === RECORD_VIEW_TYPE && input.uri.toString() === document.toString());
