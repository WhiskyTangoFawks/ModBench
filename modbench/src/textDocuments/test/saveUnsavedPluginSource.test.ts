import { describe, it, expect, vi, beforeEach } from 'vitest';

interface FakeDocument {
  uri: { scheme: string; fsPath: string }; isDirty: boolean; save: ReturnType<typeof vi.fn>;
}

const h = vi.hoisted(() => ({ textDocuments: [] as unknown[] }));

vi.mock('vscode', () => ({ workspace: { get textDocuments() { return h.textDocuments; } } }));

import { saveUnsavedPluginSource } from '../saveUnsavedPluginSource';

const FOLDER = '/source/ModA/plugin-source/A.esp';
const MOD = '/source/ModA';
const isPluginSource = (path: string) => path.toLowerCase().includes('/plugin-source/');
const save = () => saveUnsavedPluginSource(MOD, isPluginSource);
const CELL = `${FOLDER}/Cells/Cell.json`;

function document(scheme: string, fsPath: string, options: { saves?: boolean } = {}): FakeDocument {
  const doc: FakeDocument = {
    uri: { scheme, fsPath }, isDirty: true,
    save: vi.fn(() => { if (options.saves ?? true) doc.isDirty = false; return Promise.resolve(options.saves ?? true); }),
  };
  return doc;
}

beforeEach(() => { h.textDocuments = []; });

describe('saving the unsaved plugin source under a source folder', () => {
  it('saves each unsaved document under the folder, whichever plugin it belongs to, and answers nothing left unsaved', async () => {
    const cell = document('file', CELL);
    const sibling = document('file', '/source/ModA/plugin-source/B.esp/Cell.json');
    h.textDocuments = [cell, sibling];

    expect(await save()).toEqual([]);
    expect(cell.save).toHaveBeenCalledOnce();
    expect(sibling.save).toHaveBeenCalledOnce();
  });

  it.each<[string, string, boolean]>([
    ['a document of another mod\'s folder', '/source/ModB/plugin-source/B.esp/Cell.json', true],
    ['a sibling folder of the same prefix', '/source/ModAx/plugin-source/A.esp/Cell.json', true],
    ['a file that is no plugin source', '/source/ModA/assets/Notes.json', true],
    ['a clean document', CELL, false],
  ])('leaves alone %s', async (_case, path, isDirty) => {
    const untouched = document('file', path);
    untouched.isDirty = isDirty;
    h.textDocuments = [untouched];

    expect(await save()).toEqual([]);
    expect(untouched.save).not.toHaveBeenCalled();
  });

  it('matches the folder without case, as the layout does', async () => {
    const cell = document('file', '/Source/ModA/Plugin-Source/a.esp/Cells/Cell.json');
    h.textDocuments = [cell];

    await save();

    expect(cell.save).toHaveBeenCalledOnce();
  });

  it('saves a file and a child record over it once: the file\'s save settles both', async () => {
    const file = document('file', CELL);
    const child = document('modbench-child-record', CELL);
    file.save.mockImplementation(() => { file.isDirty = false; child.isDirty = false; return Promise.resolve(true); });
    h.textDocuments = [file, child];

    expect(await save()).toEqual([]);
    expect(file.save).toHaveBeenCalledOnce();
    expect(child.save).not.toHaveBeenCalled();
  });

  it('answers the path of a document VS Code did not save, once', async () => {
    h.textDocuments = [document('file', CELL, { saves: false }), document('modbench-child-record', CELL, { saves: false })];

    expect(await save()).toEqual([CELL]);
  });
});
