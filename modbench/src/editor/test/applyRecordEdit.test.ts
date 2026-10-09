import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fakeUri, Range } from '../../test/vscodeMock';

const h = vi.hoisted(() => ({
  applied: [] as unknown[][],
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
    applyEdit: (edit: { made: unknown[] }) => { h.applied.push(edit.made); return Promise.resolve(h.applyLands); },
  },
}));

import { applyRecordEdit, type RecordWriteDeps } from '../applyRecordEdit';
import { oneAtATime } from '../../drivingLib/oneAtATime';
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
  h.applyLands = true;
});

describe('an edit of a record', () => {
  it('asks mEdit for the edit, which reads the documents it holds', async () => {
    const { deps, meditClient } = makeDeps({ applied: true, moves: [], deletions: [], documents: [] });

    await applyRecordEdit(deps, address, height);

    expect(meditClient.calls).toContainEqual({ method: 'getEditChanges', args: ['000800:A.esp', plugin, height] });
  });

  it('tells the panel host the moves and the new FormKey, refreshes Source Control, and resolves the new FormKey', async () => {
    const { deps, refreshSourceControlFor, moving } = makeDeps({
      applied: true, newFormKey: '000900:A.esp', moves: [{ from: FILE, to: MOVED }], deletions: [], documents: [{ path: MOVED, text: 'renamed' }],
    });

    const newFormKey = await applyRecordEdit(deps, address, height);

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

  it('reports an edit VS Code did not apply as one that may have partly landed, and refreshes Source Control', async () => {
    const { deps, reporter, refreshSourceControlFor } = makeDeps({
      applied: true, newFormKey: '000900:A.esp', moves: [{ from: FILE, to: MOVED }], deletions: [], documents: [{ path: MOVED, text: 'renamed' }],
    });
    h.applyLands = false;

    const newFormKey = await applyRecordEdit(deps, address, height);

    expect(newFormKey).toBeUndefined();
    expect(reporter.reports).toEqual([{
      severity: 'error', message: 'Could not edit Height.',
      detail: 'VS Code did not apply the changes. VS Code stops at the first change it cannot make, so some changes may have landed.',
    }]);
    expect(refreshSourceControlFor).toHaveBeenCalledWith(plugin);
  });

  it('reports a record with no document to edit, saying why', async () => {
    const { deps, meditClient, reporter } = makeDeps({ applied: true, moves: [], deletions: [], documents: [] });
    deps.documentOf = () => Promise.resolve({ refused: 'A.esp (ModA) holds no 000800:A.esp.' });

    await applyRecordEdit(deps, address, height);

    expect(reporter.reports).toEqual([{ severity: 'error', message: 'Could not edit Height.', detail: 'A.esp (ModA) holds no 000800:A.esp.' }]);
    expect(meditClient.calls.filter(c => c.method === 'getEditChanges')).toEqual([]);
  });
});
