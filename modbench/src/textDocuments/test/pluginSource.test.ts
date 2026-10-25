import { describe, it, expect, vi, beforeEach } from 'vitest';
import { type FakeUri, Uri } from '../../test/vscodeMock';

interface FakeDocument { uri: FakeUri; isDirty: boolean; getText(): string }

const h = vi.hoisted(() => {
  const handlers = { change: [] as ((e: { document: unknown }) => void)[], open: [] as ((d: unknown) => void)[], close: [] as ((d: unknown) => void)[] };
  const workspace = { textDocuments: [] as unknown[] };
  const subscribe = <T>(list: ((e: T) => void)[]) => (listener: (e: T) => void) => { list.push(listener); return { dispose: () => undefined }; };
  return { handlers, workspace, subscribe };
});

vi.mock('vscode', () => ({
  workspace: {
    get textDocuments() { return h.workspace.textDocuments; },
    onDidChangeTextDocument: h.subscribe(h.handlers.change),
    onDidOpenTextDocument: h.subscribe(h.handlers.open),
    onDidCloseTextDocument: h.subscribe(h.handlers.close),
  },
  Disposable: { from: (...all: { dispose(): void }[]) => ({ dispose: () => { for (const each of all) each.dispose(); } }) },
}));

import { onPluginSourceChanged, unsavedPluginSource } from '../pluginSource';

const isPluginSource = (path: string) => path.includes('/plugin-source/');

const FILE = '/source/ModA/plugin-source/A.esp/Cells/Cell.json';
const MOVED = '/source/ModA/plugin-source/A.esp/Cells/Moved.json';

const document = (scheme: string, fsPath: string, text: string, isDirty = true): FakeDocument =>
  ({ uri: Uri.from({ scheme, path: fsPath }), isDirty, getText: () => text });

function unsavedAtEachChange() {
  const seen: { path: string; text: string }[][] = [];
  onPluginSourceChanged(isPluginSource, () => { seen.push(unsavedPluginSource(isPluginSource)); });
  return seen;
}
const changed = (doc: FakeDocument) => { h.handlers.change.forEach((listener) => { listener({ document: doc }); }); };
const opened = (doc: FakeDocument) => { h.handlers.open.forEach((listener) => { listener(doc); }); };
const closed = (doc: FakeDocument) => { h.handlers.close.forEach((listener) => { listener(doc); }); };

beforeEach(() => {
  h.workspace.textDocuments = [];
  for (const list of Object.values(h.handlers)) list.length = 0;
});

describe('the unsaved plugin source Text documents holds', () => {
  it('reports a dirty child-record document as its container file\'s text', () => {
    const child = document('modbench-child-record', FILE, 'child text');
    h.workspace.textDocuments = [child];
    const seen = unsavedAtEachChange();

    changed(child);

    expect(seen.at(-1)).toEqual([{ path: FILE, text: 'child text' }]);
  });

  it('reports a file once when its own document and a child record\'s are both unsaved', () => {
    const file = document('file', FILE, 'unsaved text');
    const child = document('modbench-child-record', FILE, 'unsaved text');
    h.workspace.textDocuments = [file, child];
    const seen = unsavedAtEachChange();

    changed(child);

    expect(seen.at(-1)).toEqual([{ path: FILE, text: 'unsaved text' }]);
  });

  it('reports again when a dirty document is moved, which closes it at one path and opens it at another', () => {
    const before = document('file', FILE, 'moved text');
    h.workspace.textDocuments = [before];
    const seen = unsavedAtEachChange();

    const after = document('file', MOVED, 'moved text');
    h.workspace.textDocuments = [after];
    closed(before);
    opened(after);

    expect(seen.at(-1)).toEqual([{ path: MOVED, text: 'moved text' }]);
  });

  it.each([
    ['a file outside plugin source', 'file', '/mods/ModA/readme.txt'],
    ['a version-control document of plugin source', 'git', FILE],
  ])('reports nothing for %s changing, opening or closing', (_name, scheme, path) => {
    const other = document(scheme, path, 'typed');
    h.workspace.textDocuments = [other];
    const seen = unsavedAtEachChange();

    changed(other);
    opened(other);
    closed(other);

    expect(seen).toEqual([]);
  });

  it('holds back a dirty file outside plugin source and a version-control document of plugin source', () => {
    h.workspace.textDocuments = [
      document('file', '/mods/ModA/readme.txt', 'typed'),
      document('git', FILE, 'typed'),
      document('file', FILE, 'unsaved text'),
    ];

    expect(unsavedPluginSource(isPluginSource)).toEqual([{ path: FILE, text: 'unsaved text' }]);
  });

  it('holds back a document that is saved', () => {
    h.workspace.textDocuments = [document('file', FILE, 'saved text', false)];

    expect(unsavedPluginSource(isPluginSource)).toEqual([]);
  });
});
