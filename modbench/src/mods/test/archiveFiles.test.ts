import { describe, it, expect, vi } from 'vitest';
import { Uri } from '../../test/vscodeMock';

const registrations = vi.hoisted(() => new Map<string, { provider: Record<string, (...args: unknown[]) => unknown>; options?: { isReadonly?: boolean } }>());

vi.mock('vscode', () => ({
  workspace: {
    registerFileSystemProvider: (scheme: string, provider: Record<string, (...args: unknown[]) => unknown>, options?: { isReadonly?: boolean }) => {
      registrations.set(scheme, { provider, options });
      return { dispose: () => undefined };
    },
  },
  Uri,
  EventEmitter: class { event = () => ({ dispose: () => undefined }); },
  Disposable: class { constructor(public dispose: () => void) {} },
  FileType: { File: 1 },
  FileSystemError: {
    NoPermissions: (uri: { path: string }) => new Error(`NoPermissions ${uri.path}`),
    FileNotFound: (what: { path: string }) => new Error(`FileNotFound ${what.path}`),
    Unavailable: (what: string) => new Error(`Unavailable ${what}`),
  },
}));

import { archivedFileUri, registerArchiveFiles } from '../archiveFiles';
import { InMemoryMEditClient } from '../../client/test/InMemoryMEditClient';

const address = { gameRelease: 'Fallout4', archive: '/mods/A/A - Main.ba2', file: 'scripts/a.pex' };

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
    client.setQueryAnswer('getArchiveFile', new Uint8Array([7, 8, 9]));
    const { provider } = served(client);

    await expect(provider.readFile?.(archivedFileUri(address))).resolves.toEqual(new Uint8Array([7, 8, 9]));
    await expect(provider.stat?.(archivedFileUri(address))).resolves.toMatchObject({ size: 3 });
    expect(client.calls.filter((call) => call.method === 'getArchiveFile')[0]?.args).toEqual(['Fallout4', '/mods/A/A - Main.ba2', 'scripts/a.pex']);
  });

  it('says why when mEdit could not serve the file', async () => {
    const client = new InMemoryMEditClient();
    client.setQueryFailure('getArchiveFile', { failed: 'refused', refusal: 'it is no BA2' });

    await expect(served(client).provider.readFile?.(archivedFileUri(address))).rejects.toThrow('Unavailable it is no BA2');
  });

  it.each(['writeFile', 'createDirectory', 'delete', 'rename'])('refuses %s', (verb) => {
    const { provider } = served(new InMemoryMEditClient());

    expect(() => provider[verb]?.(archivedFileUri(address))).toThrow('NoPermissions');
  });
});
