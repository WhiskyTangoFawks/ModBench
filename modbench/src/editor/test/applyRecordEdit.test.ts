import { describe, it, expect, vi, beforeEach } from 'vitest';
import { applyEdit, clipboard, commandHandlers, editorVscode } from './editorVscode';

vi.mock('vscode', () => editorVscode);

import type { RecordEditChangesOutcome } from '../../client';
import { InMemoryMEditClient } from '../../client/test/InMemoryMEditClient';
import { changeNamesPlugin } from '../../client/test/says';
import { recordingReporter } from '../../test/surfacingDoubles';
import { oneAtATime } from '../../textDocuments/oneAtATime';
import { WEBVIEW_TO_EXTENSION, type RecordEditEnvelope } from '../../wire/messages';
import { editAnswered, editorOver, forgetEditor } from './editorHarness';

const FILE = '/source/ModA/plugin-source/A.esp/Npcs/Npc.json';
const MOVED = '/source/ModA/plugin-source/A.esp/Npcs/Renamed.json';
const plugin = { name: 'A.esp', origin: 'ModA' };
const address = { formKey: '000800:A.esp', plugin };
const height: RecordEditEnvelope = { op: 'set', path: [{ kind: 'member', name: 'Height' }], value: 0.75 };
const identity = { formKey: address.formKey, plugin: plugin.name, origin: plugin.origin };

beforeEach(forgetEditor);

function makeDeps(answer: RecordEditChangesOutcome) {
  const meditClient = new InMemoryMEditClient();
  meditClient.setQueryAnswer('getEditChanges', answer);
  meditClient.setQueryAnswer('getCopyDocument', { kind: 'OwnFile', location: FILE });
  meditClient.setQueryAnswer('getComparison', null);
  const reporter = recordingReporter();
  const refreshSourceControlFor = vi.fn();
  const { open } = editorOver({
    meditClient, reporterOf: reporter,
    sourceEditing: { applyWorkspaceChanges: () => Promise.resolve(), oneAtATime: oneAtATime(), refreshSourceControlFor },
  });
  const edit = async (envelope: RecordEditEnvelope) => { await commandHandlers.get('modbench.record.editField')?.(identity, envelope); };
  const cut = async () => {
    open(address.formKey).receive({
      type: WEBVIEW_TO_EXTENSION.FOCUS_CELL, entered: true,
      context: { webviewSection: 'cell editableCell', copyText: '7', ...identity, path: height.path, holdsValue: true },
    });
    await commandHandlers.get('modbench.record.cut')?.();
  };
  const madeEdits = () => applyEdit.mock.calls.map(([made]) => made.made);
  return { meditClient, reporter, refreshSourceControlFor, open, edit, cut, madeEdits };
}

const applied = (changes: Parameters<typeof editAnswered>[0] = {}) => editAnswered({ plugins: [plugin], ...changes });

