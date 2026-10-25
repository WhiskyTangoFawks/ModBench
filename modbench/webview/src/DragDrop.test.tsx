import '@testing-library/jest-dom';
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('./vscode', () => ({ vscode: { postMessage: vi.fn() } }));

import { RecordPanel } from './RecordPanel';
import { vscode } from './vscode';
import {
  compareOverride, compareResultFixture, diffNode, fieldMeta, lastAddElement, lastPostedEnvelope, member,
  panelClient, required,
} from './test/fixtures';

const levelMeta = fieldMeta({ name: 'Level', type: 'int' });
const nameMeta = fieldMeta({ name: 'Name', type: 'string' });
const titleMeta = fieldMeta({ name: 'Title', type: 'translatedString' });
const title = { TargetLanguage: 'English', Value: 'Gun' };
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
      formKey: '000001:Fallout4.esm', plugin: 'Fallout4.esm', origin: 'Data/', isWinner: false, editorId: 'TestNPC',
      fields: [
        { metadata: levelMeta, value: 5 }, { metadata: nameMeta, value: 'Master' },
        { metadata: valuesMeta, value: [4, 6] }, { metadata: otherValuesMeta, value: [1] }, { metadata: titleMeta, value: title },
      ],
      conflictThis: 'Master',
    }),
    compareOverride({
      formKey: '000001:Fallout4.esm', plugin: 'MyMod.esp', origin: 'Data/', isWinner: true, editorId: 'TestNPC',
      fields: [
        { metadata: levelMeta, value: 7 }, { metadata: valuesMeta, value: [4] }, { metadata: otherValuesMeta, value: [1] },
        { metadata: titleMeta, value: title },
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
    diffNode({
      fieldName: 'Title', values: { 'Fallout4.esm': title, 'MyMod.esp': title }, winnerColumn: 'MyMod.esp', cellStates: {},
    }),
  ],
});

const plugins = [
  { name: 'Fallout4.esm', isImmutable: true },
  { name: 'MyMod.esp', isCompiledPlugin: true },
];

const LABEL_COLUMN = 0;
const MASTER = LABEL_COLUMN + 1;
const MOD = MASTER + 1;

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

  it.each([
    ['a cell dragged onto a column that cannot be edited', 'Level', MOD, 'Level', MASTER],
    ['a cell dragged onto another field', 'Name', MASTER, 'Level', MOD],
    ['a cell dragged onto a cell that already holds its value', '[0]', MASTER, '[0]', MOD],
    ['a translated text dragged onto a cell that already holds it', 'Title', MASTER, 'Title', MOD],
    ['an element dropped on its own row in a column that lacks it', '[1]', MASTER, '[1]', MOD],
  ])('%s lands nowhere and writes nothing', async (_case, fromRow, fromColumn, toRow, toColumn) => {
    const { landed } = drag(await cellOf(fromRow, fromColumn), await cellOf(toRow, toColumn));

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

    expect(lastAddElement(vscode.postMessage)).toMatchObject({
      value: 6, context: { webviewSection: 'arrayParent', plugin: 'MyMod.esp' },
    });
  });


  it.each([
    ['on another array row', '[1]', MASTER, 'Others', MOD],
    ['on an array row in a column that cannot be edited', '[0]', MOD, 'Values', MASTER],
  ])('an element dropped %s adds nothing', async (_case, fromRow, fromColumn, toRow, toColumn) => {
    drag(await cellOf(fromRow, fromColumn), await cellOf(toRow, toColumn));

    expect(lastAddElement(vscode.postMessage)).toBeUndefined();
  });

  it.each([
    ['a cell the plugin does not hold is not', 'Name', MOD, 'false'],
    ['a cell the plugin holds is', 'Level', MASTER, 'true'],
  ])('%s draggable', async (_case, row, column, draggable) => {
    expect(await cellOf(row, column)).toHaveAttribute('draggable', draggable);
  });
});

describe('RecordPanel — a drop on a compiled plugin column that is not the file\'s', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('changes nothing, as the file\'s column alone is edited', async () => {
    vi.stubGlobal('mEditFormKey', '000001:Fallout4.esm');
    vi.mocked(vscode.postMessage).mockClear();
    const bothCompiledPlugin = [{ name: 'Fallout4.esm', isCompiledPlugin: true }, { name: 'MyMod.esp', isCompiledPlugin: true }];
    render(<RecordPanel client={panelClient(() => record, { plugins: bothCompiledPlugin, fileColumn: 'MyMod.esp' })} />);

    const { landed } = drag(await cellOf('Level', MOD), await cellOf('Level', MASTER));

    expect(landed).toBe(false);
    expect(lastPostedEnvelope(vscode.postMessage)).toBeUndefined();
  });
});
