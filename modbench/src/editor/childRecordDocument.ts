import * as vscode from 'vscode';
import type { MEditClient } from '../client';
import { samePluginAddress } from '../wire/pluginAddress';
import { followReportedCopies, type CopyChanged } from './recordCopy';
import { CHILD_RECORD_SCHEME, copyOf } from '../drivingLib/recordDocument';
import { fileText } from './fileText';

const containerFileOf = (uri: vscode.Uri): vscode.Uri => uri.with({ scheme: 'file', query: '' });

/** A child record's documents: each is its container's file, read and saved through to it, so a
 *  child opens in a tab of its own on the file it shares. */
export class ChildRecordDocuments implements vscode.FileSystemProvider, vscode.Disposable {
  private readonly changes = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  readonly onDidChangeFile = this.changes.event;
  private readonly registrations: vscode.Disposable[];

  constructor(client: Pick<MEditClient, 'onNotification' | 'onReconnected'>) {
    this.registrations = [
      vscode.workspace.registerFileSystemProvider(CHILD_RECORD_SCHEME, this),
      // A report names the records that changed, and a change to any of them can be in the file.
      followReportedCopies(client, (affects) => { this.changedWhere(affects); },
        ({ plugin }) => (copy) => samePluginAddress(copy.plugin, plugin)),
      this.changes,
    ];
  }

  watch(): vscode.Disposable { return new vscode.Disposable(() => undefined); }
  stat(uri: vscode.Uri): Thenable<vscode.FileStat> { return vscode.workspace.fs.stat(containerFileOf(uri)); }
  // A save writes back what it read.
  async readFile(uri: vscode.Uri): Promise<Uint8Array> {
    return new TextEncoder().encode(await fileText(containerFileOf(uri)));
  }
  writeFile(uri: vscode.Uri, content: Uint8Array): Thenable<void> { return vscode.workspace.fs.writeFile(containerFileOf(uri), content); }
  readDirectory(): [string, vscode.FileType][] { return []; }
  createDirectory(uri: vscode.Uri): void { throw vscode.FileSystemError.NoPermissions(uri); }
  delete(uri: vscode.Uri): void { throw vscode.FileSystemError.NoPermissions(uri); }
  rename(oldUri: vscode.Uri): void { throw vscode.FileSystemError.NoPermissions(oldUri); }

  dispose(): void {
    for (const registration of this.registrations) registration.dispose();
  }

  private changedWhere(affects: CopyChanged): void {
    const changed = vscode.workspace.textDocuments
      .filter(({ uri }) => uri.scheme === CHILD_RECORD_SCHEME && affects(copyOf(uri)))
      .map(({ uri }) => ({ type: vscode.FileChangeType.Changed, uri }));
    if (changed.length > 0) this.changes.fire(changed);
  }
}
