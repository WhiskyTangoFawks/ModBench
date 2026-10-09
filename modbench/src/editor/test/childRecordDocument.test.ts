import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from '../../test/vscodeMock';

interface TestUri {
  scheme: string; path: string; fsPath: string; query: string;
  with(change: Partial<Pick<TestUri, 'scheme' | 'query'>>): TestUri;
  toString(): string;
}
interface TestDocument { uri: TestUri }
interface Replacement { uri: TestUri; range: { start: number; end: number }; text: string }

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
    applyEdit: (_edit: { replacements: Replacement[] }) => Promise.resolve(true),
    disk: { mtime: 2, size: 3 },
    saved: [] as ((document: TestDocument) => void)[],
  };
});

vi.mock('vscode', () => ({
  EventEmitter,
  Uri: { file: (path: string) => h.uri('file', path) },
  Disposable: class { constructor(public dispose: () => void) {} },
  FileChangeType: { Changed: 1 },
  FileSystemError: { NoPermissions: (uri: unknown) => new Error(`no permissions on ${String(uri)}`) },
  Range: class { constructor(public start: number, public end: number) {} },
  WorkspaceEdit: class {
    replacements: Replacement[] = [];
    replace(uri: TestUri, range: Replacement['range'], text: string) { this.replacements.push({ uri, range, text }); }
  },
  workspace: {
    registerFileSystemProvider: (scheme: string, provider: unknown) => {
      h.providers.set(scheme, provider);
      return { dispose: () => h.providers.delete(scheme) };
    },
    get textDocuments() { return h.textDocuments; },
    applyEdit: (edit: { replacements: Replacement[] }) => h.applyEdit(edit),
    onDidSaveTextDocument: (listener: (document: TestDocument) => void) => { h.saved.push(listener); return { dispose: () => undefined }; },
    onDidCloseTextDocument: () => ({ dispose: () => undefined }),
    fs: {
      stat: () => Promise.resolve({ type: 1, ctime: 1, ...h.disk }),
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
  stat(uri: unknown): Promise<{ size: number }>;
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
  h.applyEdit = () => Promise.resolve(true);
  h.disk = { mtime: 2, size: 3 };
  h.saved.length = 0;
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

  it('saves through its container\'s open document, which takes the saved text and writes the file', async () => {
    let text = '{ "EditorID": "Typed" }';
    let isDirty = false;
    const save = vi.fn(() => Promise.resolve(true));
    const container = { uri: h.uri('file', CELL_FILE), getText: () => text, get isDirty() { return isDirty; }, positionAt: (offset: number) => offset, save };
    h.textDocuments.push(container);
    h.applyEdit = ({ replacements }) => {
      for (const { range, text: replacement } of replacements) text = text.slice(0, range.start) + replacement + text.slice(range.end);
      isDirty = true;
      return Promise.resolve(true);
    };
    const { files } = childDocuments();

    await files.writeFile(PLACED_URI, new TextEncoder().encode('{ "EditorID": "Saved" }'), { create: true, overwrite: true });

    expect([text, save.mock.calls.length, h.files.size]).toEqual(['{ "EditorID": "Saved" }', 1, 0]);
  });

  it('states the file\'s stat, and the size it read once Modbench wrote the file, as it does on a save', async () => {
    const { files } = childDocuments();
    h.textDocuments.push({ uri: PLACED_URI });
    const sizeStated = async () => (await files.stat(PLACED_URI)).size;
    expect(await sizeStated()).toBe(3);

    h.disk = { mtime: 5, size: 9 };
    await files.writeFile(PLACED_URI, new TextEncoder().encode('written'), { create: true, overwrite: true });
    const afterOwnWrite = await sizeStated();
    h.disk = { mtime: 6, size: 12 };
    for (const listener of h.saved) listener({ uri: h.uri('file', CELL_FILE) });
    const afterOwnSave = await sizeStated();
    h.disk = { mtime: 7, size: 20 };

    expect([afterOwnWrite, afterOwnSave, await sizeStated()]).toEqual([3, 3, 20]);
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
