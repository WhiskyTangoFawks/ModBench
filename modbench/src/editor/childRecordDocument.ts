import * as vscode from 'vscode';
import type { MEditClient } from '../client';
import { samePluginAddress } from '../wire/pluginAddress';
import { followReportedCopies, type CopyChanged } from './recordCopy';
import { CHILD_RECORD_SCHEME, CONTAINER_SCHEMES, copyOf } from '../drivingLib/recordDocument';
import { fileText } from './fileText';
import { takeText } from './oneTextPerFile';

const containerFileOf = (uri: vscode.Uri): vscode.Uri => uri.with({ scheme: 'file', query: '' });

/** A child record's documents: each is its container's file, read and saved through to it, so a
 *  child opens in a tab of its own on the file it shares. */
export class ChildRecordDocuments implements vscode.FileSystemProvider, vscode.Disposable {
  private readonly changes = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  readonly onDidChangeFile = this.changes.event;
  private readonly registrations: vscode.Disposable[];
  // What each child's document last read of the file: its size, and the mtime Modbench's last write gave it.
  private readonly reads = new Map<string, { size: number; ownWrite?: Promise<number | undefined> }>();

  constructor(client: Pick<MEditClient, 'onNotification' | 'onReconnected'>) {
    this.registrations = [
      vscode.workspace.registerFileSystemProvider(CHILD_RECORD_SCHEME, this),
      // A report names the records that changed, and a change to any of them can be in the file.
      followReportedCopies(client, (affects) => { this.changedWhere(affects); },
        ({ plugin }) => (copy) => samePluginAddress(copy.plugin, plugin)),
      vscode.workspace.onDidSaveTextDocument((document) => {
        if (CONTAINER_SCHEMES.has(document.uri.scheme)) this.wrote(vscode.Uri.file(document.uri.fsPath), () => new TextEncoder().encode(document.getText()).byteLength);
      }),
      vscode.workspace.onDidCloseTextDocument(({ uri }) => { this.reads.delete(uri.toString()); }),
      this.changes,
    ];
  }

  watch(): vscode.Disposable { return new vscode.Disposable(() => undefined); }
  // VS Code refuses a document's save when the file's mtime is newer than it read and its size differs.
  // After Modbench's own write a child states the size it read, so only another program's write refuses.
  async stat(uri: vscode.Uri): Promise<vscode.FileStat> {
    const key = uri.toString();
    const read = this.reads.get(key);
    const own = await read?.ownWrite;
    const stat = await vscode.workspace.fs.stat(containerFileOf(uri));
    const size = read && stat.mtime === own ? read.size : stat.size;
    // VS Code reads a document again only while it is saved. An unsaved one's stat checks its save, and can land mid-write.
    if (!vscode.workspace.textDocuments.some((document) => document.uri.toString() === key && document.isDirty)) this.reads.set(key, { ...read, size });
    return { ...stat, size };
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
    if (!container) {
      await vscode.workspace.fs.writeFile(file, content);
      this.wrote(file, () => content.byteLength);
      return;
    }
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

  // A file whose size is not what Modbench wrote took another program's write after it.
  private wrote(file: vscode.Uri, byteLength: () => number): void {
    const reads = vscode.workspace.textDocuments.flatMap(({ uri }) =>
      uri.scheme === CHILD_RECORD_SCHEME && uri.fsPath === file.fsPath ? this.reads.get(uri.toString()) ?? [] : []);
    if (reads.length === 0) return;
    const written = byteLength();
    const ownWrite = Promise.resolve(vscode.workspace.fs.stat(file)).then(({ mtime, size }) => size === written ? mtime : undefined, () => undefined);
    for (const read of reads) read.ownWrite = ownWrite;
  }

  private changedWhere(affects: CopyChanged): void {
    const changed = vscode.workspace.textDocuments
      .filter(({ uri }) => uri.scheme === CHILD_RECORD_SCHEME && affects(copyOf(uri)))
      .map(({ uri }) => ({ type: vscode.FileChangeType.Changed, uri }));
    if (changed.length > 0) this.changes.fire(changed);
  }
}
