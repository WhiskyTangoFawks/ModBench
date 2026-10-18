import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fakeUri, Range } from '../../test/vscodeMock';

const h = vi.hoisted(() => ({
  applied: [] as unknown[][],
  options: [] as unknown[],
  applyLands: true,
}));

vi.mock('vscode', () => ({
  Uri: { file: (path: string) => ({ scheme: 'file', path, fsPath: path }) },
  Range,
  WorkspaceEdit: class {
    readonly made: unknown[] = [];
    renameFile(from: { path: string }, to: { path: string }) { this.made.push(['move', from.path, to.path]); }
    deleteFile(uri: { path: string }, options: unknown) { this.made.push(['delete', uri.path, options]); }
    createFile(uri: { path: string }) { this.made.push(['create', uri.path]); }
    replace(uri: { path: string }, _range: unknown, text: string) { this.made.push(['replace', uri.path, text]); }
  },
  workspace: {
    applyEdit: (edit: { made: unknown[] }, options: unknown) => { h.applied.push(edit.made); h.options.push(options); return Promise.resolve(h.applyLands); },
  },
}));

import { applyWorkspaceChanges } from '../applyWorkspaceChanges';

const OWNER = '/mods/ModA/Cells/Cell.json';
const FOLDER = '/mods/ModA/Npcs/Npc';
const none = { moves: [], deletions: [], documents: [] };

beforeEach(() => {
  h.applied.length = 0;
  h.options.length = 0;
  h.applyLands = true;
});

describe('applying workspace changes', () => {
  it('makes each move in order, then puts each document\'s text, as one edit', async () => {
    await applyWorkspaceChanges([{ moves: [{ from: '/a/Npc.json', to: '/a/Renamed.json' }], deletions: [], documents: [{ path: '/a/Renamed.json', text: 'renamed' }] }]);

    expect(h.applied).toEqual([[['move', '/a/Npc.json', '/a/Renamed.json'], ['create', '/a/Renamed.json'], ['replace', '/a/Renamed.json', 'renamed']]]);
  });

  it('tells the caller the moves before VS Code applies, and does not undo when VS Code applies', async () => {
    const undo = vi.fn();
    const moving = vi.fn<(moves: readonly { from: { path: string }; to: { path: string } }[]) => () => void>(() => undo);

    await applyWorkspaceChanges([{ ...none, moves: [{ from: '/a/Npc.json', to: '/a/Renamed.json' }] }], { moving });

    expect(moving.mock.calls.map(([moves]) => moves.map(({ from, to }) => [from.path, to.path]))).toEqual([[['/a/Npc.json', '/a/Renamed.json']]]);
    expect(undo).not.toHaveBeenCalled();
  });

  it('undoes what the caller was told, and throws when VS Code applies nothing', async () => {
    const undo = vi.fn();
    h.applyLands = false;

    await expect(applyWorkspaceChanges([{ ...none, documents: [{ path: OWNER, text: 'x' }] }], { moving: () => undo }))
      .rejects.toThrow('VS Code did not apply');

    expect(undo).toHaveBeenCalledOnce();
  });

  it('changes a document through the Uri of the one the changes read', async () => {
    const read = fakeUri(OWNER);

    await applyWorkspaceChanges([{ ...none, documents: [{ path: OWNER, text: 'x' }] }], { read });

    expect(h.applied[0]).toEqual([['create', OWNER], ['replace', OWNER, 'x']]);
  });

  it('applies the edit as a refactoring and saves no document itself', async () => {
    await applyWorkspaceChanges([{ ...none, documents: [{ path: OWNER, text: 'x' }] }]);

    expect(h.options).toEqual([{ isRefactoring: true }]);
  });
});

describe('applying the changes of several items as one workspace edit', () => {
  it('deletes a file or folder recursively, in the order answered, and keeps only the last text of a document', async () => {
    await applyWorkspaceChanges([
      { ...none, documents: [{ path: OWNER, text: 'without the first' }] },
      { ...none, deletions: [FOLDER] },
      { ...none, documents: [{ path: OWNER, text: 'without both' }] },
    ]);

    expect(h.applied).toEqual([[
      ['delete', FOLDER, { recursive: true, ignoreIfNotExists: true }],
      ['create', OWNER],
      ['replace', OWNER, 'without both'],
    ]]);
  });

  it('writes no document a later item deletes', async () => {
    await applyWorkspaceChanges([
      { ...none, documents: [{ path: `${FOLDER}/Child.json`, text: 'cut' }, { path: OWNER, text: 'cut' }] },
      { ...none, deletions: [FOLDER] },
    ]);

    expect(h.applied).toEqual([[
      ['create', OWNER],
      ['replace', OWNER, 'cut'],
      ['delete', FOLDER, { recursive: true, ignoreIfNotExists: true }],
    ]]);
  });

  it('writes a document beside a deleted folder whose name only begins the same, on either separator', async () => {
    const sibling = `${FOLDER}2/Child.json`;
    const backslashed = 'C:\\mods\\Npc\\Child.json';

    await applyWorkspaceChanges([
      { ...none, documents: [{ path: sibling, text: 'stays' }, { path: backslashed, text: 'goes' }] },
      { ...none, deletions: [FOLDER, 'C:\\mods\\Npc'] },
    ]);

    expect(h.applied[0]?.filter((op) => Array.isArray(op) && op[0] === 'replace')).toEqual([['replace', sibling, 'stays']]);
  });

  it('writes a document under a folder an earlier item deleted', async () => {
    await applyWorkspaceChanges([
      { ...none, deletions: [FOLDER] },
      { ...none, documents: [{ path: `${FOLDER}/Child.json`, text: 'recreated' }] },
    ]);

    expect(h.applied[0]?.filter((op) => Array.isArray(op) && op[0] === 'replace')).toEqual([['replace', `${FOLDER}/Child.json`, 'recreated']]);
  });
});
