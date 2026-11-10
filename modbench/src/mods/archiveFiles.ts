import * as vscode from 'vscode';
import type { MEditClient } from '../client';
import { failureReason, isReadFailed } from '../wire/readFailed';

const ARCHIVE_SCHEME = 'modbench-archive';

interface ArchivedFileAddress { gameRelease: string; archive: string; file: string }

function isAddress(value: unknown): value is ArchivedFileAddress {
  if (typeof value !== 'object' || value === null) return false;
  return ['gameRelease', 'archive', 'file'].every((key) => typeof Reflect.get(value, key) === 'string');
}

/** A file in an archive. The address rides in the query, so a restored tab can read its file again; the path ends in the file's name. */
export function archivedFileUri(address: ArchivedFileAddress): vscode.Uri {
  const archiveName = address.archive.split(/[\\/]/).at(-1);
  return vscode.Uri.from({ scheme: ARCHIVE_SCHEME, path: `/${archiveName}/${address.file}`, query: JSON.stringify(address) });
}

// mods.md, The tree, story 13: Modbench never writes inside an archive.
class ArchiveFileSystem implements vscode.FileSystemProvider {
  readonly onDidChangeFile = new vscode.EventEmitter<vscode.FileChangeEvent[]>().event;

  constructor(private readonly client: Pick<MEditClient, 'getArchiveFile'>) {}

  watch(): vscode.Disposable { return new vscode.Disposable(() => undefined); }

  async stat(uri: vscode.Uri): Promise<vscode.FileStat> {
    const bytes = await this.bytesOf(uri);
    return { type: vscode.FileType.File, ctime: 0, mtime: 0, size: bytes.byteLength };
  }

  readFile(uri: vscode.Uri): Promise<Uint8Array> { return this.bytesOf(uri); }

  private async bytesOf(uri: vscode.Uri): Promise<Uint8Array> {
    const address: unknown = JSON.parse(uri.query);
    if (!isAddress(address)) throw vscode.FileSystemError.FileNotFound(uri);
    const bytes = await this.client.getArchiveFile(address.gameRelease, address.archive, address.file);
    if (isReadFailed(bytes)) throw vscode.FileSystemError.Unavailable(failureReason(bytes));
    return bytes;
  }

  readDirectory(): [string, vscode.FileType][] { return []; }
  writeFile(uri: vscode.Uri): void { throw vscode.FileSystemError.NoPermissions(uri); }
  createDirectory(uri: vscode.Uri): void { throw vscode.FileSystemError.NoPermissions(uri); }
  delete(uri: vscode.Uri): void { throw vscode.FileSystemError.NoPermissions(uri); }
  rename(oldUri: vscode.Uri): void { throw vscode.FileSystemError.NoPermissions(oldUri); }
}

export function registerArchiveFiles(client: Pick<MEditClient, 'getArchiveFile'>): vscode.Disposable {
  return vscode.workspace.registerFileSystemProvider(ARCHIVE_SCHEME, new ArchiveFileSystem(client), { isReadonly: true });
}
