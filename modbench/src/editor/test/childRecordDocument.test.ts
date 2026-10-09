import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from '../../test/vscodeMock';

interface TestUri {
  scheme: string; path: string; fsPath: string; query: string;
  with(change: Partial<Pick<TestUri, 'scheme' | 'query'>>): TestUri;
  toString(): string;
}
interface TestDocument { uri: TestUri; isDirty?: boolean; getText?(): string; save?(): Promise<boolean> }

const h = vi.hoisted(() => {
  const uri = (scheme: string, path: string, query = ''): TestUri => ({
    scheme, path, fsPath: path, query,
    with: (change) => uri(change.scheme ?? scheme, path, change.query ?? query),
    toString: () => `${scheme}:${path}?${query}`,
  });
  return {
    uri,
    providers: new Map<string, unknown>(),
    textDocuments: [] as TestDocument[],
    files: new Map<string, Uint8Array>(),
    size: 3,
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
    onDidCloseTextDocument: () => ({ dispose: () => undefined }),
    fs: {
      stat: () => Promise.resolve({ type: 1, ctime: 1, mtime: 2, size: h.size }),
      readFile: (uri: TestUri) => Promise.resolve(h.files.get(`${uri.scheme}:${uri.path}?${uri.query}`)),
      writeFile: (uri: TestUri, content: Uint8Array) => {
        h.files.set(`${uri.scheme}:${uri.path}?${uri.query}`, content);
        return Promise.resolve();
      },
    },
  },
}));

import { ChildRecordDocuments } from '../childRecordDocument';
import { InMemoryMEditClient } from '../../client/test/InMemoryMEditClient';

interface FileSystem {
  stat(uri: unknown): Promise<unknown>;
  readFile(uri: unknown): Promise<Uint8Array>;
  writeFile(uri: unknown, content: Uint8Array, options: unknown): Promise<void>;
  onDidChangeFile(listener: (events: { type: number; uri: unknown }[]) => void): unknown;
}

const isFileSystem = (value: unknown): value is FileSystem =>
  typeof value === 'object' && value !== null && 'readFile' in value && 'writeFile' in value && 'onDidChangeFile' in value;

const CELL_FILE = '/mods/ModA/plugin-source/A.esp/Cells/Cell.json';
const modA = { name: 'A.esp', origin: 'ModA' };
const placed = { formKey: '000803:A.esp', plugin: modA };
const childUri = (path: string, query: string) => h.uri('modbench-child-record', path, query);
const PLACED_URI = childUri(CELL_FILE, 'formKey=000803%3AA.esp&name=A.esp&origin=ModA');

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
  h.size = 3;
});

describe('a child record\'s document', () => {
  it('is its container\'s file, read through to it', async () => {
    h.files.set(`file:${CELL_FILE}?`, new TextEncoder().encode('{ "EditorID": "Cell" }'));
    const { files } = childDocuments();

    const text = new TextDecoder().decode(await files.readFile(PLACED_URI));

    expect(text).toBe('{ "EditorID": "Cell" }');
  });

  it('reads its container\'s file byte for byte, a byte order mark included', async () => {
    const withBom = Uint8Array.from([0xef, 0xbb, 0xbf, 0x7b, 0x7d]);
    h.files.set(`file:${CELL_FILE}?`, withBom);
    const { files } = childDocuments();

    expect([...await files.readFile(PLACED_URI)]).toEqual([0xef, 0xbb, 0xbf, 0x7b, 0x7d]);
  });

  it('refuses a container\'s file that is not UTF-8 text, so no save writes it back altered', async () => {
    h.files.set(`file:${CELL_FILE}?`, Uint8Array.from([0x7b, 0xff, 0x7d]));
    const { files } = childDocuments();

    await expect(files.readFile(PLACED_URI)).rejects.toThrow(TypeError);
  });

  it('saves to its container\'s file', async () => {
    const { files } = childDocuments();

    await files.writeFile(PLACED_URI, new TextEncoder().encode('{ "EditorID": "Saved" }'), { create: true, overwrite: true });

    expect(new TextDecoder().decode(h.files.get(`file:${CELL_FILE}?`))).toBe('{ "EditorID": "Saved" }');
  });

  it('saves through its container\'s open document, which writes the file', async () => {
    const save = vi.fn(() => Promise.resolve(true));
    h.textDocuments.push({ uri: h.uri('file', CELL_FILE), isDirty: true, getText: () => '{ "EditorID": "Saved" }', save });
    const { files } = childDocuments();

    await files.writeFile(PLACED_URI, new TextEncoder().encode('{ "EditorID": "Saved" }'), { create: true, overwrite: true });

    expect(save).toHaveBeenCalledOnce();
    expect(h.files.size).toBe(0);
  });

  it('states the file\'s stat, its size as it read it while its container\'s document is open', async () => {
    const { files } = childDocuments();
    expect(await files.stat(PLACED_URI)).toEqual({ type: 1, ctime: 1, mtime: 2, size: 3 });
    h.textDocuments.push({ uri: h.uri('file', CELL_FILE) });
    h.size = 9;

    expect(await files.stat(PLACED_URI)).toEqual({ type: 1, ctime: 1, mtime: 2, size: 3 });
    h.textDocuments.length = 0;
    expect(await files.stat(PLACED_URI)).toEqual({ type: 1, ctime: 1, mtime: 2, size: 9 });
  });
});

describe('an open child record\'s document, when mEdit reports a change', () => {
  const open = (...uris: TestUri[]) => { h.textDocuments.push(...uris.map((uri) => ({ uri }))); };

  it('changes when any record of its plugin changed, as a sibling\'s change changes its container\'s file', () => {
    const { client, changed } = childDocuments();
    const uri = PLACED_URI;
    open(uri, h.uri('file', CELL_FILE));

    client.emit({ kind: 'rows-changed', plugin: 'A.esp', origin: 'ModA', keys: ['000804:A.esp'], sequence: 1 });

    expect(changed).toEqual([uri]);
  });

  it('stays as it is when another plugin\'s records changed', () => {
    const { client, changed } = childDocuments();
    open(PLACED_URI);

    client.emit({ kind: 'rows-changed', plugin: 'A.esp', origin: 'ModB', keys: [placed.formKey], sequence: 1 });

    expect(changed).toEqual([]);
  });

  it('changes when mEdit read its plugin again whole', () => {
    const { client, changed } = childDocuments();
    const uri = PLACED_URI;
    open(uri);

    client.emit({ kind: 'plugin-changed', plugin: 'A.esp', origin: 'ModA', keys: [], sequence: 1 });

    expect(changed).toEqual([uri]);
  });

  it('changes, every one, when the stream of mEdit\'s reports opens again', () => {
    const { client, changed } = childDocuments();
    const [a, b] = [PLACED_URI, childUri('/b.json', 'formKey=000901%3AB.esp&name=B.esp&origin=ModB')];
    open(a, b);

    client.reconnected();

    expect(changed).toEqual([a, b]);
  });
});
