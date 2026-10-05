import '@testing-library/jest-dom';
import React from 'react';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('./vscode', () => ({ vscode: { postMessage: vi.fn() } }));

import { RecordPanel } from './RecordPanel';
import { vscode } from './vscode';
import { EXTENSION_TO_WEBVIEW } from '../../src/wire/messages';
import { compareOverride, compareResultFixture, diffNode, fieldMeta, panelClient, required, tellPanel } from './test/fixtures';
import type { CompareResult } from './types';

const FORM_KEY = '000001:Fallout4.esm';
const nameMeta = fieldMeta({ name: 'Name', type: 'string' });
const formIdMeta = fieldMeta({ name: 'FormKey', type: 'string', displayLabel: 'FormID', isRecordHeaderMember: true, isRecordFormKey: true });
const formId = { metadata: formIdMeta, value: FORM_KEY };

function recordNamed(name: string): CompareResult {
  return compareResultFixture({
    overrides: [
      compareOverride({ formKey: FORM_KEY, plugin: 'Fallout4.esm', editorId: 'TestNPC', fields: [formId, { metadata: nameMeta, value: 'Original' }] }),
      compareOverride({ formKey: FORM_KEY, plugin: 'MyMod.esp', origin: 'ModA', isWinner: true, editorId: 'TestNPC', fields: [formId, { metadata: nameMeta, value: name }] }),
    ],
    diffs: [
      diffNode({ fieldName: 'FormKey', values: { 'Fallout4.esm': FORM_KEY, 'MyMod.esp|ModA': FORM_KEY } }),
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
