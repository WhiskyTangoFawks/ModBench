import * as vscode from 'vscode';
import type { MEditClient } from '../client';
import { samePluginAddress } from '../wire/pluginAddress';
import type { RecordToOpen } from './recordOpenPlan';

export const RENDERED_DOCUMENT_SCHEME = 'modbench-rendered';

export type RenderedCopy = Required<RecordToOpen>;

// The copy rides in the query. The path is what VS Code shows: its last segment titles the tab,
// and the plugin's segments before it tell apart two copies of one name.
export function renderedDocumentUri({ formKey, plugin }: RenderedCopy, fileName: string): vscode.Uri {
  return vscode.Uri.from({
    scheme: RENDERED_DOCUMENT_SCHEME,
    path: `/${plugin.origin}/${plugin.name}/${fileName}`,
    query: new URLSearchParams({ formKey, name: plugin.name, origin: plugin.origin }).toString(),
  });
}

export function renderedCopyOf(uri: vscode.Uri): RenderedCopy {
  const query = new URLSearchParams(uri.query);
  const stated = (key: string): string => {
    const value = query.get(key);
    if (!value) throw new Error(`The rendered document ${uri.path} states no ${key}.`);
    return value;
  };
  return { formKey: stated('formKey'), plugin: { name: stated('name'), origin: stated('origin') } };
}

export const holdsNoCopy = ({ formKey, plugin }: RenderedCopy): Error =>
  new Error(`${plugin.name} (${plugin.origin}) holds no ${formKey}.`);

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
    const copy = renderedCopyOf(uri);
    const document = await this.client.getRenderedDocument(copy.plugin, copy.formKey);
    if (document === null) throw holdsNoCopy(copy);
    return document.text;
  }

  dispose(): void {
    for (const registration of this.registrations) registration.dispose();
  }

  private changedWhere(affects: (copy: RenderedCopy) => boolean): void {
    for (const { uri } of vscode.workspace.textDocuments) {
      if (uri.scheme === RENDERED_DOCUMENT_SCHEME && affects(renderedCopyOf(uri))) this.changes.fire(uri);
    }
  }
}
