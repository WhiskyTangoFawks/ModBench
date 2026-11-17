import { describe, it, expect, vi, beforeEach } from 'vitest';
import { type FakeUri, Uri } from '../../test/vscodeMock';
import type { UnsavedDocumentChange } from '../../client/MEditClient';

interface FakeDocument { uri: FakeUri; isDirty: boolean; getText: () => string }

const h = vi.hoisted(() => {
  const handlers = {
    open: [] as ((d: unknown) => void)[], change: [] as ((e: { document: unknown }) => void)[],
    save: [] as ((d: unknown) => void)[], close: [] as ((d: unknown) => void)[],
  };
  const workspace = { textDocuments: [] as unknown[] };
  const subscribe = <T>(list: ((e: T) => void)[]) => (listener: (e: T) => void) => { list.push(listener); return { dispose: () => undefined }; };
  return { handlers, workspace, subscribe };
});

vi.mock('vscode', () => ({
  workspace: {
    get textDocuments() { return h.workspace.textDocuments; },
    onDidOpenTextDocument: h.subscribe(h.handlers.open),
    onDidChangeTextDocument: h.subscribe(h.handlers.change),
    onDidSaveTextDocument: h.subscribe(h.handlers.save),
    onDidCloseTextDocument: h.subscribe(h.handlers.close),
  },
  Disposable: { from: (...all: { dispose(): void }[]) => ({ dispose: () => { for (const each of all) each.dispose(); } }) },
}));

import { handUnsavedPluginSource } from '../handUnsaved';

const FILE = '/source/ModA/plugin-source/A.esp/Cells/Cell.json';
const OTHER = '/source/ModA/plugin-source/A.esp/Cells/Other.json';
const isPluginSource = (path: string) => path.includes('/plugin-source/');

let texts: Map<FakeDocument, { text: string; reads: number }>;
const document = (scheme: string, fsPath: string, text: string, isDirty = true): FakeDocument => {
  const made: FakeDocument = { uri: Uri.from({ scheme, path: fsPath }), isDirty, getText: () => { const held = texts.get(made); if (held) held.reads++; return held?.text ?? ''; } };
  texts.set(made, { text, reads: 0 });
  return made;
};
const retyped = (doc: FakeDocument, text: string) => { const held = texts.get(doc); if (held) held.text = text; };
const reads = (doc: FakeDocument) => texts.get(doc)?.reads ?? 0;
const fire = <T>(list: ((e: T) => void)[], event: T) => { list.forEach((listener) => { listener(event); }); };

function handing() {
  const handed: UnsavedDocumentChange[] = [];
  handUnsavedPluginSource({ handUnsavedDocument: (change) => { handed.push(change); } }, isPluginSource);
  return handed;
}

beforeEach(() => {
  texts = new Map();
  h.workspace.textDocuments = [];
  for (const list of Object.values(h.handlers)) list.length = 0;
});

describe('handing mEdit the unsaved plugin source', () => {
  it('hands a document already unsaved when it starts, and none that is saved', () => {
    h.workspace.textDocuments = [document('file', FILE, 'typed'), document('file', OTHER, 'saved', false)];

    expect(handing()).toEqual([{ path: FILE, text: 'typed', version: 1 }]);
  });

  it('hands a document as it is opened unsaved, and as each change makes a new text, at a higher version', () => {
    const handed = handing();
    const doc = document('file', FILE, 'first');
    h.workspace.textDocuments = [doc];
    fire(h.handlers.open, doc);
    retyped(doc, 'second');
    fire(h.handlers.change, { document: doc });

    expect(handed).toEqual([{ path: FILE, text: 'first', version: 1 }, { path: FILE, text: 'second', version: 2 }]);
  });

  it('reads only the document that changed, and hands nothing for a change that leaves the text as it was', () => {
    const bystander = document('file', OTHER, 'untouched');
    const doc = document('file', FILE, 'first');
    h.workspace.textDocuments = [bystander, doc];
    const handed = handing();
    const readsBefore = reads(bystander);
    handed.length = 0;

    fire(h.handlers.change, { document: doc });
    retyped(doc, 'second');
    fire(h.handlers.change, { document: doc });

    expect(handed).toEqual([{ path: FILE, text: 'second', version: 3 }]);
    expect(reads(bystander)).toBe(readsBefore);
  });

  it.each([
    ['saved', (doc: FakeDocument) => { doc.isDirty = false; fire(h.handlers.save, doc); }],
    ['reverted', (doc: FakeDocument) => { doc.isDirty = false; fire(h.handlers.change, { document: doc }); }],
    ['closed unsaved', (doc: FakeDocument) => { h.workspace.textDocuments = []; fire(h.handlers.close, doc); }],
  ])('hands the close of a document that is %s, once', (_how, end) => {
    const doc = document('file', FILE, 'typed');
    h.workspace.textDocuments = [doc];
    const handed = handing();
    handed.length = 0;

    end(doc);
    fire(h.handlers.change, { document: doc });

    expect(handed).toEqual([{ path: FILE, closed: true }]);
  });

    it('hands nothing when the document of a child record closes while the file\'s holds the text, and the close when that one does', () => {
    const file = document('file', FILE, 'typed');
    const child = document('modbench-child-record', FILE, 'typed');
    h.workspace.textDocuments = [file, child];
    const handed = handing();
    handed.length = 0;

    h.workspace.textDocuments = [file];
    fire(h.handlers.close, child);
    expect(handed).toEqual([]);
    fire(h.handlers.close, file);
    expect(handed).toEqual([{ path: FILE, closed: true }]);
  });

  it('holds back a document outside plugin source and a version-control document of plugin source', () => {
    h.workspace.textDocuments = [document('file', '/mods/ModA/readme.txt', 'typed'), document('git', FILE, 'typed')];

    expect(handing()).toEqual([]);
  });
});
