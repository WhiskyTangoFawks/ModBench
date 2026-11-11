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

function archiveUri({ gameRelease, archive }: ArchiveAddress): vscode.Uri {
  return vscode.Uri.from({ scheme: ARCHIVE_SCHEME, path: `/${nameOf(archive)}`, query: JSON.stringify({ gameRelease, archive }) });
}

/** A file in an archive. The address rides in the query, so a restored tab can read its file again; the path ends in the file's name. */
export function archivedFileUri({ gameRelease, archive, file }: ArchivedFileAddress): vscode.Uri {
  return vscode.Uri.from({ scheme: ARCHIVE_SCHEME, path: `/${nameOf(archive)}/${file}`, query: JSON.stringify({ gameRelease, archive, file }) });
}

interface Listing {
  readonly stamp: string;
  readonly files: readonly string[];
  readonly fileSet: ReadonlySet<string>;
  readonly folders: ReadonlySet<string>;
}

const foldersOf = (files: readonly string[]): Set<string> =>
  new Set(files.flatMap((file) => file.split('/').slice(0, -1).map((_, depth, names) => names.slice(0, depth + 1).join('/'))));

// mods.md, The tree, story 13: Modbench never writes inside an archive.
class ArchiveFileSystem implements vscode.FileSystemProvider {
  readonly onDidChangeFile = new vscode.EventEmitter<vscode.FileChangeEvent[]>().event;

  private readonly listings = new Map<string, Listing>();

  constructor(private readonly client: Pick<MEditClient, 'getArchiveFile' | 'getArchiveContents' | 'getArchiveCopies'>) {}

  watch(): vscode.Disposable { return new vscode.Disposable(() => undefined); }

  async stat(uri: vscode.Uri): Promise<vscode.FileStat> {
    const { address, path } = this.addressed(uri);
    const { fileSet, folders } = await this.listing(address);
    if (path === '' || folders.has(path)) return directoryStat();
    if (!fileSet.has(path)) throw vscode.FileSystemError.FileNotFound(uri);
    const copies = await this.client.getArchiveCopies(address.gameRelease, address.archive, [path], false);
    if (isReadFailed(copies)) throw vscode.FileSystemError.Unavailable(failureReason(copies));
    const copy = copies.find((held) => held.file === path);
    if (copy === undefined) throw vscode.FileSystemError.FileNotFound(uri);
    return { type: vscode.FileType.File, ctime: 0, mtime: 0, size: copy.size };
  }

  readFile(uri: vscode.Uri): Promise<Uint8Array> {
    const { address, path } = this.addressed(uri);
    return this.fetch(address, path);
  }

  async readDirectory(uri: vscode.Uri): Promise<[string, vscode.FileType][]> {
    const { address, path } = this.addressed(uri);
    const prefix = path === '' ? '' : `${path}/`;
    const { files, folders } = await this.listing(address);
    const inside = (entry: string): boolean => entry.startsWith(prefix) && !entry.slice(prefix.length).includes('/');
    return [
      ...[...folders].filter(inside).map((folder): [string, vscode.FileType] => [folder.slice(prefix.length), vscode.FileType.Directory]),
      ...files.filter(inside).map((file): [string, vscode.FileType] => [file.slice(prefix.length), vscode.FileType.File]),
    ];
  }

  private addressed(uri: vscode.Uri): { address: ArchiveAddress; path: string } {
    const address: unknown = JSON.parse(uri.query);
    if (!isAddress(address)) throw vscode.FileSystemError.FileNotFound(uri);
    return { address, path: uri.path.split('/').slice(2).join('/') };
  }

  // The listing is held while the archive keeps its size and modified time; a changed archive is read again (ADR-0003).
  private async listing({ gameRelease, archive }: ArchiveAddress): Promise<Listing> {
    const { size, mtime } = await vscode.workspace.fs.stat(vscode.Uri.file(archive));
    const stamp = `${size}/${mtime}`;
    const held = this.listings.get(archive);
    if (held?.stamp === stamp) return held;
    const answered = await this.client.getArchiveContents(gameRelease, [archive]);
    if (isReadFailed(answered)) throw vscode.FileSystemError.Unavailable(failureReason(answered));
    const contents = answered.find((entry) => entry.archive === archive);
    if (contents === undefined) throw vscode.FileSystemError.Unavailable('mEdit did not list the archive.');
    if (typeof contents.unreadable === 'string') throw vscode.FileSystemError.Unavailable(contents.unreadable);
    const listing = { stamp, files: contents.files, fileSet: new Set(contents.files), folders: foldersOf(contents.files) };
    this.listings.set(archive, listing);
    return listing;
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

export function registerArchiveFiles(client: Pick<MEditClient, 'getArchiveFile' | 'getArchiveContents' | 'getArchiveCopies'>): vscode.Disposable {
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
