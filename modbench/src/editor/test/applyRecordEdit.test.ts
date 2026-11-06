import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Range, Uri } from '../../test/vscodeMock';

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
import { oneAtATime } from '../../textDocuments/oneAtATime';
import { InMemoryMEditClient } from '../../client/test/InMemoryMEditClient';
import { recordingReporter } from '../../test/surfacingDoubles';
import type { RecordEditEnvelope } from '../../wire/messages';

const FILE = '/source/ModA/plugin-source/A.esp/Npcs/Npc.json';
const MOVED = '/source/ModA/plugin-source/A.esp/Npcs/Renamed.json';
const plugin = { name: 'A.esp', origin: 'ModA' };
const address = { formKey: '000800:A.esp', plugin };
const height: RecordEditEnvelope = { op: 'set', path: [{ kind: 'member', name: 'Height' }], value: 0.75 };

function makeDeps(answer: Awaited<ReturnType<InMemoryMEditClient['getEditChanges']>>) {
  const meditClient = new InMemoryMEditClient();
  meditClient.setQueryAnswer('getEditChanges', answer);
  meditClient.setQueryAnswer('getFormKeyReferences', []);
  const reporter = recordingReporter();
  const refreshSourceControlFor = vi.fn();
  const moving = vi.fn<RecordWriteDeps['moving']>();
  const deps: RecordWriteDeps = {
    meditClient, reporter, refreshSourceControlFor, moving, oneAtATime: oneAtATime(),
    documentOf: () => Promise.resolve({ uri: Uri.file(FILE) }),
  };
  return { deps, meditClient, reporter, refreshSourceControlFor, moving };
}

beforeEach(() => {
  h.applied.length = 0;
  h.applyLands = true;
});

describe('an edit of a record', () => {
  it('asks mEdit for the edit, which reads the documents it holds', async () => {
    const { deps, meditClient } = makeDeps({ applied: true, leftBehind: [], moves: [], deletions: [], documents: [] });

    await applyRecordEdit(deps, address, height);

    expect(meditClient.calls).toContainEqual({ method: 'getEditChanges', args: ['000800:A.esp', plugin, height] });
  });

  it('tells the panel host the moves and the new FormKey, refreshes Source Control, and resolves the new FormKey', async () => {
    const { deps, refreshSourceControlFor, moving } = makeDeps({
      applied: true, newFormKey: '000900:A.esp', leftBehind: [], moves: [{ from: FILE, to: MOVED }], deletions: [], documents: [{ path: MOVED, text: 'renamed' }],
    });

    const newFormKey = await applyRecordEdit(deps, address, height);

    expect(newFormKey).toBe('000900:A.esp');
    expect(moving.mock.calls.map(([moves, ...rest]) => [moves.map(({ from, to }) => [from.path, to.path]), ...rest])).toEqual([[[[FILE, MOVED]], address, '000900:A.esp']]);
    expect(refreshSourceControlFor).toHaveBeenCalledWith(plugin);
  });

  it('changes nothing and says nothing when mEdit answers no change', async () => {
    const { deps, reporter, refreshSourceControlFor } = makeDeps({ applied: true, leftBehind: [], moves: [], deletions: [], documents: [] });

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

  it.each([
    ['an edit applied', { applied: true, leftBehind: [], moves: [], deletions: [], documents: [{ path: FILE, text: 'edited' }] }, 1],
    ['an edit that changes nothing', { applied: true, leftBehind: [], moves: [], deletions: [], documents: [] }, 1],
    ['an edit mEdit refuses', { applied: false, refusal: 'ReadOnly', message: 'Read-only.' }, 0],
  ] as [string, Awaited<ReturnType<InMemoryMEditClient['getEditChanges']>>, number][])('runs what follows only for %s', async (_what, answer, times) => {
    const { deps } = makeDeps(answer);
    const afterwards = vi.fn(() => Promise.resolve());

    await applyRecordEdit(deps, address, height, afterwards);

    expect(afterwards).toHaveBeenCalledTimes(times);
  });

  it('reports a failure after the edit landed as a failed copy, not a failed edit', async () => {
    const { deps, reporter } = makeDeps({
      applied: true, newFormKey: '000900:A.esp', leftBehind: [], moves: [], deletions: [], documents: [{ path: FILE, text: 'edited' }],
    });

    const newFormKey = await applyRecordEdit(deps, address, height, () => Promise.reject(new Error('clipboard busy')));

    expect(newFormKey).toBe('000900:A.esp');
    expect(reporter.reports).toEqual([{ severity: 'error', message: 'Could not copy Height.', detail: 'clipboard busy' }]);
  });

  it('reports an edit VS Code did not apply as one that may have partly landed, and refreshes Source Control', async () => {
    const { deps, reporter, refreshSourceControlFor } = makeDeps({
      applied: true, newFormKey: '000900:A.esp', leftBehind: [], moves: [{ from: FILE, to: MOVED }], deletions: [], documents: [{ path: MOVED, text: 'renamed' }],
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
    const { deps, meditClient, reporter } = makeDeps({ applied: true, leftBehind: [], moves: [], deletions: [], documents: [] });
    deps.documentOf = () => Promise.resolve({ refused: 'A.esp (ModA) holds no 000800:A.esp.' });

    await applyRecordEdit(deps, address, height);

    expect(reporter.reports).toEqual([{ severity: 'error', message: 'Could not edit Height.', detail: 'A.esp (ModA) holds no 000800:A.esp.' }]);
    expect(meditClient.calls.filter(c => c.method === 'getEditChanges')).toEqual([]);
  });
});

describe('a change of the FormKey', () => {
  const rekeyed = { applied: true as const, newFormKey: '000900:A.esp', moves: [], deletions: [], documents: [{ path: FILE, text: 'rekeyed' }] };
  const inSource = { name: 'B.esp', origin: 'ModB' };

  it('refreshes Source Control for each plugin whose source it carried, and warns naming each reference that could not follow', async () => {
    const { deps, meditClient, reporter, refreshSourceControlFor } = makeDeps({ ...rekeyed, leftBehind: [{ plugin: { name: 'D.esp', origin: 'ModD' }, reason: 'unreadable' }] });
    meditClient.setQueryAnswer('getFormKeyReferences', [
      { formKey: '000801:B.esp', plugin: inSource, inPluginSource: true },
      { formKey: '000802:C.esp', plugin: { name: 'C.esp', origin: 'ModC' }, inPluginSource: false },
    ]);

    await applyRecordEdit(deps, address, height);

    expect(meditClient.calls).toContainEqual({ method: 'getFormKeyReferences', args: ['000800:A.esp'] });
    expect(refreshSourceControlFor.mock.calls).toEqual([[plugin], [inSource]]);
    expect(reporter.reports).toEqual([{
      severity: 'warning', message: 'Changed 000800:A.esp to 000900:A.esp. 2 references to it could not follow.',
      detail: '000802:C.esp in C.esp (ModC)\nD.esp (ModD): unreadable',
    }]);
  });

  it('names the plugins mEdit reads as left behind when it cannot say which reference the record', async () => {
    const { deps, meditClient, reporter } = makeDeps({ ...rekeyed, leftBehind: [] });
    meditClient.setQueryFailure('getFormKeyReferences', { failed: 'unreachable' });

    await applyRecordEdit(deps, address, height);

    expect(reporter.reports).toEqual([{
      severity: 'warning', message: 'Changed 000800:A.esp to 000900:A.esp. 1 references to it could not follow.',
      detail: 'the plugins mEdit reads: mEdit could not be reached.',
    }]);
  });
});
