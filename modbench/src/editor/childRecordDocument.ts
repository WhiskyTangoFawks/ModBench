import * as vscode from 'vscode';
import type { MEditClient } from '../client';
import { samePluginAddress } from '../wire/pluginAddress';
import { followReportedCopies, type CopyChanged } from './recordCopy';
import { CHILD_RECORD_SCHEME, copyOf } from '../drivingLib/recordDocument';
import { fileText } from './fileText';
import { takeText } from './oneTextPerFile';

const containerFileOf = (uri: vscode.Uri): vscode.Uri => uri.with({ scheme: 'file', query: '' });

// The container's document, while open, writes each save and checks it against the file.
const openContainer = (uri: vscode.Uri): vscode.TextDocument | undefined =>
  vscode.workspace.textDocuments.find((document) => document.uri.toString() === containerFileOf(uri).toString());

/** A child record's documents: each is its container's file, read and saved through to it, so a
 *  child opens in a tab of its own on the file it shares. */
export class ChildRecordDocuments implements vscode.FileSystemProvider, vscode.Disposable {
  private readonly changes = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  readonly onDidChangeFile = this.changes.event;
  private readonly registrations: vscode.Disposable[];
  // The file's size as each child's document last read it.
  private readonly sizesRead = new Map<string, number>();

  constructor(client: Pick<MEditClient, 'onNotification' | 'onReconnected'>) {
    this.registrations = [
      vscode.workspace.registerFileSystemProvider(CHILD_RECORD_SCHEME, this),
      // A report names the records that changed, and a change to any of them can be in the file.
      followReportedCopies(client, (affects) => { this.changedWhere(affects); },
        ({ plugin }) => (copy) => samePluginAddress(copy.plugin, plugin)),
      vscode.workspace.onDidCloseTextDocument(({ uri }) => { this.sizesRead.delete(uri.toString()); }),
      this.changes,
    ];
  }

  watch(): vscode.Disposable { return new vscode.Disposable(() => undefined); }
  // VS Code refuses a document's save once the file's mtime and size both moved past those it read.
  // The container's document checks the saves it writes, so while it is open the size read stands.
  async stat(uri: vscode.Uri): Promise<vscode.FileStat> {
    const stat = await vscode.workspace.fs.stat(containerFileOf(uri));
    const key = uri.toString();
    const size = openContainer(uri) ? this.sizesRead.get(key) ?? stat.size : stat.size;
    this.sizesRead.set(key, size);
    return { ...stat, size };
  }
  // A save writes back what it read.
  async readFile(uri: vscode.Uri): Promise<Uint8Array> {
    return new TextEncoder().encode(await fileText(containerFileOf(uri)));
  }
  async writeFile(uri: vscode.Uri, content: Uint8Array): Promise<void> {
    const container = openContainer(uri);
    if (!container) return vscode.workspace.fs.writeFile(containerFileOf(uri), content);
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
