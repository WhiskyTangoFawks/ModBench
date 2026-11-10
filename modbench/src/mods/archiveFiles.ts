import * as vscode from 'vscode';
import type { MEditClient } from '../client';
import { failureReason, isReadFailed } from '../wire/readFailed';
import type { ArchivedFileAddress } from '../instanceLoader/fileConflictIndex';
import type { Reporter } from '../ports/reporter';
import { reportFailure } from '../drivingLib/reportFailure';

const ARCHIVE_SCHEME = 'modbench-archive';

type ArchiveAddress = Omit<ArchivedFileAddress, 'file'>;

function isAddress(value: unknown): value is ArchiveAddress {
  if (typeof value !== 'object' || value === null) return false;
  return ['gameRelease', 'archive'].every((key) => typeof Reflect.get(value, key) === 'string');
}

const nameOf = (archive: string): string | undefined => archive.split(/[\\/]/).at(-1);

/** An archive as a folder. Every path below it is a file's path in the archive, so its address says only which archive. */
export function archiveUri({ gameRelease, archive }: ArchiveAddress): vscode.Uri {
  return vscode.Uri.from({ scheme: ARCHIVE_SCHEME, path: `/${nameOf(archive)}`, query: JSON.stringify({ gameRelease, archive }) });
}

/** A file in an archive. The address rides in the query, so a restored tab can read its file again; the path ends in the file's name. */
export function archivedFileUri({ gameRelease, archive, file }: ArchivedFileAddress): vscode.Uri {
  return vscode.Uri.from({ scheme: ARCHIVE_SCHEME, path: `/${nameOf(archive)}/${file}`, query: JSON.stringify({ gameRelease, archive, file }) });
}

// mods.md, The tree, story 13: Modbench never writes inside an archive.
class ArchiveFileSystem implements vscode.FileSystemProvider {
  readonly onDidChangeFile = new vscode.EventEmitter<vscode.FileChangeEvent[]>().event;

  constructor(private readonly client: Pick<MEditClient, 'getArchiveFile' | 'getArchiveContents'>) {}

  watch(): vscode.Disposable { return new vscode.Disposable(() => undefined); }

  // VS Code states a file and then reads it: the bytes the stat fetched serve that one read.
  private stated: { readonly key: string; readonly bytes: Uint8Array } | undefined;

  async stat(uri: vscode.Uri): Promise<vscode.FileStat> {
    const { address, path } = this.addressed(uri);
    const files = await this.contents(address, uri);
    if (path === '') return directoryStat();
    if (!files.includes(path)) {
      if (files.some((file) => file.startsWith(`${path}/`))) return directoryStat();
      throw vscode.FileSystemError.FileNotFound(uri);
    }
    const bytes = await this.fetch(address, path);
    this.stated = { key: uri.toString(), bytes };
    return { type: vscode.FileType.File, ctime: 0, mtime: 0, size: bytes.byteLength };
  }

  async readFile(uri: vscode.Uri): Promise<Uint8Array> {
    const { stated } = this;
    this.stated = undefined;
    if (stated?.key === uri.toString()) return stated.bytes;
    const { address, path } = this.addressed(uri);
    return this.fetch(address, path);
  }

  async readDirectory(uri: vscode.Uri): Promise<[string, vscode.FileType][]> {
    const { address, path } = this.addressed(uri);
    const prefix = path === '' ? '' : `${path}/`;
    const below = (await this.contents(address, uri)).filter((file) => file.startsWith(prefix)).map((file) => file.slice(prefix.length).split('/'));
    const folders = new Set(below.filter((names) => names.length > 1).map(([name]) => name));
    return [
      ...[...folders].map((name): [string, vscode.FileType] => [name ?? '', vscode.FileType.Directory]),
      ...below.filter((names) => names.length === 1).map(([name]): [string, vscode.FileType] => [name ?? '', vscode.FileType.File]),
    ];
  }

  private addressed(uri: vscode.Uri): { address: ArchiveAddress; path: string } {
    const address: unknown = JSON.parse(uri.query);
    if (!isAddress(address)) throw vscode.FileSystemError.FileNotFound(uri);
    return { address, path: uri.path.split('/').slice(2).join('/') };
  }

  private async contents({ gameRelease, archive }: ArchiveAddress, uri: vscode.Uri): Promise<readonly string[]> {
    const answered = await this.client.getArchiveContents(gameRelease, [archive]);
    if (isReadFailed(answered)) throw vscode.FileSystemError.Unavailable(failureReason(answered));
    const held = answered.find((contents) => contents.archive === archive);
    if (held === undefined) throw vscode.FileSystemError.FileNotFound(uri);
    if (typeof held.unreadable === 'string') throw vscode.FileSystemError.Unavailable(held.unreadable);
    return held.files;
  }

  private async fetch({ gameRelease, archive }: ArchiveAddress, file: string): Promise<Uint8Array> {
    const bytes = await this.client.getArchiveFile(gameRelease, archive, file);
    if (isReadFailed(bytes)) throw vscode.FileSystemError.Unavailable(failureReason(bytes));
    return bytes;
  }

  writeFile(uri: vscode.Uri): void { throw vscode.FileSystemError.NoPermissions(uri); }
  createDirectory(uri: vscode.Uri): void { throw vscode.FileSystemError.NoPermissions(uri); }
  delete(uri: vscode.Uri): void { throw vscode.FileSystemError.NoPermissions(uri); }
  rename(oldUri: vscode.Uri): void { throw vscode.FileSystemError.NoPermissions(oldUri); }
}

const directoryStat = (): vscode.FileStat => ({ type: vscode.FileType.Directory, ctime: 0, mtime: 0, size: 0 });

export function registerArchiveFiles(client: Pick<MEditClient, 'getArchiveFile' | 'getArchiveContents'>): vscode.Disposable {
  return vscode.workspace.registerFileSystemProvider(ARCHIVE_SCHEME, new ArchiveFileSystem(client), { isReadonly: true });
}

const hasFsPath = (value: unknown): value is { fsPath: string } =>
  typeof value === 'object' && value !== null && 'fsPath' in value && typeof value.fsPath === 'string';

interface ArchiveOpenDeps {
  gameRelease: () => Promise<string>;
  reporter: Reporter;
}

/** commands.md, Archive, open: the archive joins the workspace as a read-only folder, and the Explorer lists what mEdit reads in it. */
export function registerArchiveOpen({ gameRelease, reporter }: ArchiveOpenDeps): vscode.Disposable {
  return vscode.commands.registerCommand('modbench.archive.open', async (clicked?: unknown) => {
    const fsPath = hasFsPath(clicked) ? clicked.fsPath : (await vscode.window.showOpenDialog({ filters: { Archives: ['ba2', 'bsa'] } }))?.[0]?.fsPath;
    if (fsPath === undefined) return;
    await reportFailure(reporter, `Failed to open the archive "${fsPath}".`, async () => {
      const uri = archiveUri({ gameRelease: await gameRelease(), archive: fsPath });
      const added = vscode.workspace.updateWorkspaceFolders(vscode.workspace.workspaceFolders?.length ?? 0, 0, { uri, name: nameOf(fsPath) });
      if (!added) await vscode.commands.executeCommand('revealInExplorer', uri);
    });
  });
}
