import '@testing-library/jest-dom';
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('./vscode', () => ({ vscode: { postMessage: vi.fn() } }));

import { RecordPanel } from './RecordPanel';
import type { FieldMetadata } from './types';
import { columnKey } from './types';
import type { LoadResult, RecordPanelClient } from './RecordPanelClient';
import { vscode } from './vscode';
import { WEBVIEW_TO_EXTENSION } from './messages';

// Add on an abstract-union array: the webview contributes no element and no default. A
// reflected array's default element belongs to ArrayOpWriter, the only place that can name a
// leaf the write path will accept.

const aliasesMeta: FieldMetadata = {
  name: 'aliases', type: 'array', isArray: true, validFormKeyTypes: [], enumMembers: [],
  elementType: {
    name: '', type: 'struct', isArray: false, validFormKeyTypes: [], enumMembers: [],
    fields: [
      {
        name: 'concrete_type', type: 'enum', isArray: false, validFormKeyTypes: [],
        enumMembers: [
          { value: 'QuestReferenceAlias', label: 'Reference' },
          { value: 'QuestLocationAlias', label: 'Location' },
          { value: 'QuestCollectionAlias', label: 'Collection' }],
        displayLabel: 'Kind',
      },
      { name: 'name', type: 'string', isArray: false, validFormKeyTypes: [], enumMembers: [] },
    ],
  },
};

const aliasesCompareResult = {
  conflictAll: 'NoConflict',
  overrides: [
    {
      formKey: '000001:Quest548.esp', plugin: 'MyMod.esp', origin: 'Data',
      loadOrderIndex: 1, isWinner: true, editorId: 'Quest548',
      fields: [{ metadata: aliasesMeta, value: [{ concrete_type: 'QuestLocationAlias', name: 'OriginalLoc' }] }],
      conflictThis: 'Master',
    },
  ],
  diffs: [{
    fieldName: 'aliases',
    values: { 'MyMod.esp': [{ concrete_type: 'QuestLocationAlias', name: 'OriginalLoc' }] },
    winnerColumn: 'MyMod.esp',
    winnerValue: [{ concrete_type: 'QuestLocationAlias', name: 'OriginalLoc' }],
    cellStates: {},
    children: [
      {
        fieldName: '[0]',
        values: { 'MyMod.esp': { concrete_type: 'QuestLocationAlias', name: 'OriginalLoc' } },
        winnerColumn: 'MyMod.esp',
        winnerValue: { concrete_type: 'QuestLocationAlias', name: 'OriginalLoc' },
        cellStates: {},
      },
    ],
  }],
};

describe('RecordPanel — Add on an abstract-union array', () => {
  function renderPanel() {
    const client: RecordPanelClient = {
      load: vi.fn().mockImplementation(() => Promise.resolve({
        ok: true,
        result: aliasesCompareResult,
        immutableSet: new Set(),
        notInLoadOrderSet: new Set(),
        trackedSet: new Set([columnKey('MyMod.esp', null)]),
        conflictsComputed: true,
      } as unknown as LoadResult)),
    };
    return render(<RecordPanel client={client} />);
  }

  function lastEditField(): { fieldPath?: string; value?: unknown } | undefined {
    const calls = (vscode.postMessage as ReturnType<typeof vi.fn>).mock.calls;
    const call = [...calls].reverse().find(([m]) => (m as { type?: string }).type === WEBVIEW_TO_EXTENSION.EDIT_FIELD);
    return call?.[0] as { fieldPath?: string; value?: unknown } | undefined;
  }

  beforeEach(() => {
    vi.stubGlobal('mEditFormKey', '000001:Quest548.esp');
    (vscode.postMessage as ReturnType<typeof vi.fn>).mockClear();
  });
  afterEach(() => vi.unstubAllGlobals());

  it('posts the bare array_add envelope, carrying no element of its own', async () => {
    renderPanel();
    await waitFor(() => screen.getByText('aliases'));
    const cell = screen.getAllByText('[1]')[0].closest('td')!;
    fireEvent.click(cell); // focus
    fireEvent.keyDown(cell, { key: 'Insert' });

    expect(lastEditField()?.fieldPath).toBe('aliases');
    expect(lastEditField()?.value).toEqual({ op: 'array_add', path: [] });
    expect(Object.keys(lastEditField()?.value as object).sort()).toEqual(['op', 'path']);
  });
});
