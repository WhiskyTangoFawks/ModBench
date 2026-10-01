import '@testing-library/jest-dom';
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('./vscode', () => ({ vscode: { postMessage: vi.fn() } }));

import { RecordPanel } from './RecordPanel';
import { vscode } from './vscode';
import {
  compareOverride, compareResultFixture, diffNode, fieldMeta, lastElementCommand, lastPostedEnvelope, member,
  panelClient, required,
} from './test/fixtures';

const levelMeta = fieldMeta({ name: 'Level', type: 'int' });
const nameMeta = fieldMeta({ name: 'Name', type: 'string' });
const valuesMeta = fieldMeta({
  name: 'Values', type: 'array', isArray: true, elementType: fieldMeta({ name: '', type: 'int' }),
});
const otherValuesMeta = fieldMeta({
  name: 'Others', type: 'array', isArray: true, elementType: fieldMeta({ name: '', type: 'int' }),
});

const record = compareResultFixture({
  conflictAll: 'Override',
  overrides: [
    compareOverride({
      formKey: '000001:Fallout4.esm', plugin: 'Fallout4.esm', origin: 'Data', isWinner: false, editorId: 'TestNPC',
      fields: [
        { metadata: levelMeta, value: 5 }, { metadata: nameMeta, value: 'Master' },
        { metadata: valuesMeta, value: [4, 6] }, { metadata: otherValuesMeta, value: [1] },
      ],
      conflictThis: 'Master',
    }),
    compareOverride({
      formKey: '000001:Fallout4.esm', plugin: 'MyMod.esp', origin: 'Data', isWinner: true, editorId: 'TestNPC',
      fields: [
        { metadata: levelMeta, value: 7 }, { metadata: valuesMeta, value: [4] }, { metadata: otherValuesMeta, value: [1] },
      ],
      conflictThis: 'Override',
    }),
  ],
  diffs: [
    diffNode({
      fieldName: 'Level', values: { 'Fallout4.esm': 5, 'MyMod.esp': 7 }, winnerColumn: 'MyMod.esp', cellStates: {},
    }),
    diffNode({
      fieldName: 'Name', values: { 'Fallout4.esm': 'Master', 'MyMod.esp': null }, winnerColumn: 'Fallout4.esm', cellStates: {},
    }),
    diffNode({
      fieldName: 'Values', values: { 'Fallout4.esm': [4, 6], 'MyMod.esp': [4] }, winnerColumn: 'MyMod.esp', cellStates: {},
      children: [
        diffNode({ fieldName: '[0]', values: { 'Fallout4.esm': 4, 'MyMod.esp': 4 }, winnerColumn: 'MyMod.esp', cellStates: {} }),
        diffNode({ fieldName: '[1]', values: { 'Fallout4.esm': 6, 'MyMod.esp': null }, winnerColumn: 'Fallout4.esm', cellStates: {} }),
      ],
    }),
    diffNode({
      fieldName: 'Others', values: { 'Fallout4.esm': [1], 'MyMod.esp': [1] }, winnerColumn: 'MyMod.esp', cellStates: {},
      children: [
        diffNode({ fieldName: '[0]', values: { 'Fallout4.esm': 1, 'MyMod.esp': 1 }, winnerColumn: 'MyMod.esp', cellStates: {} }),
      ],
    }),
  ],
});

const plugins = [
  { name: 'Fallout4.esm', isImmutable: true },
  { name: 'MyMod.esp', isTracked: true },
];

// Columns: the label is 0, Fallout4.esm 1, MyMod.esp 2.
const MASTER = 1;
const MOD = 2;

async function cellOf(rowLabel: string, column: number, occurrence = 0): Promise<HTMLElement> {
  await waitFor(() => screen.getAllByText(rowLabel, { exact: true }));
  const label = required(screen.getAllByText(rowLabel, { exact: true })[occurrence], `${rowLabel}'s label`);
  return required(required(label.closest('tr'), `${rowLabel}'s row`).querySelectorAll('td')[column], 'the cell');
}

const dataTransfer = () => ({ setData: vi.fn(), effectAllowed: '', dropEffect: '' });

function drag(from: HTMLElement, onto: HTMLElement) {
  fireEvent.dragStart(from, { dataTransfer: dataTransfer() });
  const refused = fireEvent.dragOver(onto, { dataTransfer: dataTransfer() });
  fireEvent.drop(onto, { dataTransfer: dataTransfer() });
  fireEvent.dragEnd(from, { dataTransfer: dataTransfer() });
  return { landed: !refused };
}

