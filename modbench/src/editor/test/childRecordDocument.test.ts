import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from '../../test/vscodeMock';

interface TestUri { scheme: string; path: string; query: string; with(change: Partial<Pick<TestUri, 'scheme' | 'query'>>): TestUri }

const h = vi.hoisted(() => {
  const uri = (scheme: string, path: string, query = ''): TestUri =>
    ({ scheme, path, query, with: (change) => uri(change.scheme ?? scheme, path, change.query ?? query) });
  return {
    uri,
    providers: new Map<string, unknown>(),
    textDocuments: [] as { uri: TestUri }[],
    files: new Map<string, string>(),
  };
});

vi.mock('vscode', () => ({
  EventEmitter,
  Uri: { file: (path: string) => h.uri('file', path) },
  Disposable: class { constructor(public dispose: () => void) {} },
  FileChangeType: { Changed: 1 },
  FileSystemError: { NoPermissions: (uri: unknown) => new Error(`no permissions on ${String(uri)}`) },
  workspace: {
    registerFileSystemProvider: (scheme: string, provider: unknown) => {
      h.providers.set(scheme, provider);
      return { dispose: () => h.providers.delete(scheme) };
    },
    get textDocuments() { return h.textDocuments; },
    fs: {
      readFile: (uri: TestUri) => Promise.resolve(new TextEncoder().encode(h.files.get(`${uri.scheme}:${uri.path}?${uri.query}`))),
      writeFile: (uri: TestUri, content: Uint8Array) => {
        h.files.set(`${uri.scheme}:${uri.path}?${uri.query}`, new TextDecoder().decode(content));
        return Promise.resolve();
      },
    },
  },
}));

import { ChildRecordDocuments, childRecordUri } from '../childRecordDocument';
import { InMemoryMEditClient } from '../../client/test/InMemoryMEditClient';

interface FileSystem {
  readFile(uri: unknown): Promise<Uint8Array>;
  writeFile(uri: unknown, content: Uint8Array, options: unknown): Promise<void>;
  onDidChangeFile(listener: (events: { type: number; uri: unknown }[]) => void): unknown;
}

const isFileSystem = (value: unknown): value is FileSystem =>
  typeof value === 'object' && value !== null && 'readFile' in value && 'writeFile' in value && 'onDidChangeFile' in value;

const CELL_FILE = '/mods/ModA/plugin-source/A.esp/Cells/Cell.json';
const modA = { name: 'A.esp', origin: 'ModA' };
const placed = { formKey: '000803:A.esp', plugin: modA };

function childDocuments(client = new InMemoryMEditClient()) {
  const documents = new ChildRecordDocuments(client);
  const [files] = h.providers.values();
  if (!isFileSystem(files)) throw new Error('no file system registered');
  const changed: unknown[] = [];
  files.onDidChangeFile((events) => changed.push(...events.map(({ uri }) => uri)));
  return { documents, files, changed, client };
}

beforeEach(() => {
  h.providers.clear();
  h.textDocuments.length = 0;
  h.files.clear();
});

describe('a child record\'s document', () => {
  it('is its container\'s file, read through to it', async () => {
    h.files.set(`file:${CELL_FILE}?`, '{ "EditorID": "Cell" }');
    const { files } = childDocuments();

    const text = new TextDecoder().decode(await files.readFile(childRecordUri(placed, CELL_FILE)));

    expect(text).toBe('{ "EditorID": "Cell" }');
  });

  it('saves to its container\'s file', async () => {
    const { files } = childDocuments();

    await files.writeFile(childRecordUri(placed, CELL_FILE), new TextEncoder().encode('{ "EditorID": "Saved" }'), { create: true, overwrite: true });

    expect(h.files.get(`file:${CELL_FILE}?`)).toBe('{ "EditorID": "Saved" }');
  });

  it('is addressed apart from its sibling\'s, which shares its file', () => {
    expect(childRecordUri(placed, CELL_FILE)).not.toEqual(childRecordUri({ formKey: '000804:A.esp', plugin: modA }, CELL_FILE));
  });
});

describe('an open child record\'s document, when mEdit reports a change', () => {
  const open = (...uris: TestUri[]) => { h.textDocuments.push(...uris.map((uri) => ({ uri }))); };

  it('changes when any record of its plugin changed, as a sibling\'s change changes its container\'s file', () => {
    const { client, changed } = childDocuments();
    const uri = childRecordUri(placed, CELL_FILE);
    open(uri, h.uri('file', CELL_FILE));

    client.emit({ kind: 'rows-changed', plugin: 'A.esp', origin: 'ModA', keys: ['000804:A.esp'], sequence: 1 });

    expect(changed).toEqual([uri]);
  });

  it('stays as it is when another plugin\'s records changed', () => {
    const { client, changed } = childDocuments();
    open(childRecordUri(placed, CELL_FILE));

    client.emit({ kind: 'rows-changed', plugin: 'A.esp', origin: 'ModB', keys: [placed.formKey], sequence: 1 });

    expect(changed).toEqual([]);
  });

  it('changes when mEdit read its plugin again whole', () => {
    const { client, changed } = childDocuments();
    const uri = childRecordUri(placed, CELL_FILE);
    open(uri);

    client.emit({ kind: 'plugin-changed', plugin: 'A.esp', origin: 'ModA', keys: [], sequence: 1 });

    expect(changed).toEqual([uri]);
  });

  it('changes, every one, when the stream of mEdit\'s reports opens again', () => {
    const { client, changed } = childDocuments();
    const [a, b] = [childRecordUri(placed, CELL_FILE), childRecordUri({ formKey: '000901:B.esp', plugin: { name: 'B.esp', origin: 'ModB' } }, '/b.json')];
    open(a, b);

    client.reconnected();

    expect(changed).toEqual([a, b]);
  });
});
