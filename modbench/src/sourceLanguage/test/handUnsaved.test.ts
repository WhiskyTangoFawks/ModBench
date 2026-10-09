import { describe, it, expect, vi, beforeEach } from 'vitest';

interface FakeUri { scheme: string; fsPath: string; toString(): string }
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

import { handUnsavedPluginSource } from '../handUnsaved';

const FILE = '/mods/ModA/plugin-source/A.esp/Cells/Cell.json';
const MOVED = '/mods/ModA/plugin-source/A.esp/Cells/Moved.json';

const document = (scheme: string, fsPath: string, text: string, isDirty = true): FakeDocument =>
  ({ uri: { scheme, fsPath, toString: () => `${scheme}:${fsPath}` }, isDirty, getText: () => text });

function handing() {
  const handed: { path: string; text: string }[][] = [];
  handUnsavedPluginSource({ handUnsavedDocuments: (documents) => { handed.push([...documents]); } });
  handed.length = 0;
  return handed;
}
const changed = (doc: FakeDocument) => { for (const listener of h.handlers.change) listener({ document: doc }); };

beforeEach(() => {
  h.workspace.textDocuments = [];
  for (const list of Object.values(h.handlers)) list.length = 0;
});

describe('handing mEdit the unsaved plugin source', () => {
  it('hands a dirty child-record document as its container file\'s text', () => {
    const child = document('modbench-child-record', FILE, 'child text');
    h.workspace.textDocuments = [child];
    const handed = handing();

    changed(child);

    expect(handed.at(-1)).toEqual([{ path: FILE, text: 'child text' }]);
  });

  it('hands a file once when its own document and a child record\'s are both unsaved', () => {
    const file = document('file', FILE, 'unsaved text');
    const child = document('modbench-child-record', FILE, 'unsaved text');
    h.workspace.textDocuments = [file, child];
    const handed = handing();

    changed(child);

    expect(handed.at(-1)).toEqual([{ path: FILE, text: 'unsaved text' }]);
  });

  it('hands over again when a dirty document is moved, which closes it at one path and opens it at another', () => {
    const before = document('file', FILE, 'moved text');
    h.workspace.textDocuments = [before];
    const handed = handing();

    const after = document('file', MOVED, 'moved text');
    h.workspace.textDocuments = [after];
    for (const listener of h.handlers.close) listener(before);
    for (const listener of h.handlers.open) listener(after);

    expect(handed.at(-1)).toEqual([{ path: MOVED, text: 'moved text' }]);
  });

  it.each([
    ['a file outside plugin source', 'file', '/mods/ModA/readme.txt'],
    ['a version-control document of plugin source', 'git', FILE],
  ])('hands nothing over for %s changing, opening or closing', (_name, scheme, path) => {
    const other = document(scheme, path, 'typed');
    h.workspace.textDocuments = [other];
    const handed = handing();

    changed(other);
    for (const listener of h.handlers.open) listener(other);
    for (const listener of h.handlers.close) listener(other);

    expect(handed).toEqual([]);
  });
});
