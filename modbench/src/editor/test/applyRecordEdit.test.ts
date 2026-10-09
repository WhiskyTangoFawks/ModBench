import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fakeUri, Range } from '../../test/vscodeMock';

const h = vi.hoisted(() => ({
  applied: [] as unknown[][],
  saved: [] as string[],
  savesLand: true,
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
    openTextDocument: (uri: { path: string }) => Promise.resolve({
      uri, isDirty: true, getText: () => `text of ${uri.path}`,
      save: () => { h.saved.push(uri.path); return Promise.resolve(h.savesLand); },
    }),
    applyEdit: (edit: { made: unknown[] }) => { h.applied.push(edit.made); return Promise.resolve(h.applyLands); },
  },
}));

import { applyRecordEdit, applySourceChanges, oneAtATime, type RecordWriteDeps } from '../applyRecordEdit';
import { InMemoryMEditClient } from '../../client/test/InMemoryMEditClient';
import { recordingReporter } from '../../test/surfacingDoubles';
import type { RecordEditEnvelope } from '../../wire/messages';

const FILE = '/mods/ModA/plugin-source/A.esp/Npcs/Npc.json';
const MOVED = '/mods/ModA/plugin-source/A.esp/Npcs/Renamed.json';
const plugin = { name: 'A.esp', origin: 'ModA' };
const address = { formKey: '000800:A.esp', plugin };
const height: RecordEditEnvelope = { op: 'set', path: [{ kind: 'member', name: 'Height' }], value: 0.75 };

function makeDeps(answer: Awaited<ReturnType<InMemoryMEditClient['getEditChanges']>>) {
  const meditClient = new InMemoryMEditClient();
  meditClient.setQueryAnswer('getEditChanges', answer);
  const reporter = recordingReporter();
  const refreshSourceControlFor = vi.fn();
  const moving = vi.fn<RecordWriteDeps['moving']>();
  const deps: RecordWriteDeps = {
    meditClient, reporter, refreshSourceControlFor, moving, oneAtATime: oneAtATime(),
    documentOf: () => Promise.resolve({ uri: fakeUri(FILE) }),
  };
  return { deps, meditClient, reporter, refreshSourceControlFor, moving };
}

beforeEach(() => {
  h.applied.length = 0;
  h.saved.length = 0;
  h.savesLand = true;
  h.applyLands = true;
});

