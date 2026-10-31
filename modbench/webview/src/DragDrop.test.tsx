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

const carrying = (text: string) => ({ types: ['text/plain'], getData: () => text, setData: vi.fn(), effectAllowed: '', dropEffect: '' });

function dropText(text: string, onto: HTMLElement) {
  const refused = fireEvent.dragOver(onto, { dataTransfer: carrying(text) });
  fireEvent.drop(onto, { dataTransfer: carrying(text) });
  return { landed: !refused };
}

function drag(from: HTMLElement, onto: HTMLElement) {
  const started = carrying('');
  fireEvent.dragStart(from, { dataTransfer: started });
  const result = dropText(String(started.setData.mock.calls[0]?.[1]), onto);
  fireEvent.dragEnd(from, { dataTransfer: started });
  return result;
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

  it('a cell dragged onto another field is pasted there as text, as Ctrl+V pastes it', async () => {
    drag(await cellOf('Name', MASTER), await cellOf('Level', MOD));

    expect(lastPostedEnvelope(vscode.postMessage)).toEqual({ op: 'set', path: [member('Level')], value: 'Master' });
  });

  it('text dragged in from outside the panel is pasted on the cell it lands on', async () => {
    const { landed } = dropText('9', await cellOf('Level', MOD));

    expect(landed).toBe(true);
    expect(lastPostedEnvelope(vscode.postMessage)).toEqual({ op: 'set', path: [member('Level')], value: 9 });
  });

  it('a cell in a column that cannot be edited takes no drop', async () => {
    const { landed } = drag(await cellOf('Level', MOD), await cellOf('Level', MASTER));

    expect(landed).toBe(false);
    expect(lastPostedEnvelope(vscode.postMessage)).toBeUndefined();
  });

  it('a drag that carries no text lands nowhere', async () => {
    const onto = await cellOf('Level', MOD);
    const files = { types: ['Files'], getData: () => '', setData: vi.fn(), effectAllowed: '', dropEffect: '' };
    const refused = fireEvent.dragOver(onto, { dataTransfer: files });
    fireEvent.drop(onto, { dataTransfer: files });

    expect(refused).toBe(true);
    expect(lastPostedEnvelope(vscode.postMessage)).toBeUndefined();
  });

  it('an array row dragged onto the same array in another column writes the whole value', async () => {
    drag(await cellOf('Values', MASTER), await cellOf('Values', MOD));

    expect(lastPostedEnvelope(vscode.postMessage)).toEqual({ op: 'set', path: [member('Values')], value: [4, 6] });
  });

  it.each([
    ['in another column', 'Values'],
    ['of another array', 'Others'],
  ])('an element dropped on an array row %s is added to that array', async (_case, toRow) => {
    drag(await cellOf('[1]', MASTER), await cellOf(toRow, MOD));

    expect(lastAddElement(vscode.postMessage)).toMatchObject({
      value: 6, context: { webviewSection: 'arrayParent', plugin: 'MyMod.esp' },
    });
  });

  it('an element dropped on an array row in a column that cannot be edited adds nothing', async () => {
    drag(await cellOf('[0]', MOD), await cellOf('Values', MASTER));

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