describe('an edit of a record', () => {
  it('asks mEdit for the edit, which reads the documents it holds', async () => {
    const { meditClient, edit } = makeDeps(applied());

    await edit(height);

    expect(meditClient.calls).toContainEqual({ method: 'getEditChanges', args: ['000800:A.esp', plugin, height] });
  });

  it('tells the panel host the moves and the new FormKey, refreshes Source Control, and resolves the new FormKey', async () => {
    const { meditClient, refreshSourceControlFor, open, edit } = makeDeps(applied({
      newFormKey: '000900:A.esp', moves: [{ from: FILE, to: MOVED }], documents: [{ path: MOVED, text: 'renamed' }],
    }));
    const tab = open(address.formKey);

    await edit(height);
    changeNamesPlugin(meditClient, plugin, ['000900:A.esp']);

    expect(tab.webview.postMessage.mock.calls).toEqual([[{ type: 'loadRecord', formKey: '000900:A.esp' }]]);
    expect(refreshSourceControlFor).toHaveBeenCalledWith(plugin);
  });

  it('changes nothing and says nothing when mEdit answers no change', async () => {
    const { reporter, refreshSourceControlFor, edit, madeEdits } = makeDeps(applied());

    await edit(height);

    expect(madeEdits()).toEqual([]);
    expect(reporter.reports).toEqual([]);
    expect(refreshSourceControlFor).not.toHaveBeenCalled();
  });

  it('changes no document when mEdit refuses, and says why as a warning naming the field as mEdit spells its path', async () => {
    const { reporter, refreshSourceControlFor, edit, madeEdits } = makeDeps({ applied: false, refusal: 'ReadOnly', message: 'Read-only.' });
    const nested: RecordEditEnvelope = {
      op: 'set', path: [{ kind: 'member', name: 'Conditions' }, { kind: 'index', index: 0 }, { kind: 'member', name: 'Data' }], value: 1,
    };

    await edit(nested);

    expect(madeEdits()).toEqual([]);
    expect(reporter.reports).toEqual([{ severity: 'warning', message: 'Conditions[0].Data: Read-only.', detail: undefined }]);
    expect(refreshSourceControlFor).not.toHaveBeenCalled();
  });

  it.each([
    ['an edit applied', applied({ documents: [{ path: FILE, text: 'edited' }] }), [['7']]],
    ['an edit that changes nothing', applied(), [['7']]],
    ['an edit mEdit refuses', { applied: false, refusal: 'ReadOnly', message: 'Read-only.' }, []],
  ] as [string, RecordEditChangesOutcome, string[][]][])('runs what follows only for %s', async (_what, answer, copied) => {
    const { cut } = makeDeps(answer);
    clipboard.writeText.mockResolvedValue(undefined);

    await cut();

    expect(clipboard.writeText.mock.calls).toEqual(copied);
  });

  it('reports a failure after the edit landed as a failed copy, not a failed edit', async () => {
    const { reporter, cut } = makeDeps(applied({ newFormKey: '000900:A.esp', documents: [{ path: FILE, text: 'edited' }] }));
    clipboard.writeText.mockRejectedValue(new Error('clipboard busy'));

    await cut();

    expect(reporter.reports).toEqual([{ severity: 'error', message: 'Could not copy Height.', detail: 'clipboard busy' }]);
  });

  it('reports an edit VS Code did not apply as one that may have partly landed, and refreshes Source Control', async () => {
    const { meditClient, reporter, refreshSourceControlFor, open, edit } = makeDeps(applied({
      newFormKey: '000900:A.esp', moves: [{ from: FILE, to: MOVED }], documents: [{ path: MOVED, text: 'renamed' }],
    }));
    applyEdit.mockResolvedValue(false);
    const tab = open(address.formKey);

    await edit(height);
    changeNamesPlugin(meditClient, plugin, ['000900:A.esp']);

    expect(tab.webview.postMessage).not.toHaveBeenCalled();
    expect(reporter.reports).toEqual([{
      severity: 'error', message: 'Could not edit Height.',
      detail: 'VS Code did not apply the changes. VS Code stops at the first change it cannot make, so some changes may have landed.',
    }]);
    expect(refreshSourceControlFor).toHaveBeenCalledWith(plugin);
  });

  it('reports a record with no document to edit, saying why', async () => {
    const { meditClient, reporter, edit } = makeDeps(applied());
    meditClient.setQueryAnswer('getCopyDocument', null);

    await edit(height);

    expect(reporter.reports).toEqual([{ severity: 'error', message: 'Could not edit Height.', detail: 'A.esp (ModA) holds no 000800:A.esp.' }]);
    expect(meditClient.calls.filter(c => c.method === 'getEditChanges')).toEqual([]);
  });
});

describe('a change of the FormKey', () => {
  const rekeyed = { newFormKey: '000900:A.esp', documents: [{ path: FILE, text: 'rekeyed' }] };
  const inSource = { name: 'B.esp', origin: 'ModB' };

  it('refreshes Source Control for each plugin mEdit says it changed, and warns naming each reference left behind', async () => {
    const { reporter, refreshSourceControlFor, edit } = makeDeps(applied({
      ...rekeyed, plugins: [plugin, inSource],
      leftBehind: [{ plugin: { name: 'D.esp', origin: 'ModD' }, reason: 'unreadable' }],
      copiesLeftBehind: [{ formKey: '000802:C.esp', plugin: { name: 'C.esp', origin: 'ModC' } }], copiesUnread: 'The record index is not ready.',
    }));

    await edit(height);

    expect(refreshSourceControlFor.mock.calls).toEqual([[plugin], [inSource]]);
    expect(reporter.reports).toEqual([{
      severity: 'warning', message: 'Renamed 000800:A.esp to "000900:A.esp". 3 references to it could not follow.',
      detail: '000802:C.esp in C.esp (ModC)\nD.esp (ModD): unreadable\nthe plugins mEdit reads: The record index is not ready.',
    }]);
  });

  it('says nothing when every reference followed', async () => {
    const { reporter, edit } = makeDeps(applied(rekeyed));

    await edit(height);

    expect(reporter.reports).toEqual([]);
  });
});
