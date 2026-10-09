import { describe, it, expect, vi, beforeEach } from 'vitest';
import { settled } from '../../test/settled';

interface FakeDocument {
  uri: { scheme: string; fsPath: string; toString(): string };
  text: string;
  isDirty: boolean;
  isClosed: boolean;
  getText(): string;
  positionAt(offset: number): number;
  save(): Promise<boolean>;
}
interface Change { document: FakeDocument; contentChanges: unknown[]; reason?: number }
interface Replacement { uri: FakeDocument['uri']; range: { start: number; end: number }; text: string }

const h = vi.hoisted(() => ({
  documents: [] as FakeDocument[],
  changed: [] as ((change: Change) => void)[],
  opened: [] as ((document: FakeDocument) => void)[],
  saved: [] as ((document: FakeDocument) => void)[],
  afterEdit: (): void => undefined,
}));

vi.mock('vscode', () => {
  const on = <T>(listeners: ((event: T) => void)[]) => (listener: (event: T) => void) => {
    listeners.push(listener);
    return { dispose: () => undefined };
  };
  return {
    Range: class { constructor(public start: number, public end: number) {} },
    WorkspaceEdit: class {
      replacements: Replacement[] = [];
      replace(uri: Replacement['uri'], range: Replacement['range'], text: string) { this.replacements.push({ uri, range, text }); }
    },
    Disposable: { from: (...all: { dispose(): void }[]) => ({ dispose: () => { for (const each of all) each.dispose(); } }) },
    workspace: {
      get textDocuments() { return h.documents; },
      onDidChangeTextDocument: on(h.changed),
      onDidOpenTextDocument: on(h.opened),
      onDidSaveTextDocument: on(h.saved),
      applyEdit: ({ replacements }: { replacements: Replacement[] }) => {
        for (const { uri, range, text } of replacements) {
          const document = h.documents.find((each) => each.uri === uri);
          if (!document) return Promise.resolve(false);
          changed(document, document.text.slice(0, range.start) + text + document.text.slice(range.end), true);
        }
        h.afterEdit();
        return Promise.resolve(true);
      },
    },
  };
});

import { holdOneTextPerFile } from '../oneTextPerFile';

const CELL = '/mods/ModA/plugin-source/A.esp/Cells/Cell.json';
let made = 0;

function document(scheme: string, text: string, isDirty = false, fsPath = CELL): FakeDocument {
  const key = `${scheme}:${fsPath}?${++made}`;
  const document_: FakeDocument = {
    uri: { scheme, fsPath, toString: () => key }, text, isDirty, isClosed: false,
    getText: () => document_.text,
    positionAt: (offset) => offset,
    save: () => {
      document_.isDirty = false;
      for (const listener of h.saved) listener(document_);
      return Promise.resolve(true);
    },
  };
  h.documents.push(document_);
  return document_;
}

function changed(changing: FakeDocument, text: string, isDirty: boolean, reason?: number): void {
  Object.assign(changing, { text, isDirty });
  for (const listener of h.changed) listener({ document: changing, contentChanges: [{}], reason });
}

const shown = (...documents: FakeDocument[]) => documents.map(({ text, isDirty }) => ({ text, unsaved: isDirty }));
const UNDO = 1;

beforeEach(() => {
  h.documents.length = 0;
  h.changed.length = 0;
  h.opened.length = 0;
  h.saved.length = 0;
  h.afterEdit = () => undefined;
  holdOneTextPerFile({ warn: () => undefined });
});

describe('the documents over one file', () => {
  it('give an unsaved change in one to each other document over the file, and to none over another', async () => {
    const [file, child] = [document('file', 'saved'), document('modbench-child-record', 'saved')];
    const elsewhere = document('file', 'saved', false, '/mods/ModA/plugin-source/A.esp/Cells/Other.json');

    changed(file, 'typed', true);
    await settled();

    expect(shown(child, elsewhere)).toEqual([{ text: 'typed', unsaved: true }, { text: 'saved', unsaved: false }]);
  });

  it('keep a change typed while another takes the one before it, passing none back', async () => {
    const [file, child] = [document('file', 'saved'), document('modbench-child-record', 'saved')];
    h.afterEdit = () => {
      h.afterEdit = () => undefined;
      changed(file, 'typed again', true);
    };

    changed(file, 'typed', true);
    await settled();

    expect([file.text, child.text]).toEqual(['typed again', 'typed again']);
  });

  it('keep an unsaved text when another reads the file again, as a revert does, and that one takes it', async () => {
    const [file, child] = [document('file', 'typed', true), document('modbench-child-record', 'typed', true)];

    changed(child, 'saved', false);
    await settled();

    expect(shown(file, child)).toEqual([{ text: 'typed', unsaved: true }, { text: 'typed', unsaved: true }]);
  });

  it('give an undo back to the saved text to each other document', async () => {
    const [file, child] = [document('file', 'typed', true), document('modbench-child-record', 'typed', true)];

    changed(file, 'saved', false, UNDO);
    await settled();

    expect(child.text).toBe('saved');
  });

  it('have one that opens take the unsaved text of another', async () => {
    document('file', 'typed', true);
    const child = document('modbench-child-record', 'saved');

    for (const listener of h.opened) listener(child);
    await settled();

    expect(shown(child)).toEqual([{ text: 'typed', unsaved: true }]);
  });

  it('save with one each other holding the text it saved, and no other', async () => {
    const file = document('file', 'typed', true);
    const [holding, other] = [document('modbench-child-record', 'typed', true), document('modbench-child-record', 'other', true)];

    await file.save();
    await settled();

    expect(shown(holding, other)).toEqual([{ text: 'typed', unsaved: false }, { text: 'other', unsaved: true }]);
  });
});
