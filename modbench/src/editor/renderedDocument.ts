import * as vscode from 'vscode';
import type { MEditClient } from '../client';
import { samePluginAddress } from '../wire/pluginAddress';
import { followReportedCopies, type CopyChanged } from './recordCopy';
import { RENDERED_DOCUMENT_SCHEME, copyOf, holdsNoCopy } from '../drivingLib/recordDocument';

/** The read-only documents an untracked plugin's copies open as: mEdit's rendering, read again
 *  when mEdit reports the copy changed, and when its reports resume, since one may have been missed. */
export class RenderedDocuments implements vscode.TextDocumentContentProvider, vscode.Disposable {
  private readonly changes = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.changes.event;
  private readonly registrations: vscode.Disposable[];

  constructor(private readonly client: Pick<MEditClient, 'getRenderedDocument' | 'onNotification' | 'onReconnected'>) {
    this.registrations = [
      vscode.workspace.registerTextDocumentContentProvider(RENDERED_DOCUMENT_SCHEME, this),
      followReportedCopies(client, (affects) => { this.changedWhere(affects); },
        ({ plugin, keys }) => (copy) => samePluginAddress(copy.plugin, plugin) && keys.includes(copy.formKey)),
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

  private changedWhere(affects: CopyChanged): void {
    for (const { uri } of vscode.workspace.textDocuments) {
      if (uri.scheme === RENDERED_DOCUMENT_SCHEME && affects(copyOf(uri))) this.changes.fire(uri);
    }
  }
}
