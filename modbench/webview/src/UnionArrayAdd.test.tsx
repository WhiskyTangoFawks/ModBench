import '@testing-library/jest-dom';
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('./vscode', () => ({ vscode: { postMessage: vi.fn() } }));

import { RecordPanel } from './RecordPanel';
import { vscode } from './vscode';
import { fieldMeta, lastPostedEnvelope, panelClient } from './test/fixtures';

// Add on an abstract-union array: the webview contributes no element and no default. A
// reflected array's default element belongs to the backend's DocumentEdit, the only place that can
// name a leaf the codec will accept.

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

const aliasesCompareResult = {
  conflictAll: 'NoConflict',
  overrides: [
    {
      formKey: '000001:Quest548.esp', plugin: 'MyMod.esp', origin: 'Data',
      loadOrderIndex: 1, isWinner: true, editorId: 'Quest548',
      fields: [{ metadata: aliasesMeta, value: [{ MutagenObjectType: 'QuestLocationAlias', name: 'OriginalLoc' }] }],
      conflictThis: 'Master',
    },
  ],
  diffs: [{
    fieldName: 'aliases',
    values: { 'MyMod.esp': [{ MutagenObjectType: 'QuestLocationAlias', name: 'OriginalLoc' }] },
    winnerColumn: 'MyMod.esp',
    cellStates: {},
    children: [
      {
        fieldName: '[0]',
        values: { 'MyMod.esp': { MutagenObjectType: 'QuestLocationAlias', name: 'OriginalLoc' } },
        winnerColumn: 'MyMod.esp',
        cellStates: {},
      },
    ],
  }],
};

describe('RecordPanel — Add on an abstract-union array', () => {
  function renderPanel() {
    const client = panelClient(() => aliasesCompareResult, {
      plugins: [{ name: 'MyMod.esp', isTracked: true }],
    });
    return render(<RecordPanel client={client} />);
  }

  const lastEnvelope = () => lastPostedEnvelope(vscode.postMessage);

  beforeEach(() => {
    vi.stubGlobal('mEditFormKey', '000001:Quest548.esp');
    vi.mocked(vscode.postMessage).mockClear();
  });
  afterEach(() => vi.unstubAllGlobals());

  it('posts add at the array, carrying no element of its own', async () => {
    renderPanel();
    await waitFor(() => screen.getByText('aliases'));
    const cell = screen.getAllByText('[1]')[0]!.closest('td')!;
    fireEvent.click(cell); // focus
    fireEvent.keyDown(cell, { key: 'Insert' });

    expect(lastEnvelope()).toEqual({ op: 'add', path: [{ kind: 'member', name: 'aliases' }] });
    expect(Object.keys(lastEnvelope()!).sort()).toEqual(['op', 'path']);
  });
});
