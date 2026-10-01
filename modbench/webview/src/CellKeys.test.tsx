import '@testing-library/jest-dom';
import React from 'react';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('./vscode', () => ({ vscode: { postMessage: vi.fn() } }));

import { RecordPanel } from './RecordPanel';
import { vscode } from './vscode';
import { WEBVIEW_TO_EXTENSION, EXTENSION_TO_WEBVIEW, type ExtensionToWebview } from './messages';
import {
  compareOverride, compareResultFixture, diffNode, fieldMeta, lastPostedEnvelope, member, panelClient, required,
} from './test/fixtures';

const levelMeta = fieldMeta({ name: 'Level', type: 'int' });
const femaleMeta = fieldMeta({ name: 'Female', type: 'bool' });
const nameMeta = fieldMeta({ name: 'Name', type: 'string' });
const valuesMeta = fieldMeta({
  name: 'Values', type: 'array', isArray: true, elementType: fieldMeta({ name: '', type: 'int' }),
});

const record = compareResultFixture({
  conflictAll: 'Override',
  overrides: [
    compareOverride({
      formKey: '000001:Fallout4.esm', plugin: 'Fallout4.esm', origin: 'Data', isWinner: false, editorId: 'TestNPC',
      fields: [{ metadata: levelMeta, value: 5 }, { metadata: femaleMeta, value: false }, { metadata: nameMeta, value: 'Master' }, { metadata: valuesMeta, value: [4, 5] }],
      conflictThis: 'Master',
    }),
    compareOverride({
      formKey: '000001:Fallout4.esm', plugin: 'MyMod.esp', origin: 'Data', isWinner: true, editorId: 'TestNPC',
      fields: [{ metadata: levelMeta, value: 7 }, { metadata: femaleMeta, value: false }, { metadata: valuesMeta, value: [4, 5] }],
      conflictThis: 'Override',
    }),
  ],
  diffs: [
    diffNode({
      fieldName: 'Level', values: { 'Fallout4.esm': 5, 'MyMod.esp': 7 }, winnerColumn: 'MyMod.esp',
      cellStates: { 'MyMod.esp': 'Override' },
    }),
    diffNode({
      fieldName: 'Female', values: { 'Fallout4.esm': false, 'MyMod.esp': false }, winnerColumn: 'MyMod.esp', cellStates: {},
    }),
    diffNode({
      fieldName: 'Name', values: { 'Fallout4.esm': 'Master', 'MyMod.esp': null }, winnerColumn: 'Fallout4.esm', cellStates: {},
    }),
    diffNode({
      fieldName: 'Values', values: { 'Fallout4.esm': [4, 5], 'MyMod.esp': [4, 5] }, winnerColumn: 'MyMod.esp', cellStates: {},
      children: [0, 1].map(index => diffNode({
        fieldName: `[${index}]`, values: { 'Fallout4.esm': 4 + index, 'MyMod.esp': 4 + index },
        indexes: { 'Fallout4.esm': index, 'MyMod.esp': index }, winnerColumn: 'MyMod.esp', cellStates: {},
      })),
    }),
  ],
});

const plugins = [
  { name: 'Fallout4.esm', isImmutable: true },
  { name: 'MyMod.esp', isTracked: true },
];

const posted = () => vi.mocked(vscode.postMessage).mock.calls.map(([m]) => m);

const toldContext = (): Record<string, unknown> | null | undefined => posted()
  .flatMap(m => (m.type === WEBVIEW_TO_EXTENSION.FOCUS_CELL ? [m.context] : []))
  .at(-1);

async function focusCell(rowLabel: string, column: number): Promise<HTMLElement> {
  await waitFor(() => screen.getByText(rowLabel));
  const row = required(screen.getByText(rowLabel).closest('tr'), `${rowLabel}'s row`);
  const cell = required(row.querySelectorAll('td')[column], `${rowLabel}'s cell ${column}`);
  fireEvent.click(cell);
  return cell;
}

const tellPanel = (message: ExtensionToWebview) => {
  act(() => { window.dispatchEvent(new MessageEvent('message', { data: message })); });
};
const pasteIntoCell = (text: string) => tellPanel({ type: EXTENSION_TO_WEBVIEW.PASTE_INTO_CELL, text });

beforeEach(() => {
  vi.stubGlobal('mEditFormKey', '000001:Fallout4.esm');
  vi.mocked(vscode.postMessage).mockClear();
  render(<RecordPanel client={panelClient(() => record, { plugins })} />);
});
afterEach(() => vi.unstubAllGlobals());