describe('RecordPanel — drag and drop', () => {
  beforeEach(() => {
    vi.stubGlobal('mEditFormKey', '000001:Fallout4.esm');
    vi.mocked(vscode.postMessage).mockClear();
    render(<RecordPanel client={panelClient(() => record, { plugins })} />);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('a cell dragged onto the same field in an editable column writes its value there', async () => {
    const { landed } = drag(await cellOf('Level', MASTER), await cellOf('Level', MOD));

    expect(landed).toBe(true);
    expect(lastPostedEnvelope(vscode.postMessage)).toEqual({ op: 'set', path: [member('Level')], value: 5 });
  });

  it('a cell dragged onto a column that cannot be edited changes nothing', async () => {
    const { landed } = drag(await cellOf('Level', MOD), await cellOf('Level', MASTER));

    expect(landed).toBe(false);
    expect(lastPostedEnvelope(vscode.postMessage)).toBeUndefined();
  });

  it('a cell dragged onto another field changes nothing', async () => {
    const { landed } = drag(await cellOf('Name', MASTER), await cellOf('Level', MOD));

    expect(landed).toBe(false);
    expect(lastPostedEnvelope(vscode.postMessage)).toBeUndefined();
  });

  it('a cell dragged onto a cell that already holds its value writes nothing', async () => {
    const { landed } = drag(await cellOf('[0]', MASTER), await cellOf('[0]', MOD));

    expect(landed).toBe(false);
    expect(lastPostedEnvelope(vscode.postMessage)).toBeUndefined();
  });

  it('a drop from outside the panel changes nothing', async () => {
    const onto = await cellOf('Level', MOD);
    const refused = fireEvent.dragOver(onto, { dataTransfer: dataTransfer() });
    fireEvent.drop(onto, { dataTransfer: dataTransfer() });

    expect(refused).toBe(true);
    expect(lastPostedEnvelope(vscode.postMessage)).toBeUndefined();
  });

  it('a drop after the drag has ended changes nothing', async () => {
    const from = await cellOf('Level', MASTER);
    fireEvent.dragStart(from, { dataTransfer: dataTransfer() });
    fireEvent.dragEnd(from, { dataTransfer: dataTransfer() });
    fireEvent.drop(await cellOf('Level', MOD), { dataTransfer: dataTransfer() });

    expect(lastPostedEnvelope(vscode.postMessage)).toBeUndefined();
  });

  it('an array row dragged onto the same array in another column writes the whole value', async () => {
    drag(await cellOf('Values', MASTER), await cellOf('Values', MOD));

    expect(lastPostedEnvelope(vscode.postMessage)).toEqual({ op: 'set', path: [member('Values')], value: [4, 6] });
  });

  it('an element dropped on its array row in another column is added to that array', async () => {
    drag(await cellOf('[1]', MASTER), await cellOf('Values', MOD));

    expect(lastElementCommand(vscode.postMessage)).toMatchObject({
      command: 'addElement', value: 6, context: { webviewSection: 'arrayParent', plugin: 'MyMod.esp' },
    });
  });

  // The column holds no element on that row, so there is no element there to write.
  it('an element dropped on its own row in a column that lacks it changes nothing', async () => {
    const { landed } = drag(await cellOf('[1]', MASTER), await cellOf('[1]', MOD));

    expect(landed).toBe(false);
    expect(lastPostedEnvelope(vscode.postMessage)).toBeUndefined();
  });

  it('an element dropped on another array row changes nothing', async () => {
    drag(await cellOf('[1]', MASTER), await cellOf('Others', MOD));

    expect(lastElementCommand(vscode.postMessage)).toBeUndefined();
  });

  it('an element dropped on an array row in a column that cannot be edited adds nothing', async () => {
    drag(await cellOf('[0]', MOD), await cellOf('Values', MASTER));

    expect(lastElementCommand(vscode.postMessage)).toBeUndefined();
  });

  it('a cell the plugin does not hold is not draggable', async () => {
    expect(await cellOf('Name', MOD)).toHaveAttribute('draggable', 'false');
  });

  it('a cell is draggable', async () => {
    expect(await cellOf('Level', MASTER)).toHaveAttribute('draggable', 'true');
  });
});
