import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter, uriWith, type SchemedUri } from '../../test/vscodeMock';

interface TestDocument { uri: SchemedUri; getText?(): string; isDirty?: boolean }
interface Replacement { uri: SchemedUri; range: { start: number; end: number }; text: string }

const h = vi.hoisted(() => ({
  providers: new Map<string, unknown>(),
  textDocuments: [] as TestDocument[],
  files: new Map<string, Uint8Array>(),
  applyEdit: (_edit: { replacements: Replacement[] }) => Promise.resolve(true),
  disk: { mtime: 2, size: 3 },
  saved: [] as ((document: TestDocument) => void)[],
  closed: [] as ((document: TestDocument) => void)[],
}));

vi.mock('vscode', () => ({
  EventEmitter,
  Uri: { file: (path: string) => uriWith('file', path) },
  Disposable: class { constructor(public dispose: () => void) {} },
  FileChangeType: { Changed: 1 },
  FileSystemError: { NoPermissions: (uri: unknown) => new Error(`no permissions on ${String(uri)}`) },
  Range: class { constructor(public start: number, public end: number) {} },
  WorkspaceEdit: class {
    replacements: Replacement[] = [];
    replace(uri: SchemedUri, range: Replacement['range'], text: string) { this.replacements.push({ uri, range, text }); }
  },
  workspace: {
    registerFileSystemProvider: (scheme: string, provider: unknown) => {
      h.providers.set(scheme, provider);
      return { dispose: () => h.providers.delete(scheme) };
    },
    get textDocuments() { return h.textDocuments; },
    applyEdit: (edit: { replacements: Replacement[] }) => h.applyEdit(edit),
    onDidSaveTextDocument: (listener: (document: TestDocument) => void) => { h.saved.push(listener); return { dispose: () => undefined }; },
    onDidCloseTextDocument: (listener: (document: TestDocument) => void) => { h.closed.push(listener); return { dispose: () => undefined }; },
    fs: {
      stat: () => Promise.resolve({ type: 1, ctime: 1, ...h.disk }),
      readFile: (uri: SchemedUri) => Promise.resolve(h.files.get(`${uri.scheme}:${uri.path}?${uri.query}`)),
      writeFile: (uri: SchemedUri, content: Uint8Array) => {
        h.files.set(`${uri.scheme}:${uri.path}?${uri.query}`, content);
        return Promise.resolve();
      },
    },
  },
}));

import { ChildRecordDocuments } from '../childRecordDocument';

interface FileSystem {
  stat(uri: unknown): Promise<{ size: number }>;
  readFile(uri: unknown): Promise<Uint8Array>;
  writeFile(uri: unknown, content: Uint8Array, options: unknown): Promise<void>;
  onDidChangeFile(listener: (events: { type: number; uri: unknown }[]) => void): unknown;
}

const isFileSystem = (value: unknown): value is FileSystem =>
  typeof value === 'object' && value !== null && 'readFile' in value && 'writeFile' in value && 'onDidChangeFile' in value;

const CELL_FILE = '/source/ModA/plugin-source/A.esp/Cells/Cell.json';
const saved = (document: TestDocument): void => { h.saved.forEach((listener) => { listener(document); }); };
const closed = (document: TestDocument): void => { h.closed.forEach((listener) => { listener(document); }); };

const childUri = (path: string, query: string) => uriWith('modbench-child-record', path, query);
const PLACED_URI = childUri(CELL_FILE, 'formKey=000803%3AA.esp&name=A.esp&origin=ModA');

function childDocuments() {
  const documents = new ChildRecordDocuments();
  const [files] = h.providers.values();
  if (!isFileSystem(files)) throw new Error('no file system registered');
  const changed: unknown[] = [];
  files.onDidChangeFile((events) => changed.push(...events.map(({ uri }) => uri)));
  return { documents, files, changed };
}

