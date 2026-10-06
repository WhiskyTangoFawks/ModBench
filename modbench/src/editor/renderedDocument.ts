import * as vscode from 'vscode';
import type { MEditClient } from '../client';
import { samePluginAddress } from '../wire/pluginAddress';
import { copyOf, copyQuery, holdsNoCopy, type RecordCopy } from './recordCopy';

export const RENDERED_DOCUMENT_SCHEME = 'modbench-rendered';

// The path is what VS Code shows: its last segment titles the tab, and the plugin's segments
// before it tell apart two copies of one name.
export function renderedDocumentUri(copy: RecordCopy, fileName: string): vscode.Uri {
  return vscode.Uri.from({
    scheme: RENDERED_DOCUMENT_SCHEME, path: `/${copy.plugin.origin}/${copy.plugin.name}/${fileName}`, query: copyQuery(copy),
  });
}

/** The read-only documents an untracked plugin's copies open as: mEdit's rendering, read again
 *  when mEdit reports the copy changed, and when its reports resume, since one may have been missed. */
export class RenderedDocuments implements vscode.TextDocumentContentProvider, vscode.Disposable {
  private readonly changes = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.changes.event;
  private readonly registrations: vscode.Disposable[];

  constructor(private readonly client: Pick<MEditClient, 'getRenderedDocument' | 'onNotification' | 'onReconnected'>) {
    const unsubscribes = [
      client.onNotification('rows-changed', ({ plugin, keys }) => {
        this.changedWhere((copy) => samePluginAddress(copy.plugin, plugin) && keys.includes(copy.formKey));
      }),
      client.onNotification('plugin-changed', ({ plugin }) => {
        this.changedWhere((copy) => samePluginAddress(copy.plugin, plugin));
      }),
      client.onReconnected(() => { this.changedWhere(() => true); }),
    ];
    this.registrations = [
      vscode.workspace.registerTextDocumentContentProvider(RENDERED_DOCUMENT_SCHEME, this),
      new vscode.Disposable(() => { for (const unsubscribe of unsubscribes) unsubscribe(); }),
      this.changes,
    ];
  }

  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const copy = copyOf(uri);
    const document = await this.client.getRenderedDocument(copy.plugin, copy.formKey);
    if (document === null) throw holdsNoCopy(copy);
    return document.text;
  }

  dispose(): void {
    for (const registration of this.registrations) registration.dispose();
  }

  private changedWhere(affects: (copy: RecordCopy) => boolean): void {
    for (const { uri } of vscode.workspace.textDocuments) {
      if (uri.scheme === RENDERED_DOCUMENT_SCHEME && affects(copyOf(uri))) this.changes.fire(uri);
    }
  }
}
