import '@testing-library/jest-dom';
import React from 'react';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('./vscode', () => ({ vscode: { postMessage: vi.fn() } }));

import { RecordPanel } from './RecordPanel';
import { vscode } from './vscode';
import { EXTENSION_TO_WEBVIEW } from '../../src/wire/messages';
import { compareOverride, compareResultFixture, diffNode, fieldMeta, panelClient, required, tellPanel } from './test/fixtures';
import { columnKey } from '../../src/wire/columnKey';
import { WEBVIEW_TO_EXTENSION } from '../../src/wire/messages';
import type { CompareResult } from './types';

const FORM_KEY = '000001:Fallout4.esm';
const nameMeta = fieldMeta({ name: 'Name', type: 'string' });
const formIdMeta = fieldMeta({ name: 'FormKey', type: 'string', displayLabel: 'FormID', isRecordHeaderMember: true, isRecordFormKey: true });

function recordNamed(name: string, formKey = FORM_KEY): CompareResult {
  const formId = { metadata: formIdMeta, value: formKey };
  return compareResultFixture({
    overrides: [
      compareOverride({ formKey, plugin: 'Fallout4.esm', editorId: 'TestNPC', fields: [formId, { metadata: nameMeta, value: 'Original' }] }),
      compareOverride({ formKey, plugin: 'MyMod.esp', origin: 'ModA', isWinner: true, editorId: 'TestNPC', fields: [formId, { metadata: nameMeta, value: name }] }),
    ],
    diffs: [
      diffNode({ fieldName: 'FormKey', values: { 'Fallout4.esm': formKey, 'MyMod.esp|ModA': formKey } }),
      diffNode({ fieldName: 'Name', values: { 'Fallout4.esm': 'Original', 'MyMod.esp|ModA': name } }),
    ],
  });
}

const plugins = [
  { name: 'Fallout4.esm', isImmutable: true },
  { name: 'MyMod.esp', origin: 'ModA', isTracked: true },
];

let disk = recordNamed('Before');

const nameCell = () => {
  const row = required(screen.getByText('Name').closest('tr'), 'the Name row');
  return required(row.querySelectorAll('td')[2], "MyMod.esp's Name cell");
};

beforeEach(() => {
  vi.stubGlobal('mEditFormKey', FORM_KEY);
  vi.mocked(vscode.postMessage).mockClear();
  disk = recordNamed('Before');
});

afterEach(() => { vi.unstubAllGlobals(); });

describe('a record panel cell after an edit (common.md, A gesture that writes, story 2)', () => {
  it('shows the read\'s value, whatever the edit wrote, until a read holds another', async () => {
    render(<RecordPanel client={panelClient(() => disk, { plugins })} />);
    await waitFor(() => screen.getByText('Before'));
    fireEvent.doubleClick(within(nameCell()).getByText('Before'));
    const input = required(nameCell().querySelector('input'), "the cell's input");
    fireEvent.change(input, { target: { value: 'After' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(nameCell()).toHaveTextContent('Before');
    expect(nameCell()).not.toHaveTextContent('After');

    disk = recordNamed('After');
    tellPanel({ type: EXTENSION_TO_WEBVIEW.LOAD_RECORD, formKey: FORM_KEY });
    await waitFor(() => expect(nameCell()).toHaveTextContent('After'));
  });
});

describe('a record panel cell after a refused edit (editor.md, Reporting, story 1)', () => {
  it('stays at the last read, since the host answers a refusal with a notification and no read', async () => {
    render(<RecordPanel client={panelClient(() => disk, { plugins })} />);
    await waitFor(() => screen.getByText('Before'));
    fireEvent.doubleClick(within(nameCell()).getByText('Before'));
    const input = required(nameCell().querySelector('input'), "the cell's input");
    fireEvent.change(input, { target: { value: 'Refused' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => expect(vscode.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: WEBVIEW_TO_EXTENSION.EDIT_FIELD })));
    expect(nameCell()).toHaveTextContent('Before');
    expect(nameCell()).not.toHaveTextContent('Refused');
  });
});

describe('a record panel reading the FormKey its record moved to (editor.md, States, story 5)', () => {
  const MOVED = '000002:Fallout4.esm';
  const answered = (result: CompareResult) => ({
    ok: true as const, result, immutableSet: new Set([columnKey({ name: 'Fallout4.esm', origin: 'Data/' })]),
    trackedSet: new Set([columnKey({ name: 'MyMod.esp', origin: 'ModA' })]),
    sourceUnreadableSet: new Set(), modsByOrigin: {}, conflictsComputed: true, loadFailures: [],
    fileColumn: columnKey({ name: 'MyMod.esp', origin: 'ModA' }),
  });
  const editedFormKeys = () => vi.mocked(vscode.postMessage).mock.calls
    .map(([m]) => m)
    .flatMap(m => (m.type === WEBVIEW_TO_EXTENSION.EDIT_FIELD ? [m.formKey] : []));

  it('names the record the grid shows, in its header and in an edit, until the read lands', async () => {
    let landMoved: (answer: ReturnType<typeof answered>) => void = () => undefined;
    const load = vi.fn()
      .mockResolvedValueOnce(answered(recordNamed('Before')))
      .mockReturnValueOnce(new Promise(resolve => { landMoved = resolve; }));
    render(<RecordPanel client={{ load, showColumns: vi.fn() }} />);
    await waitFor(() => screen.getByText('Before'));

    tellPanel({ type: EXTENSION_TO_WEBVIEW.LOAD_RECORD, formKey: MOVED });
    await waitFor(() => expect(load).toHaveBeenLastCalledWith(MOVED));
    expect(screen.getByText(`Non-Player Character TestNPC [${FORM_KEY}]`)).toBeInTheDocument();
    fireEvent.doubleClick(within(nameCell()).getByText('Before'));
    const input = required(nameCell().querySelector('input'), "the cell's input");
    fireEvent.change(input, { target: { value: 'After' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(editedFormKeys()).toEqual([FORM_KEY]);

    landMoved(answered(recordNamed('Moved', MOVED)));
    await waitFor(() => screen.getByText(`Non-Player Character TestNPC [${MOVED}]`));
  });
});