describe('an edit of a record', () => {
  it('asks mEdit for the edit given the text of the document carrying the record', async () => {
    const { deps, meditClient } = makeDeps({ applied: true, moves: [], deletions: [], documents: [] });

    await applyRecordEdit(deps, address, height);

    expect(meditClient.calls).toContainEqual({ method: 'getEditChanges', args: ['000800:A.esp', plugin, height, `text of ${FILE}`] });
  });

  it('makes each move mEdit answers in order, then puts each document\'s text, saves each, and resolves the new FormKey', async () => {
    const { deps, refreshSourceControlFor, moving } = makeDeps({
      applied: true, newFormKey: '000900:A.esp', moves: [{ from: FILE, to: MOVED }], deletions: [], documents: [{ path: MOVED, text: 'renamed' }],
    });

    const newFormKey = await applyRecordEdit(deps, address, height);

    expect(h.applied).toEqual([[['move', FILE, MOVED], ['create', MOVED], ['replace', MOVED, 'renamed']]]);
    expect(h.saved).toEqual([MOVED]);
    expect(newFormKey).toBe('000900:A.esp');
    expect(moving.mock.calls.map(([moves, ...rest]) => [moves.map(({ from, to }) => [from.path, to.path]), ...rest])).toEqual([[[[FILE, MOVED]], address, '000900:A.esp']]);
    expect(refreshSourceControlFor).toHaveBeenCalledWith(plugin);
  });

  it('changes nothing and says nothing when mEdit answers no change', async () => {
    const { deps, reporter, refreshSourceControlFor } = makeDeps({ applied: true, moves: [], deletions: [], documents: [] });

    await applyRecordEdit(deps, address, height);

    expect(h.applied).toEqual([]);
    expect(reporter.reports).toEqual([]);
    expect(refreshSourceControlFor).not.toHaveBeenCalled();
  });

  it('changes no document when mEdit refuses, and says why as a warning naming the field as mEdit spells its path', async () => {
    const { deps, reporter, refreshSourceControlFor } = makeDeps({ applied: false, refusal: 'ReadOnly', message: 'Read-only.' });
    const nested: RecordEditEnvelope = {
      op: 'set', path: [{ kind: 'member', name: 'Conditions' }, { kind: 'index', index: 0 }, { kind: 'member', name: 'Data' }], value: 1,
    };

    await applyRecordEdit(deps, address, nested);

    expect(h.applied).toEqual([]);
    expect(reporter.reports).toEqual([{ severity: 'warning', message: 'Conditions[0].Data: Read-only.', detail: undefined }]);
    expect(refreshSourceControlFor).not.toHaveBeenCalled();
  });

  it('reports a transport failure as an error naming the field', async () => {
    const { deps, meditClient, reporter } = makeDeps({ applied: true, moves: [], deletions: [], documents: [] });
    meditClient.setQueryFailure('getEditChanges', new Error('ECONNREFUSED'));

    await applyRecordEdit(deps, address, height);

    expect(reporter.reports).toEqual([{ severity: 'error', message: 'Could not edit Height.', detail: 'ECONNREFUSED' }]);
  });

  it('reports a record with no document to edit, saying why', async () => {
    const { deps, meditClient, reporter } = makeDeps({ applied: true, moves: [], deletions: [], documents: [] });
    deps.documentOf = () => Promise.resolve({ refused: 'A.esp (ModA) holds no 000800:A.esp.' });

    await applyRecordEdit(deps, address, height);

    expect(reporter.reports).toEqual([{ severity: 'error', message: 'Could not edit Height.', detail: 'A.esp (ModA) holds no 000800:A.esp.' }]);
    expect(meditClient.calls.filter(c => c.method === 'getEditChanges')).toEqual([]);
  });

  it('reports a document VS Code did not save, so nothing is left unsaved in silence', async () => {
    const { deps, reporter, refreshSourceControlFor } = makeDeps({ applied: true, moves: [], deletions: [], documents: [{ path: FILE, text: 'edited' }] });
    h.savesLand = false;

    await applyRecordEdit(deps, address, height);

    expect(reporter.reports).toEqual([{ severity: 'error', message: 'Could not edit Height.', detail: `VS Code did not save ${FILE}.` }]);
    expect(refreshSourceControlFor).not.toHaveBeenCalled();
  });
});

describe('the changes of several records, made as one workspace edit', () => {
  const OWNER = '/mods/ModA/plugin-source/A.esp/Cells/Cell.json';
  const FOLDER = '/mods/ModA/plugin-source/A.esp/Npcs/Npc';
  const none = { moves: [], deletions: [], documents: [] };

  it('deletes a file or folder recursively, in the order answered, and keeps only the last text of a document', async () => {
    await applySourceChanges([
      { ...none, documents: [{ path: OWNER, text: 'without the first' }] },
      { ...none, deletions: [FOLDER] },
      { ...none, documents: [{ path: OWNER, text: 'without both' }] },
    ]);

    expect(h.applied).toEqual([[
      ['delete', FOLDER, { recursive: true, ignoreIfNotExists: true }],
      ['create', OWNER],
      ['replace', OWNER, 'without both'],
    ]]);
    expect(h.saved).toEqual([OWNER]);
  });

  it('writes no document a later item deletes, and saves only the documents that stay', async () => {
    await applySourceChanges([
      { ...none, documents: [{ path: `${FOLDER}/Child.json`, text: 'cut' }, { path: OWNER, text: 'cut' }] },
      { ...none, deletions: [FOLDER] },
    ]);

    expect(h.applied).toEqual([[
      ['create', OWNER],
      ['replace', OWNER, 'cut'],
      ['delete', FOLDER, { recursive: true, ignoreIfNotExists: true }],
    ]]);
    expect(h.saved).toEqual([OWNER]);
  });

  it('says VS Code did not apply them, and saves nothing', async () => {
    h.applyLands = false;

    await expect(applySourceChanges([{ ...none, deletions: [FOLDER] }])).rejects.toThrow('VS Code did not apply');
  });
});
