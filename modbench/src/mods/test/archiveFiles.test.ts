import { describe, it, expect, vi } from 'vitest';
import { Uri } from '../../test/vscodeMock';

const folderUpdates = vi.hoisted(() => [] as [number, number, { uri: { query: string }; name: string }][]);
const registered = vi.hoisted(() => new Map<string, (...args: unknown[]) => unknown>());
const registrations = vi.hoisted(() => new Map<string, { provider: Record<string, (...args: unknown[]) => unknown>; options?: { isReadonly?: boolean } }>());

vi.mock('vscode', () => ({
  window: { showOpenDialog: () => Promise.resolve([{ fsPath: '/games/Fallout4/Data/Chosen.ba2' }]) },
  workspace: {
    workspaceFolders: [{}],
    updateWorkspaceFolders: (...args: [number, number, { uri: { query: string }; name: string }]) => { folderUpdates.push(args); return true; },
    registerFileSystemProvider: (scheme: string, provider: Record<string, (...args: unknown[]) => unknown>, options?: { isReadonly?: boolean }) => {
      registrations.set(scheme, { provider, options });
      return { dispose: () => undefined };
    },
  },
  Uri,
  EventEmitter: class { event = () => ({ dispose: () => undefined }); },
  Disposable: class { constructor(public dispose: () => void) {} },
  FileType: { File: 1, Directory: 2 },
  commands: { registerCommand: (id: string, handler: (...args: unknown[]) => unknown) => { registered.set(id, handler); return { dispose: () => undefined }; }, executeCommand: () => Promise.resolve() },
  FileSystemError: {
    NoPermissions: (uri: { path: string }) => new Error(`NoPermissions ${uri.path}`),
    FileNotFound: (what: { path: string }) => new Error(`FileNotFound ${what.path}`),
    Unavailable: (what: string) => new Error(`Unavailable ${what}`),
  },
}));

import { archivedFileUri, archiveUri, registerArchiveFiles, registerArchiveOpen } from '../archiveFiles';
import { InMemoryMEditClient } from '../../client/test/InMemoryMEditClient';

const address = { gameRelease: 'Fallout4', archive: '/mods/A/A - Main.ba2', file: 'scripts/a.pex' };

const contents = [{ archive: address.archive, files: ['scripts/a.pex', 'scripts/b.pex', 'readme.txt'] }];

function served(client: InMemoryMEditClient) {
  registerArchiveFiles(client);
  const registration = registrations.get('modbench-archive');
  if (!registration) throw new Error('no file system registered');
  return registration;
}

