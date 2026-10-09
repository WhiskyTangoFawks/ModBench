import * as vscode from 'vscode';
import type { MEditClient } from '../client';
import { samePluginAddress } from '../wire/pluginAddress';
import { followReportedCopies, type CopyChanged } from './recordCopy';
import { CHILD_RECORD_SCHEME, copyOf } from '../drivingLib/recordDocument';
import { fileText } from './fileText';
import { takeText } from './oneTextPerFile';

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
  // VS Code refuses a document's save once the file's mtime and size both moved past those it read.
  // A child's save follows a sibling's or the container's, which moved both, so it states no size.
  async stat(uri: vscode.Uri): Promise<vscode.FileStat> {
    return { ...await vscode.workspace.fs.stat(containerFileOf(uri)), size: 0 };
  }
  // A save writes back what it read.
  async readFile(uri: vscode.Uri): Promise<Uint8Array> {
    return new TextEncoder().encode(await fileText(containerFileOf(uri)));
  }
  // The container's open document writes the save, so it never goes on with the file as it read it.
  // One opened for the save would be no tab's, which VS Code stops watching outside the workspace.
  async writeFile(uri: vscode.Uri, content: Uint8Array): Promise<void> {
    const file = containerFileOf(uri);
    const container = vscode.workspace.textDocuments.find((document) => document.uri.toString() === file.toString());
    if (!container) return vscode.workspace.fs.writeFile(file, content);
    await takeText(container, new TextDecoder().decode(content));
    if (container.isDirty && !await container.save()) throw vscode.FileSystemError.Unavailable(uri);
  }
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