describe('RecordPanel — the grid keys are VS Code keybindings, not the panel\'s', () => {
  it.each([
    ['Delete', { key: 'Delete' }],
    ['Ctrl+X', { key: 'x', ctrlKey: true }],
    ['Ctrl+C', { key: 'c', ctrlKey: true }],
    ['F2', { key: 'F2' }],
    ['Alt+Up', { key: 'ArrowUp', altKey: true }],
    ['Alt+Down', { key: 'ArrowDown', altKey: true }],
  ])('%s pressed in the panel does nothing there', async (_key, keyEvent) => {
    for (const [row, column] of [['Level', 2], ['[0]', 2], ['[1]', 2]] as const) {
      const cell = await focusCell(row, column);
      vi.mocked(vscode.postMessage).mockClear();
      fireEvent.keyDown(cell, keyEvent);
      expect(posted().filter(m => m.type !== WEBVIEW_TO_EXTENSION.FOCUS_CELL)).toEqual([]);
      expect(screen.queryByRole('spinbutton')).toBeNull();
    }
  });

  it('a paste event in the panel writes nothing', async () => {
    const cell = await focusCell('Level', 2);
    fireEvent.paste(cell, { clipboardData: { getData: () => '12' } });
    expect(lastPostedEnvelope(vscode.postMessage)).toBeUndefined();
  });
});

describe('RecordPanel — what the focused cell tells the host its keys act on', () => {
  it('a cell in a column that can be edited names its plugin copy, its path, and that the plugin holds the field', async () => {
    await focusCell('Level', 2);
    await waitFor(() => expect(toldContext()).toMatchObject({
      formKey: '000001:Fallout4.esm', plugin: 'MyMod.esp', origin: 'Data', path: [member('Level')], holdsValue: true,
    }));
    expect(String(toldContext()?.webviewSection).split(' ')).toContain('editableCell');
  });

  it('a field the plugin does not hold is editable and holds no value', async () => {
    await focusCell('Name', 2);
    await waitFor(() => expect(toldContext()).toMatchObject({ plugin: 'MyMod.esp', holdsValue: false }));
  });

  it('a cell in a column that cannot be edited is not editable', async () => {
    await focusCell('Level', 1);
    await waitFor(() => expect(toldContext()).toMatchObject({ copyText: '5' }));
    expect(String(toldContext()?.webviewSection).split(' ')).not.toContain('editableCell');
  });

  it('says the editor is open from when it opens until Esc closes it', async () => {
    await focusCell('Level', 2);
    tellPanel({ type: EXTENSION_TO_WEBVIEW.OPEN_CELL_EDITOR });
    await waitFor(() => expect(toldContext()).toMatchObject({ editorOpen: true }));

    fireEvent.keyDown(screen.getByRole('spinbutton'), { key: 'Escape' });
    await waitFor(() => expect(toldContext()?.editorOpen).toBeUndefined());
  });

  it('says the editor is closed when the focus leaves the panel', async () => {
    await focusCell('Level', 2);
    tellPanel({ type: EXTENSION_TO_WEBVIEW.OPEN_CELL_EDITOR });
    await waitFor(() => expect(toldContext()).toMatchObject({ editorOpen: true }));

    fireEvent.blur(screen.getByRole('spinbutton'), { relatedTarget: null });
    await waitFor(() => expect(toldContext()?.editorOpen).toBeUndefined());
  });
});

describe('RecordPanel — the keys\' commands reaching the focused cell', () => {
  it('F2\'s opens the focused cell\'s editor', async () => {
    await focusCell('Level', 2);
    tellPanel({ type: EXTENSION_TO_WEBVIEW.OPEN_CELL_EDITOR });
    expect(screen.getByRole('spinbutton')).toHaveValue(7);
  });

  it('F2\'s opens nothing in a column that cannot be edited', async () => {
    await focusCell('Level', 1);
    tellPanel({ type: EXTENSION_TO_WEBVIEW.OPEN_CELL_EDITOR });
    expect(screen.queryByRole('spinbutton')).toBeNull();
  });

  it('Ctrl+V\'s writes a copied True as the boolean', async () => {
    await focusCell('Female', 2);
    pasteIntoCell('True');
    expect(lastPostedEnvelope(vscode.postMessage)).toEqual({ op: 'set', path: [member('Female')], value: true });
  });

  it('Ctrl+V\'s writes a number into an integer as the number', async () => {
    await focusCell('Level', 2);
    pasteIntoCell('12');
    expect(lastPostedEnvelope(vscode.postMessage)).toEqual({ op: 'set', path: [member('Level')], value: 12 });
  });

  it('Ctrl+V\'s writes a whole array copied from the field', async () => {
    await focusCell('Values', 2);
    pasteIntoCell('[4,6]');
    expect(lastPostedEnvelope(vscode.postMessage)).toEqual({ op: 'set', path: [member('Values')], value: [4, 6] });
  });

  it('Ctrl+V\'s writes text an integer cannot hold as the text, for mEdit to refuse', async () => {
    await focusCell('Level', 2);
    pasteIntoCell('twelve');
    expect(lastPostedEnvelope(vscode.postMessage)).toEqual({ op: 'set', path: [member('Level')], value: 'twelve' });
  });

  it('Ctrl+V\'s writes nothing into a column that cannot be edited', async () => {
    await focusCell('Level', 1);
    pasteIntoCell('12');
    expect(lastPostedEnvelope(vscode.postMessage)).toBeUndefined();
  });

  it('a pasted cell reads as the pasted value while the write waits for the disk', async () => {
    await focusCell('Level', 2);
    pasteIntoCell('12');
    const cell = required(screen.getByText('Level').closest('tr'), 'the Level row').querySelectorAll('td')[2];
    await waitFor(() => expect(cell).toHaveTextContent('12'));
  });
});