beforeEach(() => {
  h.providers.clear();
  h.textDocuments.length = 0;
  h.files.clear();
  h.applyEdit = () => Promise.resolve(true);
  h.disk = { mtime: 2, size: 3 };
  h.saved.length = 0;
  h.closed.length = 0;
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
    const container = { uri: uriWith('file', CELL_FILE), getText: () => text, get isDirty() { return isDirty; }, positionAt: (offset: number) => offset, save };
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

  const WRITTEN = new TextEncoder().encode('written');
  const opened = (files: FileSystem) => {
    h.textDocuments.push({ uri: PLACED_URI });
    return async () => (await files.stat(PLACED_URI)).size;
  };

  it('states the file\'s stat, and the size it read once Modbench wrote the file, as it does on a save', async () => {
    const { files } = childDocuments();
    const sizeStated = opened(files);
    expect(await sizeStated()).toBe(3);

    h.disk = { mtime: 5, size: WRITTEN.byteLength };
    await files.writeFile(PLACED_URI, WRITTEN, { create: true, overwrite: true });
    const afterOwnWrite = await sizeStated();
    h.disk = { mtime: 6, size: 12 };
    saved({ uri: uriWith('file', CELL_FILE), getText: () => 'x'.repeat(12) });
    const afterOwnSave = await sizeStated();
    h.disk = { mtime: 7, size: 20 };

    expect([afterOwnWrite, afterOwnSave, await sizeStated()]).toEqual([3, 3, 20]);
  });

  it('takes the file for another program\'s once its size is not what Modbench wrote or saved', async () => {
    const { files } = childDocuments();
    const sizeStated = opened(files);
    await sizeStated();

    h.disk = { mtime: 5, size: 9 };
    await files.writeFile(PLACED_URI, WRITTEN, { create: true, overwrite: true });
    const afterWrite = await sizeStated();
    h.disk = { mtime: 6, size: 13 };
    saved({ uri: uriWith('file', CELL_FILE), getText: () => 'x'.repeat(12) });

    expect([afterWrite, await sizeStated()]).toEqual([9, 13]);
  });

  it('keeps the size it read past a stat its unsaved document\'s save takes while a sibling\'s save is writing the file', async () => {
    const { files } = childDocuments();
    const child: TestDocument = { uri: PLACED_URI, isDirty: false };
    h.textDocuments.push(child);
    const sizeStated = async () => (await files.stat(PLACED_URI)).size;
    await sizeStated();
    child.isDirty = true;

    h.disk = { mtime: 5, size: 0 };
    const midWrite = await sizeStated();
    h.disk = { mtime: 6, size: 12 };
    saved({ uri: uriWith('file', CELL_FILE), getText: () => 'x'.repeat(12) });

    expect([midWrite, await sizeStated()]).toEqual([0, 3]);
  });

  it('forgets what its document read once it closes, so one opened again reads the file afresh', async () => {
    const { files } = childDocuments();
    const sizeStated = opened(files);
    await sizeStated();
    h.disk = { mtime: 5, size: WRITTEN.byteLength };
    await files.writeFile(PLACED_URI, WRITTEN, { create: true, overwrite: true });

    h.textDocuments.length = 0;
    closed({ uri: PLACED_URI });

    expect(await opened(files)()).toBe(WRITTEN.byteLength);
  });
});

describe('an open child record\'s document, when copies change', () => {
  const open = (...uris: SchemedUri[]) => { h.textDocuments.push(...uris.map((uri) => ({ uri }))); };
  const inModA = (copy: { plugin: { origin: string } }) => copy.plugin.origin === 'ModA';

  it('changes when its copy is one that changed, as a sibling\'s change changes its container\'s file', () => {
    const { documents, changed } = childDocuments();
    open(PLACED_URI, uriWith('file', CELL_FILE));

    documents.changedWhere(inModA);

    expect(changed).toEqual([PLACED_URI]);
  });

  it('stays as it is when its copy is not one that changed', () => {
    const { documents, changed } = childDocuments();
    open(PLACED_URI);

    documents.changedWhere((copy) => copy.plugin.origin === 'ModB');

    expect(changed).toEqual([]);
  });

  it('changes every one whose copy changed', () => {
    const { documents, changed } = childDocuments();
    const [a, b] = [PLACED_URI, childUri('/b.json', 'formKey=000901%3AB.esp&name=B.esp&origin=ModB')];
    open(a, b);

    documents.changedWhere(() => true);

    expect(changed).toEqual([a, b]);
  });
});
