import { describe, it, expect, vi, beforeEach } from 'vitest';

interface FakeDocument {
  uri: { scheme: string; fsPath: string }; isDirty: boolean; save: ReturnType<typeof vi.fn>;
}

const h = vi.hoisted(() => ({ textDocuments: [] as unknown[] }));

vi.mock('vscode', () => ({ workspace: { get textDocuments() { return h.textDocuments; } } }));

import { saveDirtyPluginSource } from '../dirtyPluginSource';

const FOLDER = '/mods/ModA/plugin-source/A.esp';
const CELL = `${FOLDER}/Cells/Cell.json`;

function document(scheme: string, fsPath: string, options: { saves?: boolean } = {}): FakeDocument {
  const doc: FakeDocument = {
    uri: { scheme, fsPath }, isDirty: true,
    save: vi.fn(() => { if (options.saves ?? true) doc.isDirty = false; return Promise.resolve(options.saves ?? true); }),
  };
  return doc;
}

beforeEach(() => { h.textDocuments = []; });

describe('saving the unsaved plugin source of a plugin\'s folder', () => {
  it('saves each unsaved document under the folder and answers nothing left unsaved', async () => {
    const cell = document('file', CELL);
    h.textDocuments = [cell];

    expect(await saveDirtyPluginSource(FOLDER)).toEqual([]);
    expect(cell.save).toHaveBeenCalledOnce();
  });

  it('leaves alone a document of another plugin\'s folder, a sibling folder of the same prefix, and a clean one', async () => {
    const other = document('file', '/mods/ModA/plugin-source/B.esp/Cell.json');
    const prefixed = document('file', `${FOLDER}x/plugin-source/Cell.json`);
    const clean = document('file', CELL);
    clean.isDirty = false;
    h.textDocuments = [other, prefixed, clean];

    expect(await saveDirtyPluginSource(FOLDER)).toEqual([]);
    for (const untouched of [other, prefixed, clean]) expect(untouched.save).not.toHaveBeenCalled();
  });

  it('matches the folder without case, as the layout does', async () => {
    const cell = document('file', '/Mods/ModA/Plugin-Source/a.esp/Cells/Cell.json');
    h.textDocuments = [cell];

    await saveDirtyPluginSource(FOLDER);

    expect(cell.save).toHaveBeenCalledOnce();
  });

  it('saves a file and a child record over it once: the file\'s save settles both', async () => {
    const file = document('file', CELL);
    const child = document('modbench-child-record', CELL);
    file.save.mockImplementation(() => { file.isDirty = false; child.isDirty = false; return Promise.resolve(true); });
    h.textDocuments = [file, child];

    expect(await saveDirtyPluginSource(FOLDER)).toEqual([]);
    expect(file.save).toHaveBeenCalledOnce();
    expect(child.save).not.toHaveBeenCalled();
  });

  it('answers the path of a document VS Code did not save, once', async () => {
    h.textDocuments = [document('file', CELL, { saves: false }), document('modbench-child-record', CELL, { saves: false })];

    expect(await saveDirtyPluginSource(FOLDER)).toEqual([CELL]);
  });
});