describe('the archive file system (mods.md, The tree, story 13)', () => {
  it('is registered read-only', () => {
    expect(served(new InMemoryMEditClient()).options).toEqual({ isReadonly: true });
  });

  it('serves a file of an archive from mEdit, and states its size', async () => {
    const client = new InMemoryMEditClient();
    client.setQueryAnswer('getArchiveContents', contents);
    client.setQueryAnswer('getArchiveFile', new Uint8Array([7, 8, 9]));
    const { provider } = served(client);

    await expect(provider.readFile?.(archivedFileUri(address))).resolves.toEqual(new Uint8Array([7, 8, 9]));
    await expect(provider.stat?.(archivedFileUri(address))).resolves.toMatchObject({ size: 3 });
    expect(client.calls.filter((call) => call.method === 'getArchiveFile')[0]?.args).toEqual(['Fallout4', '/mods/A/A - Main.ba2', 'scripts/a.pex']);
  });

  it('asks mEdit once for a file that VS Code states and then reads, and again for the next open', async () => {
    const client = new InMemoryMEditClient();
    client.setQueryAnswer('getArchiveContents', contents);
    client.setQueryAnswer('getArchiveFile', new Uint8Array([7]));
    const { provider } = served(client);
    const asks = () => client.calls.filter((call) => call.method === 'getArchiveFile').length;

    await provider.stat?.(archivedFileUri(address));
    await provider.readFile?.(archivedFileUri(address));
    expect(asks()).toBe(1);

    await provider.readFile?.(archivedFileUri(address));
    expect(asks()).toBe(2);
  });

  it('says why when mEdit could not serve the file', async () => {
    const client = new InMemoryMEditClient();
    client.setQueryFailure('getArchiveFile', { failed: 'refused', refusal: 'it is no BA2' });

    await expect(served(client).provider.readFile?.(archivedFileUri(address))).rejects.toThrow('Unavailable it is no BA2');
  });

  it('lists the root and a folder of an archive as folders of files, and states them as directories', async () => {
    const client = new InMemoryMEditClient();
    client.setQueryAnswer('getArchiveContents', contents);
    const { provider } = served(client);
    const root = archiveUri(address);
    const scripts = Uri.from({ scheme: root.scheme, path: '/A - Main.ba2/scripts', query: root.query });

    await expect(provider.readDirectory?.(root)).resolves.toEqual([['scripts', 2], ['readme.txt', 1]]);
    await expect(provider.readDirectory?.(scripts)).resolves.toEqual([['a.pex', 1], ['b.pex', 1]]);
    await expect(provider.stat?.(root)).resolves.toMatchObject({ type: 2 });
    await expect(provider.stat?.(scripts)).resolves.toMatchObject({ type: 2 });
  });

  it('says why when the archive cannot be read', async () => {
    const client = new InMemoryMEditClient();
    client.setQueryAnswer('getArchiveContents', [{ archive: address.archive, files: [], unreadable: 'not a BA2' }]);

    await expect(served(client).provider.readDirectory?.(archiveUri(address))).rejects.toThrow('Unavailable not a BA2');
  });

  it('has no file at a path the archive does not hold', async () => {
    const client = new InMemoryMEditClient();
    client.setQueryAnswer('getArchiveContents', contents);

    await expect(served(client).provider.stat?.(Uri.from({ scheme: 'modbench-archive', path: '/A - Main.ba2/nothing.txt', query: archiveUri(address).query }))).rejects.toThrow('FileNotFound');
  });

  it.each(['writeFile', 'createDirectory', 'delete', 'rename'])('refuses %s', (verb) => {
    const { provider } = served(new InMemoryMEditClient());

    expect(() => provider[verb]?.(archivedFileUri(address))).toThrow('NoPermissions');
  });
});

describe('open an archive from the Explorer (commands.md, Archive, open)', () => {
  const fileUri = (path: string) => Uri.file(path);
  const open = async (clicked: unknown) => {
    const reporter = { report: vi.fn() };
    registerArchiveOpen({ gameRelease: () => Promise.resolve('Fallout4'), reporter });
    await registered.get('modbench.archive.open')?.(clicked);
    return reporter;
  };

  it('adds the archive to the workspace as a folder named for it, after the folders it holds', async () => {
    folderUpdates.length = 0;
    await open(fileUri(address.archive));

    expect(folderUpdates).toHaveLength(1);
    expect(folderUpdates[0]?.slice(0, 2)).toEqual([1, 0]);
    expect(folderUpdates[0]?.[2]).toMatchObject({ name: 'A - Main.ba2' });
    expect(JSON.parse(folderUpdates[0]?.[2].uri.query ?? '')).toEqual({ gameRelease: 'Fallout4', archive: address.archive });
  });

  it('asks for an archive when the palette runs it with none', async () => {
    folderUpdates.length = 0;
    await open(undefined);

    expect(folderUpdates[0]?.[2]).toMatchObject({ name: 'Chosen.ba2' });
  });

  it('reports a failure to say which game the archive is read as', async () => {
    const reporter = { report: vi.fn() };
    registerArchiveOpen({ gameRelease: () => Promise.reject(new Error('no instance')), reporter });
    await registered.get('modbench.archive.open')?.(fileUri(address.archive));

    expect(reporter.report).toHaveBeenCalledWith('error', expect.stringContaining('A - Main.ba2'), 'no instance');
  });
});
