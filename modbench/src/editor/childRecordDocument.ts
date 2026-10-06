import * as vscode from 'vscode';
import type { MEditClient } from '../client';
import { samePluginAddress } from '../wire/pluginAddress';
import { copyOf, copyQuery, type RecordCopy } from './recordCopy';

export const CHILD_RECORD_SCHEME = 'modbench-child-record';

// The path is the container's file, so VS Code shows where the child lives; the query tells two
// children of one file apart.
export const childRecordUri = (copy: RecordCopy, containerFile: string): vscode.Uri =>
  vscode.Uri.file(containerFile).with({ scheme: CHILD_RECORD_SCHEME, query: copyQuery(copy) });

const containerFileOf = (uri: vscode.Uri): vscode.Uri => uri.with({ scheme: 'file', query: '' });

/** A child record's documents: each is its container's file, read and saved through to it, so a
 *  child opens in a tab of its own on the file it shares. */
export class ChildRecordDocuments implements vscode.FileSystemProvider, vscode.Disposable {
  private readonly changes = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  readonly onDidChangeFile = this.changes.event;
  private readonly registrations: vscode.Disposable[];

  constructor(client: Pick<MEditClient, 'onNotification' | 'onReconnected'>) {
    // mEdit's report names the records that changed, and a change to any of them can be in the file.
    const ofItsPlugin = ({ plugin }: { plugin: RecordCopy['plugin'] }) => {
      this.changedWhere((copy) => samePluginAddress(copy.plugin, plugin));
    };
    const unsubscribes = [
      client.onNotification('rows-changed', ofItsPlugin),
      client.onNotification('plugin-changed', ofItsPlugin),
      client.onReconnected(() => { this.changedWhere(() => true); }),
    ];
    this.registrations = [
      vscode.workspace.registerFileSystemProvider(CHILD_RECORD_SCHEME, this),
      new vscode.Disposable(() => { for (const unsubscribe of unsubscribes) unsubscribe(); }),
      this.changes,
    ];
  }

  watch(): vscode.Disposable { return new vscode.Disposable(() => undefined); }
  stat(uri: vscode.Uri): Thenable<vscode.FileStat> { return vscode.workspace.fs.stat(containerFileOf(uri)); }
  readFile(uri: vscode.Uri): Thenable<Uint8Array> { return vscode.workspace.fs.readFile(containerFileOf(uri)); }
  writeFile(uri: vscode.Uri, content: Uint8Array): Thenable<void> { return vscode.workspace.fs.writeFile(containerFileOf(uri), content); }
  readDirectory(): [string, vscode.FileType][] { return []; }
  createDirectory(uri: vscode.Uri): void { throw vscode.FileSystemError.NoPermissions(uri); }
  delete(uri: vscode.Uri): void { throw vscode.FileSystemError.NoPermissions(uri); }
  rename(oldUri: vscode.Uri): void { throw vscode.FileSystemError.NoPermissions(oldUri); }

  dispose(): void {
    for (const registration of this.registrations) registration.dispose();
  }

  private changedWhere(affects: (copy: RecordCopy) => boolean): void {
    const changed = vscode.workspace.textDocuments
      .filter(({ uri }) => uri.scheme === CHILD_RECORD_SCHEME && affects(copyOf(uri)))
      .map(({ uri }) => ({ type: vscode.FileChangeType.Changed, uri }));
    if (changed.length > 0) this.changes.fire(changed);
  }
}
