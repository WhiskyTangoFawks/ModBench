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
  // The mtime each file took from Modbench's last write to it.
  private readonly ownWrites = new Map<string, Promise<number | undefined>>();
  // The size each child's document last read.
  private readonly sizesRead = new Map<string, number>();

  constructor(client: Pick<MEditClient, 'onNotification' | 'onReconnected'>) {
    this.registrations = [
      vscode.workspace.registerFileSystemProvider(CHILD_RECORD_SCHEME, this),
      // A report names the records that changed, and a change to any of them can be in the file.
      followReportedCopies(client, (affects) => { this.changedWhere(affects); },
        ({ plugin }) => (copy) => samePluginAddress(copy.plugin, plugin)),
      vscode.workspace.onDidSaveTextDocument(({ uri }) => {
        const file = vscode.Uri.file(uri.fsPath);
        if (CONTAINER_SCHEMES.has(uri.scheme) && this.childrenOver(file)) this.wrote(file);
      }),
      vscode.workspace.onDidCloseTextDocument(({ uri }) => { this.sizesRead.delete(uri.toString()); }),
      this.changes,
    ];
  }

  watch(): vscode.Disposable { return new vscode.Disposable(() => undefined); }
  // VS Code refuses a document's save when the file's mtime is newer than the one it read and its size
  // differs. Once Modbench wrote the file, a child states the size it read, so only another program's
  // write refuses its save.
  async stat(uri: vscode.Uri): Promise<vscode.FileStat> {
    const file = containerFileOf(uri);
    const own = await this.ownWrites.get(file.fsPath);
    const stat = await vscode.workspace.fs.stat(file);
    const key = uri.toString();
    const size = stat.mtime === own ? this.sizesRead.get(key) ?? stat.size : stat.size;
    this.sizesRead.set(key, size);
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
      this.wrote(file);
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

  private wrote(file: vscode.Uri): void {
    this.ownWrites.set(file.fsPath, Promise.resolve(vscode.workspace.fs.stat(file)).then(({ mtime }) => mtime, () => undefined));
  }

  private childrenOver({ fsPath }: vscode.Uri): boolean {
    return vscode.workspace.textDocuments.some(({ uri }) => uri.scheme === CHILD_RECORD_SCHEME && uri.fsPath === fsPath);
  }

  private changedWhere(affects: CopyChanged): void {
    const changed = vscode.workspace.textDocuments
      .filter(({ uri }) => uri.scheme === CHILD_RECORD_SCHEME && affects(copyOf(uri)))
      .map(({ uri }) => ({ type: vscode.FileChangeType.Changed, uri }));
    if (changed.length > 0) this.changes.fire(changed);
  }
}
