import '@testing-library/jest-dom';
import React from 'react';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('./vscode', () => ({ vscode: { postMessage: vi.fn() } }));

import { RecordPanel } from './RecordPanel';
import { vscode } from './vscode';
import { compareOverride, compareResultFixture, diffNode, fieldMeta, panelClient } from './test/fixtures';
import type { CompareResult } from './types';

const aliasesMeta = fieldMeta({
  name: 'aliases', type: 'array', isArray: true,
  elementType: fieldMeta({
    name: '', type: 'struct',
    fields: [
      fieldMeta({
        name: 'MutagenObjectType', type: 'enum',
        enumMembers: [
          { value: 'QuestReferenceAlias', label: 'Reference' },
          { value: 'QuestLocationAlias', label: 'Location' },
          { value: 'QuestCollectionAlias', label: 'Collection' }],
        displayLabel: 'Kind',
      }),
      fieldMeta({ name: 'name', type: 'string' }),
    ],
  }),
});

const aliasesCompareResult: CompareResult = compareResultFixture({
  conflictAll: 'NoConflict',
  overrides: [
    compareOverride({
      formKey: '000001:Quest548.esp', plugin: 'MyMod.esp', origin: 'Data',
      isWinner: true, editorId: 'Quest548',
      fields: [{ metadata: aliasesMeta, value: [{ MutagenObjectType: 'QuestLocationAlias', name: 'OriginalLoc' }] }],
      conflictThis: 'Master',
    }),
  ],
  diffs: [diffNode({
    fieldName: 'aliases',
    values: { 'MyMod.esp': [{ MutagenObjectType: 'QuestLocationAlias', name: 'OriginalLoc' }] },
    winnerColumn: 'MyMod.esp',
    cellStates: {},
    children: [
      diffNode({
        fieldName: '[0]',
        values: { 'MyMod.esp': { MutagenObjectType: 'QuestLocationAlias', name: 'OriginalLoc' } },
        winnerColumn: 'MyMod.esp',
        cellStates: {},
      }),
    ],
  })],
});

describe('RecordPanel — Add on an abstract-union array, whose default element only the backend\'s DocumentEdit can name', () => {
  function renderPanel() {
    const client = panelClient(() => aliasesCompareResult, {
      plugins: [{ name: 'MyMod.esp', isTracked: true }],
    });
    return render(<RecordPanel client={client} />);
  }

  beforeEach(() => {
    vi.stubGlobal('mEditFormKey', '000001:Quest548.esp');
    vi.mocked(vscode.postMessage).mockClear();
  });
  afterEach(() => vi.unstubAllGlobals());

  it('offers add at the array, as its menu does', async () => {
    renderPanel();
    await waitFor(() => screen.getByText('aliases'));
    const aliasesRow = screen.getByText('aliases').closest('tr');
    if (!aliasesRow) throw new Error('the row of the aliases array');
    fireEvent.click(within(aliasesRow).getByText('▼'));
    const cellText = screen.getAllByText('[1]')[0];
    if (!cellText) throw new Error('the "[1]" index label RecordPanel renders for the array element');
    const cell = cellText.closest('td');
    if (!cell) throw new Error('the table cell containing the "[1]" index label');

    const context: unknown = JSON.parse(cell.getAttribute('data-vscode-context') ?? '{}');
    expect(context).toMatchObject({ webviewSection: 'cell arrayParent editableCell', path: [{ kind: 'member', name: 'aliases' }] });
  });
});
