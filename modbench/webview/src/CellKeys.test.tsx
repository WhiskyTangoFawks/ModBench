import '@testing-library/jest-dom';
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('./vscode', () => ({ vscode: { postMessage: vi.fn() } }));

import { RecordPanel } from './RecordPanel';
import { vscode } from './vscode';
import { WEBVIEW_TO_EXTENSION, EXTENSION_TO_WEBVIEW } from './messages';
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
      fields: [{ metadata: levelMeta, value: 5 }, { metadata: femaleMeta, value: false }, { metadata: nameMeta, value: 'Master' }, { metadata: valuesMeta, value: [4] }],
      conflictThis: 'Master',
    }),
    compareOverride({
      formKey: '000001:Fallout4.esm', plugin: 'MyMod.esp', origin: 'Data', isWinner: true, editorId: 'TestNPC',
      fields: [{ metadata: levelMeta, value: 7 }, { metadata: femaleMeta, value: false }, { metadata: valuesMeta, value: [4] }],
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
      fieldName: 'Values', values: { 'Fallout4.esm': [4], 'MyMod.esp': [4] }, winnerColumn: 'MyMod.esp', cellStates: {},
      children: [diffNode({
        fieldName: '[0]', values: { 'Fallout4.esm': 4, 'MyMod.esp': 4 }, winnerColumn: 'MyMod.esp', cellStates: {},
      })],
    }),
  ],
});

const plugins = [
  { name: 'Fallout4.esm', isImmutable: true },
  { name: 'MyMod.esp', isTracked: true },
];

const elementCommands = () => vi.mocked(vscode.postMessage).mock.calls
  .map(([m]) => m).filter(m => m.type === WEBVIEW_TO_EXTENSION.ELEMENT_COMMAND);

const copied = () => vi.mocked(vscode.postMessage).mock.calls
  .map(([m]) => m).filter(m => m.type === WEBVIEW_TO_EXTENSION.COPY_VALUE);

async function focusCell(rowLabel: string, column: number): Promise<HTMLElement> {
  await waitFor(() => screen.getByText(rowLabel));
  const row = required(screen.getByText(rowLabel).closest('tr'), `${rowLabel}'s row`);
  const cell = required(row.querySelectorAll('td')[column], `${rowLabel}'s cell ${column}`);
  fireEvent.click(cell);
  return cell;
}

const paste = (cell: HTMLElement, text: string) =>
  fireEvent.paste(cell, { clipboardData: { getData: () => text } });

describe('RecordPanel — the keys on the focused cell, by its type', () => {
  beforeEach(() => {
    vi.stubGlobal('mEditFormKey', '000001:Fallout4.esm');
    vi.mocked(vscode.postMessage).mockClear();
    render(<RecordPanel client={panelClient(() => record, { plugins })} />);
  });
  afterEach(() => vi.unstubAllGlobals());

  // Columns: the label is 0, Fallout4.esm 1, MyMod.esp 2.
  it('Delete on a field that is not an element clears it', async () => {
    fireEvent.keyDown(await focusCell('Level', 2), { key: 'Delete' });

    expect(lastPostedEnvelope(vscode.postMessage)).toEqual({ op: 'set', path: [member('Level')], value: null });
  });

  it('Delete on a field the plugin does not hold changes nothing', async () => {
    fireEvent.keyDown(await focusCell('Name', 2), { key: 'Delete' });

    expect(lastPostedEnvelope(vscode.postMessage)).toBeUndefined();
  });

  it('Delete in a column that cannot be edited changes nothing', async () => {
    fireEvent.keyDown(await focusCell('Level', 1), { key: 'Delete' });

    expect(lastPostedEnvelope(vscode.postMessage)).toBeUndefined();
  });

  const focusElement = (column: number) => focusCell('[0]', column);

  it('Delete on an element removes it', async () => {
    fireEvent.keyDown(await focusElement(2), { key: 'Delete' });

    expect(elementCommands()).toMatchObject([{ command: 'removeElement' }]);
    expect(lastPostedEnvelope(vscode.postMessage)).toBeUndefined();
  });

  it('Delete on an element in a column that cannot be edited removes nothing', async () => {
    fireEvent.keyDown(await focusElement(1), { key: 'Delete' });

    expect(elementCommands()).toEqual([]);
  });

  it('Ctrl+X copies the value and then clears it', async () => {
    fireEvent.keyDown(await focusCell('Level', 2), { key: 'x', ctrlKey: true });

    expect(copied()).toEqual([{ type: WEBVIEW_TO_EXTENSION.COPY_VALUE, value: '7' }]);
    expect(lastPostedEnvelope(vscode.postMessage)).toEqual({ op: 'set', path: [member('Level')], value: null });
  });

  it('Ctrl+X in a column that cannot be edited copies nothing and changes nothing', async () => {
    fireEvent.keyDown(await focusCell('Level', 1), { key: 'x', ctrlKey: true });

    expect(copied()).toEqual([]);
    expect(lastPostedEnvelope(vscode.postMessage)).toBeUndefined();
  });

  it('Ctrl+V of a copied True writes the boolean', async () => {
    paste(await focusCell('Female', 2), 'True');

    expect(lastPostedEnvelope(vscode.postMessage)).toEqual({ op: 'set', path: [member('Female')], value: true });
  });

  it('Ctrl+V of a number into an integer writes the number', async () => {
    paste(await focusCell('Level', 2), '12');

    expect(lastPostedEnvelope(vscode.postMessage)).toEqual({ op: 'set', path: [member('Level')], value: 12 });
  });

  it('Ctrl+V into a column that cannot be edited changes nothing', async () => {
    const notPrevented = paste(await focusCell('Level', 1), '12');

    expect(lastPostedEnvelope(vscode.postMessage)).toBeUndefined();
    expect(notPrevented).toBe(true);
  });

  it('Ctrl+C on a label cell copies the field\'s name', async () => {
    fireEvent.keyDown(await focusCell('Level', 0), { key: 'c', ctrlKey: true });

    expect(copied()).toEqual([{ type: WEBVIEW_TO_EXTENSION.COPY_VALUE, value: 'Level' }]);
  });

  it('a cleared cell reads as the default while the write waits for the disk', async () => {
    fireEvent.keyDown(await focusCell('Level', 2), { key: 'Delete' });
    window.dispatchEvent(new MessageEvent('message', {
      data: {
        type: EXTENSION_TO_WEBVIEW.EDIT_WRITTEN, formKey: '000001:Fallout4.esm', plugin: 'MyMod.esp', origin: 'Data',
        envelope: { op: 'set', path: [member('Level')], value: null },
      },
    }));

    const cell = required(screen.getByText('Level').closest('tr'), 'the Level row').querySelectorAll('td')[2];
    await waitFor(() => expect(cell).toHaveTextContent('0'));
  });
});
