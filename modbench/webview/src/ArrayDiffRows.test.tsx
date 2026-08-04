import '@testing-library/jest-dom';
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('./vscode', () => ({ vscode: { postMessage: vi.fn() } }));

import { RecordPanel } from './RecordPanel';
import { vscode } from './vscode';
import { WEBVIEW_TO_EXTENSION, EXTENSION_TO_WEBVIEW } from './messages';
import type { FieldMetadata } from './types';
import type { LoadResult, RecordSessionClient } from './RecordSessionClient';

// ── Metadata fixtures ─────────────────────────────────────────────────────────

const sortedArrayMeta: FieldMetadata = {
  name: 'Keywords',
  type: 'array',
  isArray: true,
  validFormKeyTypes: [],
  enumValues: [],
  elementType: {
    name: '',
    type: 'formKey',
    isArray: false,
    validFormKeyTypes: [],
    enumValues: [],
    isSortable: true,
  },
};

const unsortedArrayMeta: FieldMetadata = {
  name: 'Items',
  type: 'array',
  isArray: true,
  validFormKeyTypes: [],
  enumValues: [],
  elementType: {
    name: '',
    type: 'string',
    isArray: false,
    validFormKeyTypes: [],
    enumValues: [],
    isSortable: false,
  },
};

const pluginsResponse = [
  { name: 'Fallout4.esm', isImmutable: true,  loadOrderIndex: 0 },
  { name: 'MyMod.esp',    isImmutable: false, loadOrderIndex: 1 },
];

// ── Sorted array diff fixture ─────────────────────────────────────────────────
// Plugin A: [KwdA, KwdB], Plugin B: [KwdA, KwdC] → 3 children

const sortedArrayCompareResult = {
  conflictAll: 'Override',
  overrides: [
    {
      formKey: '000001:Fallout4.esm', plugin: 'Fallout4.esm',
      loadOrderIndex: 0, isWinner: false, editorId: 'TestNPC',
      fields: [{ metadata: sortedArrayMeta, value: ['KwdA', 'KwdB'] }],
      pendingFields: {}, conflictThis: 'Master',
    },
    {
      formKey: '000001:Fallout4.esm', plugin: 'MyMod.esp',
      loadOrderIndex: 1, isWinner: true, editorId: 'TestNPC',
      fields: [{ metadata: sortedArrayMeta, value: ['KwdA', 'KwdC'] }],
      pendingFields: {}, conflictThis: 'Override',
    },
  ],
  diffs: [{
    fieldName: 'Keywords',
    values: { 'Fallout4.esm': ['KwdA', 'KwdB'], 'MyMod.esp': ['KwdA', 'KwdC'] },
    winnerPlugin: 'MyMod.esp',
    winnerValue: ['KwdA', 'KwdC'],
    cellStates: { 'MyMod.esp': 'Override' },
    children: [
      {
        fieldName: 'KwdA',
        values: { 'Fallout4.esm': 'KwdA', 'MyMod.esp': 'KwdA' },
        winnerPlugin: 'Fallout4.esm', winnerValue: 'KwdA',
        cellStates: { 'MyMod.esp': 'IdenticalToMaster' },
      },
      {
        fieldName: 'KwdB',
        values: { 'Fallout4.esm': 'KwdB', 'MyMod.esp': null },
        winnerPlugin: 'Fallout4.esm', winnerValue: 'KwdB',
        cellStates: {},
      },
      {
        fieldName: 'KwdC',
        values: { 'Fallout4.esm': null, 'MyMod.esp': 'KwdC' },
        winnerPlugin: 'MyMod.esp', winnerValue: 'KwdC',
        cellStates: { 'MyMod.esp': 'Override' },
      },
    ],
  }],
};

// ── Unsorted array diff fixture with pending change ───────────────────────────
// Disk: A=['alpha','beta'], B=['alpha','gamma']. Pending B → ['alpha','delta']

const unsortedArrayWithPendingResult = {
  conflictAll: 'Conflict',
  overrides: [
    {
      formKey: '000001:Fallout4.esm', plugin: 'Fallout4.esm',
      loadOrderIndex: 0, isWinner: false, editorId: 'TestNPC',
      fields: [{ metadata: unsortedArrayMeta, value: ['alpha', 'beta'] }],
      pendingFields: {}, conflictThis: 'Master',
    },
    {
      formKey: '000001:Fallout4.esm', plugin: 'MyMod.esp',
      loadOrderIndex: 1, isWinner: true, editorId: 'TestNPC',
      fields: [{ metadata: unsortedArrayMeta, value: ['alpha', 'gamma'] }],
      // Pending: agent changed element [1] from 'gamma' to 'delta'
      pendingFields: { Items: ['alpha', 'delta'] },
      conflictThis: 'ConflictWins',
    },
  ],
  diffs: [{
    fieldName: 'Items',
    values: { 'Fallout4.esm': ['alpha', 'beta'], 'MyMod.esp': ['alpha', 'gamma'] },
    winnerPlugin: 'MyMod.esp', winnerValue: ['alpha', 'gamma'],
    cellStates: { 'MyMod.esp': 'ConflictWins' },
    children: [
      {
        fieldName: '[0]',
        values: { 'Fallout4.esm': 'alpha', 'MyMod.esp': 'alpha' },
        winnerPlugin: 'Fallout4.esm', winnerValue: 'alpha',
        cellStates: { 'MyMod.esp': 'IdenticalToMaster' },
      },
      {
        fieldName: '[1]',
        values: { 'Fallout4.esm': 'beta', 'MyMod.esp': 'gamma' },
        winnerPlugin: 'MyMod.esp', winnerValue: 'gamma',
        cellStates: { 'MyMod.esp': 'ConflictWins' },
      },
    ],
  }],
};

const pendingChange = {
  id: 'change-1', formKey: '000001:Fallout4.esm', plugin: 'MyMod.esp',
  fieldPath: 'Items', recordType: 'Npc', oldValue: ['alpha', 'gamma'],
  newValue: ['alpha', 'delta'], source: 'agent', description: null,
  changedAt: '2026-06-20T12:00:00Z',
};

// ── Unsorted array fixture for arity/order controls (#142) ────────────────────
// Both plugins carry the same 3-element array, no pending. Fallout4.esm stays
// immutable (per pluginsResponse) so the same fixture covers the immutable-column
// gating slice too.

const unsortedArrayControlsResult = {
  conflictAll: 'NoConflict',
  overrides: [
    {
      formKey: '000001:Fallout4.esm', plugin: 'Fallout4.esm',
      loadOrderIndex: 0, isWinner: false, editorId: 'TestNPC',
      fields: [{ metadata: unsortedArrayMeta, value: ['alpha', 'beta', 'gamma'] }],
      pendingFields: {}, conflictThis: 'Master',
    },
    {
      formKey: '000001:Fallout4.esm', plugin: 'MyMod.esp',
      loadOrderIndex: 1, isWinner: true, editorId: 'TestNPC',
      fields: [{ metadata: unsortedArrayMeta, value: ['alpha', 'beta', 'gamma'] }],
      pendingFields: {}, conflictThis: 'IdenticalToMaster',
    },
  ],
  diffs: [{
    fieldName: 'Items',
    values: { 'Fallout4.esm': ['alpha', 'beta', 'gamma'], 'MyMod.esp': ['alpha', 'beta', 'gamma'] },
    winnerPlugin: 'Fallout4.esm', winnerValue: ['alpha', 'beta', 'gamma'],
    cellStates: {},
    children: [
      {
        fieldName: '[0]',
        values: { 'Fallout4.esm': 'alpha', 'MyMod.esp': 'alpha' },
        winnerPlugin: 'Fallout4.esm', winnerValue: 'alpha',
        cellStates: {},
      },
      {
        fieldName: '[1]',
        values: { 'Fallout4.esm': 'beta', 'MyMod.esp': 'beta' },
        winnerPlugin: 'Fallout4.esm', winnerValue: 'beta',
        cellStates: {},
      },
      {
        fieldName: '[2]',
        values: { 'Fallout4.esm': 'gamma', 'MyMod.esp': 'gamma' },
        winnerPlugin: 'Fallout4.esm', winnerValue: 'gamma',
        cellStates: {},
      },
    ],
  }],
};

// ── Struct sub-field fixtures ─────────────────────────────────────────────────

const structMeta: FieldMetadata = {
  name: 'ObjectBounds',
  type: 'struct',
  isArray: false,
  validFormKeyTypes: [],
  enumValues: [],
  fields: [
    { name: 'X1', type: 'int', isArray: false, validFormKeyTypes: [], enumValues: [] },
    { name: 'X2', type: 'int', isArray: false, validFormKeyTypes: [], enumValues: [] },
  ],
};

// Disk: both plugins have { X1: 0, X2: 100 }.
// MyMod.esp pending: { X1: 50, X2: 100 } — only X1 changed.
const structWithPendingResult = {
  conflictAll: 'Override',
  overrides: [
    {
      formKey: '000001:Fallout4.esm', plugin: 'Fallout4.esm',
      loadOrderIndex: 0, isWinner: false, editorId: 'TestNPC',
      fields: [{ metadata: structMeta, value: { X1: 0, X2: 100 } }],
      pendingFields: {}, conflictThis: 'Master',
    },
    {
      formKey: '000001:Fallout4.esm', plugin: 'MyMod.esp',
      loadOrderIndex: 1, isWinner: true, editorId: 'TestNPC',
      fields: [{ metadata: structMeta, value: { X1: 0, X2: 100 } }],
      pendingFields: { ObjectBounds: { X1: 50, X2: 100 } },
      conflictThis: 'Override',
    },
  ],
  diffs: [{
    fieldName: 'ObjectBounds',
    values: { 'Fallout4.esm': { X1: 0, X2: 100 }, 'MyMod.esp': { X1: 0, X2: 100 } },
    winnerPlugin: 'Fallout4.esm', winnerValue: { X1: 0, X2: 100 },
    cellStates: { 'MyMod.esp': 'Override' },
    children: [
      {
        fieldName: 'X1',
        values: { 'Fallout4.esm': 0, 'MyMod.esp': 0 },
        winnerPlugin: 'Fallout4.esm', winnerValue: 0,
        cellStates: { 'MyMod.esp': 'IdenticalToMaster' },
      },
      {
        fieldName: 'X2',
        values: { 'Fallout4.esm': 100, 'MyMod.esp': 100 },
        winnerPlugin: 'Fallout4.esm', winnerValue: 100,
        cellStates: { 'MyMod.esp': 'IdenticalToMaster' },
      },
    ],
  }],
};

const structPendingChange = {
  id: 'struct-change-1', formKey: '000001:Fallout4.esm', plugin: 'MyMod.esp',
  fieldPath: 'ObjectBounds', recordType: 'Npc',
  oldValue: { X1: 0, X2: 100 }, newValue: { X1: 50, X2: 100 },
  source: 'agent', description: null, changedAt: '2026-06-20T12:00:00Z',
};

// Disk: Fallout4.esm { X1: 0, X2: 100 }, MyMod.esp { X1: 5, X2: 200 }. No pending.
const structEditResult = {
  conflictAll: 'Override',
  overrides: [
    {
      formKey: '000001:Fallout4.esm', plugin: 'Fallout4.esm',
      loadOrderIndex: 0, isWinner: false, editorId: 'TestNPC',
      fields: [{ metadata: structMeta, value: { X1: 0, X2: 100 } }],
      pendingFields: {}, conflictThis: 'Master',
    },
    {
      formKey: '000001:Fallout4.esm', plugin: 'MyMod.esp',
      loadOrderIndex: 1, isWinner: true, editorId: 'TestNPC',
      fields: [{ metadata: structMeta, value: { X1: 5, X2: 200 } }],
      pendingFields: {}, conflictThis: 'Override',
    },
  ],
  diffs: [{
    fieldName: 'ObjectBounds',
    values: { 'Fallout4.esm': { X1: 0, X2: 100 }, 'MyMod.esp': { X1: 5, X2: 200 } },
    winnerPlugin: 'MyMod.esp', winnerValue: { X1: 5, X2: 200 },
    cellStates: { 'MyMod.esp': 'Override' },
    children: [
      {
        fieldName: 'X1',
        values: { 'Fallout4.esm': 0, 'MyMod.esp': 5 },
        winnerPlugin: 'MyMod.esp', winnerValue: 5,
        cellStates: { 'MyMod.esp': 'Override' },
      },
      {
        fieldName: 'X2',
        values: { 'Fallout4.esm': 100, 'MyMod.esp': 200 },
        winnerPlugin: 'MyMod.esp', winnerValue: 200,
        cellStates: { 'MyMod.esp': 'Override' },
      },
    ],
  }],
};

// MyMod.esp disk: { X1: 5, X2: 200 }, pending: { X1: 5, X2: 300 } (X2 previously changed).
const structEditWithPriorPendingResult = {
  conflictAll: 'Override',
  overrides: [
    {
      formKey: '000001:Fallout4.esm', plugin: 'Fallout4.esm',
      loadOrderIndex: 0, isWinner: false, editorId: 'TestNPC',
      fields: [{ metadata: structMeta, value: { X1: 0, X2: 100 } }],
      pendingFields: {}, conflictThis: 'Master',
    },
    {
      formKey: '000001:Fallout4.esm', plugin: 'MyMod.esp',
      loadOrderIndex: 1, isWinner: true, editorId: 'TestNPC',
      fields: [{ metadata: structMeta, value: { X1: 5, X2: 200 } }],
      pendingFields: { ObjectBounds: { X1: 5, X2: 300 } },
      conflictThis: 'Override',
    },
  ],
  diffs: [{
    fieldName: 'ObjectBounds',
    values: { 'Fallout4.esm': { X1: 0, X2: 100 }, 'MyMod.esp': { X1: 5, X2: 200 } },
    winnerPlugin: 'MyMod.esp', winnerValue: { X1: 5, X2: 200 },
    cellStates: { 'MyMod.esp': 'Override' },
    children: [
      {
        fieldName: 'X1',
        values: { 'Fallout4.esm': 0, 'MyMod.esp': 5 },
        winnerPlugin: 'MyMod.esp', winnerValue: 5,
        cellStates: { 'MyMod.esp': 'Override' },
      },
      {
        fieldName: 'X2',
        values: { 'Fallout4.esm': 100, 'MyMod.esp': 200 },
        winnerPlugin: 'MyMod.esp', winnerValue: 200,
        cellStates: { 'MyMod.esp': 'Override' },
      },
    ],
  }],
};

const structEditPriorPendingChange = {
  id: 'struct-edit-change-1', formKey: '000001:Fallout4.esm', plugin: 'MyMod.esp',
  fieldPath: 'ObjectBounds', recordType: 'Npc',
  oldValue: { X1: 5, X2: 200 }, newValue: { X1: 5, X2: 300 },
  source: 'agent', description: null, changedAt: '2026-06-20T12:00:00Z',
};

// ── Struct-in-array (grandchild) fixtures ─────────────────────────────────────

const structInArrayMeta: FieldMetadata = {
  name: 'Packages',
  type: 'array',
  isArray: true,
  validFormKeyTypes: [],
  enumValues: [],
  elementType: {
    name: '',
    type: 'struct',
    isArray: false,
    validFormKeyTypes: [],
    enumValues: [],
    fields: [
      { name: 'PkgId', type: 'string', isArray: false, validFormKeyTypes: [], enumValues: [] },
      { name: 'Priority', type: 'int', isArray: false, validFormKeyTypes: [], enumValues: [] },
    ],
  },
};

// Disk: both plugins have [{ PkgId: 'PkgA', Priority: 1 }].
// MyMod.esp pending: [{ PkgId: 'PkgA', Priority: 5 }] — only Priority changed.
const structInArrayResult = {
  conflictAll: 'Override',
  overrides: [
    {
      formKey: '000001:Fallout4.esm', plugin: 'Fallout4.esm',
      loadOrderIndex: 0, isWinner: false, editorId: 'TestNPC',
      fields: [{ metadata: structInArrayMeta, value: [{ PkgId: 'PkgA', Priority: 1 }] }],
      pendingFields: {}, conflictThis: 'Master',
    },
    {
      formKey: '000001:Fallout4.esm', plugin: 'MyMod.esp',
      loadOrderIndex: 1, isWinner: true, editorId: 'TestNPC',
      fields: [{ metadata: structInArrayMeta, value: [{ PkgId: 'PkgA', Priority: 1 }] }],
      pendingFields: { Packages: [{ PkgId: 'PkgA', Priority: 5 }] },
      conflictThis: 'Override',
    },
  ],
  diffs: [{
    fieldName: 'Packages',
    values: {
      'Fallout4.esm': [{ PkgId: 'PkgA', Priority: 1 }],
      'MyMod.esp': [{ PkgId: 'PkgA', Priority: 1 }],
    },
    winnerPlugin: 'Fallout4.esm', winnerValue: [{ PkgId: 'PkgA', Priority: 1 }],
    cellStates: { 'MyMod.esp': 'Override' },
    children: [
      {
        fieldName: '[0]',
        values: {
          'Fallout4.esm': { PkgId: 'PkgA', Priority: 1 },
          'MyMod.esp': { PkgId: 'PkgA', Priority: 1 },
        },
        winnerPlugin: 'Fallout4.esm', winnerValue: { PkgId: 'PkgA', Priority: 1 },
        cellStates: { 'MyMod.esp': 'IdenticalToMaster' },
        children: [
          {
            fieldName: 'PkgId',
            values: { 'Fallout4.esm': 'PkgA', 'MyMod.esp': 'PkgA' },
            winnerPlugin: 'Fallout4.esm', winnerValue: 'PkgA',
            cellStates: { 'MyMod.esp': 'IdenticalToMaster' },
          },
          {
            fieldName: 'Priority',
            values: { 'Fallout4.esm': 1, 'MyMod.esp': 1 },
            winnerPlugin: 'Fallout4.esm', winnerValue: 1,
            cellStates: { 'MyMod.esp': 'IdenticalToMaster' },
          },
        ],
      },
    ],
  }],
};

const structInArrayPendingChange = {
  id: 'array-change-1', formKey: '000001:Fallout4.esm', plugin: 'MyMod.esp',
  fieldPath: 'Packages', recordType: 'Npc',
  oldValue: [{ PkgId: 'PkgA', Priority: 1 }],
  newValue: [{ PkgId: 'PkgA', Priority: 5 }],
  source: 'agent', description: null, changedAt: '2026-06-20T12:00:00Z',
};

// Issue #122: the panel renders against an injected client. Each block sets its compare/changes
// fixture, and `renderPanel` builds a fake client whose `load` returns the composite view and
// whose `save` is a spy the edit tests assert on.
let currentCompare: object;
let currentChanges: object[] = [];

function loadReturn(): LoadResult {
  return {
    ok: true, result: currentCompare, changes: currentChanges, plugins: pluginsResponse,
    immutableSet: new Set(pluginsResponse.filter(p => p.isImmutable).map(p => p.name)),
  } as unknown as LoadResult;
}

function fakeClient(): RecordSessionClient {
  const resp = { ok: true, status: 200, statusText: 'HTTP 200', json: () => Promise.resolve([]) } as unknown as Response;
  return {
    load: vi.fn().mockImplementation(() => Promise.resolve(loadReturn())),
    save: vi.fn().mockResolvedValue(resp),
    revert: vi.fn().mockResolvedValue(resp),
    copyTo: vi.fn().mockResolvedValue(resp),
    removeOverride: vi.fn().mockResolvedValue(resp),
    createRecord: vi.fn().mockResolvedValue(resp),
  };
}

function renderPanel() {
  const client = fakeClient();
  return { client, ...render(<RecordPanel client={client} />) };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('RecordPanel — array child rows (sorted)', () => {
  beforeEach(() => {
    vi.stubGlobal('mEditFormKey', '000001:Fallout4.esm');
    currentCompare = sortedArrayCompareResult;
    currentChanges = [];
  });
  afterEach(() => vi.unstubAllGlobals());

  it('parent array row shows [2] when collapsed', async () => {
    renderPanel();
    await waitFor(() => screen.getByText('Keywords'));
    // Both plugin columns have 2-element arrays; at least one [2] must be visible
    expect(screen.getAllByText('[2]').length).toBeGreaterThan(0);
    // No {…} placeholder for array parent
    expect(screen.queryByText('{…}')).not.toBeInTheDocument();
  });

  it('clicking ▶ expands to show 3 child rows for the sorted array', async () => {
    renderPanel();
    await waitFor(() => screen.getByText('▶'));
    fireEvent.click(screen.getByText('▶'));
    // Field name TDs contain the element keys; use getAllByText since FormKey also renders them as links
    await waitFor(() => screen.getAllByText('KwdA').length > 0);
    expect(screen.getAllByText('KwdB').length).toBeGreaterThan(0);
    expect(screen.getAllByText('KwdC').length).toBeGreaterThan(0);
  });

  it('KwdB child row has dimmed em-dash for MyMod.esp (null value)', async () => {
    renderPanel();
    await waitFor(() => screen.getByText('▶'));
    fireEvent.click(screen.getByText('▶'));
    await waitFor(() => screen.getAllByText('KwdB').length > 0);
    const kwdBTd = screen.getAllByText('KwdB').find(el => el.tagName === 'TD');
    expect(kwdBTd).toBeTruthy();
    const kwdBRow = kwdBTd!.closest('tr')!;
    const dimSpan = Array.from(kwdBRow.querySelectorAll('span')).find(
      s => s.textContent === '—' && s.style.opacity === '0.35',
    );
    expect(dimSpan).toBeTruthy();
  });
});

describe('RecordPanel — array child rows (pending highlight)', () => {
  beforeEach(() => {
    vi.stubGlobal('mEditFormKey', '000001:Fallout4.esm');
    currentCompare = unsortedArrayWithPendingResult;
    currentChanges = [pendingChange];
  });
  afterEach(() => vi.unstubAllGlobals());

  it('element [1] row is yellow-highlighted for MyMod.esp pending change', async () => {
    renderPanel();
    await waitFor(() => screen.getByText('▶'));
    fireEvent.click(screen.getByText('▶'));
    await waitFor(() => screen.getByText('[1]'));

    // The pending column for element [1] should have the yellow background
    // Find all pending cells (italic columns) — look for one with the highlight
    const row1 = screen.getByText('[1]').closest('tr')!;
    const pendingCells = Array.from(row1.querySelectorAll('td')).filter(
      td => td.style.backgroundColor === 'rgba(255, 200, 50, 0.10)',
    );
    expect(pendingCells.length).toBeGreaterThan(0);
  });

  it('element [0] row is NOT yellow-highlighted (unchanged element)', async () => {
    renderPanel();
    await waitFor(() => screen.getByText('▶'));
    fireEvent.click(screen.getByText('▶'));
    await waitFor(() => screen.getByText('[1]'));

    // [0] appears in header too (load order index); find the td in the table body
    const row0Td = screen.getAllByText('[0]').find(el => el.tagName === 'TD')!;
    const row0 = row0Td.closest('tr')!;
    const highlightedCells = Array.from(row0.querySelectorAll('td')).filter(
      td => td.style.backgroundColor === 'rgba(255, 200, 50, 0.10)',
    );
    expect(highlightedCells.length).toBe(0);
  });
});

describe('RecordPanel — array element edit', () => {
  beforeEach(() => {
    vi.stubGlobal('mEditFormKey', '000001:Fallout4.esm');
    currentCompare = unsortedArrayWithPendingResult;
    currentChanges = [];
  });
  afterEach(() => vi.unstubAllGlobals());

  it('editing element [1] calls save with full updated array', async () => {
    const { client } = renderPanel();
    await waitFor(() => screen.getByText('▶'));
    fireEvent.click(screen.getByText('▶'));
    await waitFor(() => screen.getByText('[1]'));

    // MyMod.esp's [1] element is 'gamma'. Issue #223: the first click only focuses it; a
    // second click on the now-focused cell activates its input, which is then edited.
    fireEvent.click(screen.getByText('gamma'));
    fireEvent.click(screen.getByText('gamma'));
    const gammaInput = screen.getByDisplayValue('gamma');
    fireEvent.change(gammaInput, { target: { value: 'epsilon' } });
    fireEvent.blur(gammaInput);

    // Element [0] unchanged ('alpha'), element [1] replaced ('epsilon')
    await waitFor(() =>
      expect(client.save).toHaveBeenCalledWith(
        '000001:Fallout4.esm',
        'MyMod.esp',
        { Items: ['alpha', 'epsilon'] },
        undefined,
      ),
    );
  });
});

// ── Struct sub-field pending highlight ────────────────────────────────────────

describe('RecordPanel — struct sub-field pending highlight', () => {
  beforeEach(() => {
    vi.stubGlobal('mEditFormKey', '000001:Fallout4.esm');
    currentCompare = structWithPendingResult;
    currentChanges = [structPendingChange];
  });
  afterEach(() => vi.unstubAllGlobals());

  it('X1 sub-field row is highlighted (pending value differs from disk)', async () => {
    renderPanel();
    await waitFor(() => screen.getByText('▶'));
    fireEvent.click(screen.getByText('▶'));
    await waitFor(() => screen.getByText('X1'));

    const x1Row = screen.getByText('X1').closest('tr')!;
    const highlightedCells = Array.from(x1Row.querySelectorAll('td')).filter(
      td => td.style.backgroundColor === 'rgba(255, 200, 50, 0.10)',
    );
    expect(highlightedCells.length).toBeGreaterThan(0);
  });

  it('X2 sub-field row is NOT highlighted (pending value equals disk)', async () => {
    renderPanel();
    await waitFor(() => screen.getByText('▶'));
    fireEvent.click(screen.getByText('▶'));
    await waitFor(() => screen.getByText('X2'));

    const x2Row = screen.getByText('X2').closest('tr')!;
    const highlightedCells = Array.from(x2Row.querySelectorAll('td')).filter(
      td => td.style.backgroundColor === 'rgba(255, 200, 50, 0.10)',
    );
    expect(highlightedCells.length).toBe(0);
  });

});

// ── Struct sub-field edit ─────────────────────────────────────────────────────

describe('RecordPanel — struct sub-field edit', () => {
  beforeEach(() => {
    vi.stubGlobal('mEditFormKey', '000001:Fallout4.esm');
    currentCompare = structEditResult;
    currentChanges = [];
  });
  afterEach(() => vi.unstubAllGlobals());

  it('editing X1 calls save with full struct (X2 preserved from disk)', async () => {
    const { client } = renderPanel();
    await waitFor(() => screen.getByText('▶'));
    fireEvent.click(screen.getByText('▶'));
    await waitFor(() => screen.getByText('5'));

    // Click X1's cell in the MyMod.esp column to activate its input. Issue #223: the first
    // click only focuses it; a second click on the now-focused cell opens it.
    fireEvent.click(screen.getByText('5'));
    fireEvent.click(screen.getByText('5'));
    const x1Input = screen.getByDisplayValue('5');
    fireEvent.change(x1Input, { target: { value: '10' } });
    fireEvent.blur(x1Input);

    await waitFor(() =>
      expect(client.save).toHaveBeenCalledWith(
        '000001:Fallout4.esm',
        'MyMod.esp',
        { ObjectBounds: { X1: 10, X2: 200 } },
        undefined,
      ),
    );
  });

  it('editing X1 with prior pending on X2 uses pending X2, not disk X2', async () => {
    currentCompare = structEditWithPriorPendingResult;
    currentChanges = [structEditPriorPendingChange];
    const { client } = renderPanel();
    await waitFor(() => screen.getByText('▶'));
    fireEvent.click(screen.getByText('▶'));
    await waitFor(() => screen.getByText('5'));

    // Click X1's cell in the MyMod.esp column to activate its input. Issue #223: the first
    // click only focuses it; a second click on the now-focused cell opens it.
    fireEvent.click(screen.getByText('5'));
    fireEvent.click(screen.getByText('5'));
    const x1Input = screen.getByDisplayValue('5');
    fireEvent.change(x1Input, { target: { value: '10' } });
    fireEvent.blur(x1Input);

    // X2 must come from pending (300), not disk (200)
    await waitFor(() =>
      expect(client.save).toHaveBeenCalledWith(
        '000001:Fallout4.esm',
        'MyMod.esp',
        { ObjectBounds: { X1: 10, X2: 300 } },
        undefined,
      ),
    );
  });
});

// ── Grandchild rows (struct inside array element) ─────────────────────────────

describe('RecordPanel — grandchild rows (struct sub-fields inside array element)', () => {
  beforeEach(() => {
    vi.stubGlobal('mEditFormKey', '000001:Fallout4.esm');
    currentCompare = structInArrayResult;
    currentChanges = [structInArrayPendingChange];
  });
  afterEach(() => vi.unstubAllGlobals());

  async function expandToGrandchildren() {
    renderPanel();
    await waitFor(() => screen.getByText('▶'));
    fireEvent.click(screen.getByText('▶'));        // expand Packages
    // [0] also appears in column headers; find the TD in the table body
    await waitFor(() => {
      const td = screen.getAllByText('[0]').find(el => el.tagName === 'TD');
      if (!td) throw new Error('[0] TD not found yet');
    });
    fireEvent.click(screen.getByText('▶'));        // expand [0] (now the only ▶)
    await waitFor(() => screen.getByText('Priority'));
  }

  it('Priority grandchild row is highlighted (pending value differs from disk)', async () => {
    await expandToGrandchildren();

    const priorityRow = screen.getByText('Priority').closest('tr')!;
    const highlightedCells = Array.from(priorityRow.querySelectorAll('td')).filter(
      td => td.style.backgroundColor === 'rgba(255, 200, 50, 0.10)',
    );
    expect(highlightedCells.length).toBeGreaterThan(0);
  });

  it('PkgId grandchild row is NOT highlighted (pending value equals disk)', async () => {
    await expandToGrandchildren();

    const pkgIdRow = screen.getByText('PkgId').closest('tr')!;
    const highlightedCells = Array.from(pkgIdRow.querySelectorAll('td')).filter(
      td => td.style.backgroundColor === 'rgba(255, 200, 50, 0.10)',
    );
    expect(highlightedCells.length).toBe(0);
  });

});

// ── #227: array arity/order ops on the right-click menu + keyboard accelerators ────────────────
// (unsorted arrays only) — #142's inline ▲▼✕/＋ buttons are gone (ADR-0034's no-second-route
// rule); Add/Remove/Move Up/Move Down are now a native `webview/context` menu entry (broadcast to
// this panel, asserted here via the same `window.dispatchEvent(new MessageEvent(...))` harness
// #208/#209's column-header/pending-cell broadcasts already use) with Insert/Delete/Ctrl+↑/Ctrl+↓
// as keyboard accelerators (asserted via `fireEvent.keyDown` on the cell, the same DOM-level
// precedent #224's Ctrl+C tests use). The pure mutations themselves are recordUtils.test.ts's
// job; DiffRow.test.tsx covers the data-vscode-context/keydown wiring in isolation — this suite
// is the through-RecordPanel integration slice: does the whole stack restage the right array.

describe('RecordPanel — array arity/order ops via keyboard (unsorted)', () => {
  beforeEach(() => {
    vi.stubGlobal('mEditFormKey', '000001:Fallout4.esm');
    currentCompare = unsortedArrayControlsResult;
    currentChanges = [];
  });
  afterEach(() => vi.unstubAllGlobals());

  async function expandItems() {
    await waitFor(() => screen.getByText('▶'));
    fireEvent.click(screen.getByText('▶'));
    await waitFor(() => rowByLabel('[2]'));
  }

  // Element row labels ("[0]", "[1]", …) collide with plugin-header load-order labels
  // ("[0]", "[1]" — see PluginHeader), which getByText also matches. Row labels are the
  // element row's own label <td>, whose text content is exactly the bracketed index.
  function rowByLabel(label: string): HTMLTableRowElement {
    const td = Array.from(document.querySelectorAll('td')).find(el => el.textContent === label);
    if (!td) throw new Error(`no row labeled ${label}`);
    return td.closest('tr')!;
  }

  // MyMod.esp is the mutable column (index 2 of 0=label/1=Fallout4.esm/2=MyMod.esp).
  function mutableCellOf(row: HTMLTableRowElement): HTMLTableCellElement {
    return row.querySelectorAll('td')[2];
  }
  function immutableCellOf(row: HTMLTableRowElement): HTMLTableCellElement {
    return row.querySelectorAll('td')[1];
  }

  it('Ctrl+↓ on element [0] swaps it with [1] and saves the whole array', async () => {
    const { client } = renderPanel();
    await expandItems();

    fireEvent.keyDown(mutableCellOf(rowByLabel('[0]')), { key: 'ArrowDown', ctrlKey: true });

    await waitFor(() =>
      expect(client.save).toHaveBeenCalledWith(
        '000001:Fallout4.esm', 'MyMod.esp', { Items: ['beta', 'alpha', 'gamma'] }, undefined,
      ),
    );
  });

  it('Ctrl+↑ on the first element does nothing (absent, not disabled)', async () => {
    const { client } = renderPanel();
    await expandItems();

    fireEvent.keyDown(mutableCellOf(rowByLabel('[0]')), { key: 'ArrowUp', ctrlKey: true });
    expect(client.save).not.toHaveBeenCalled();
  });

  it('Delete on element [1] saves the array with that element dropped', async () => {
    const { client } = renderPanel();
    await expandItems();

    fireEvent.keyDown(mutableCellOf(rowByLabel('[1]')), { key: 'Delete' });

    await waitFor(() =>
      expect(client.save).toHaveBeenCalledWith(
        '000001:Fallout4.esm', 'MyMod.esp', { Items: ['alpha', 'gamma'] }, undefined,
      ),
    );
  });

  it('move/remove keys do nothing on the immutable Fallout4.esm column', async () => {
    const { client } = renderPanel();
    await expandItems();

    const row0 = rowByLabel('[0]');
    fireEvent.keyDown(immutableCellOf(row0), { key: 'Delete' });
    fireEvent.keyDown(immutableCellOf(row0), { key: 'ArrowDown', ctrlKey: true });
    expect(client.save).not.toHaveBeenCalled();
  });

  it('Insert on the parent Items row appends a default-valued scalar element', async () => {
    const { client } = renderPanel();
    await expandItems();

    const parentRow = screen.getByText('Items').closest('tr')!;
    fireEvent.keyDown(mutableCellOf(parentRow), { key: 'Insert' });

    await waitFor(() =>
      expect(client.save).toHaveBeenCalledWith(
        '000001:Fallout4.esm', 'MyMod.esp', { Items: ['alpha', 'beta', 'gamma', ''] }, undefined,
      ),
    );
  });

  it('Insert on the parent Items row works even while the row is collapsed', async () => {
    // Issue #227: Add is available regardless of expand state, matching xEdit — the old "+"
    // button's isExpanded gate was that button's own rendering choice, not a functional rule.
    const { client } = renderPanel();
    await waitFor(() => screen.getByText('▶'));

    const parentRow = screen.getByText('Items').closest('tr')!;
    fireEvent.keyDown(mutableCellOf(parentRow), { key: 'Insert' });

    await waitFor(() =>
      expect(client.save).toHaveBeenCalledWith(
        '000001:Fallout4.esm', 'MyMod.esp', { Items: ['alpha', 'beta', 'gamma', ''] }, undefined,
      ),
    );
  });

  it('Insert does nothing on the immutable Fallout4.esm column', async () => {
    const { client } = renderPanel();
    await expandItems();

    const parentRow = screen.getByText('Items').closest('tr')!;
    fireEvent.keyDown(immutableCellOf(parentRow), { key: 'Insert' });
    expect(client.save).not.toHaveBeenCalled();
  });

  // Issue #200: array add/remove/move-up/move-down all converge on the same handleEdit→
  // stageChange path a plain field edit uses — tested explicitly here anyway (representative
  // callers for a bullet the issue names on its own), not assumed from the field-edit case.
  // Move-up/down is the identical handleArrayMove call as remove, so not separately tested.
  it('Insert (add) logs a DEBUG line naming the plugin, field, and record', async () => {
    renderPanel();
    await expandItems();
    vi.mocked(vscode.postMessage).mockClear();

    const parentRow = screen.getByText('Items').closest('tr')!;
    fireEvent.keyDown(mutableCellOf(parentRow), { key: 'Insert' });

    await waitFor(() => expect(vscode.postMessage).toHaveBeenCalledWith({
      type: WEBVIEW_TO_EXTENSION.LOG,
      level: 'debug',
      message: expect.stringContaining('Items'),
    }));
  });

  it('Delete (remove) logs a DEBUG line naming the plugin, field, and record', async () => {
    renderPanel();
    await expandItems();
    vi.mocked(vscode.postMessage).mockClear();

    fireEvent.keyDown(mutableCellOf(rowByLabel('[1]')), { key: 'Delete' });

    await waitFor(() => expect(vscode.postMessage).toHaveBeenCalledWith({
      type: WEBVIEW_TO_EXTENSION.LOG,
      level: 'debug',
      message: expect.stringContaining('Items'),
    }));
  });
});

// Issue #227: the right-click menu's broadcast path — the extension host has no live reference
// into this webview's React state (same reasoning as #208/#209), so its native commands
// broadcast ARRAY_ADD/ARRAY_REMOVE/ARRAY_MOVE_UP/ARRAY_MOVE_DOWN to every open record panel and
// each self-filters on formKey. Simulated the same way #208/#209's broadcasts already are in
// RecordPanel.test.tsx: dispatching a raw `message` MessageEvent, not driving it through a real
// command execution (that's package.json/extension.ts's job, covered by the integration test's
// EXPECTED_COMMANDS list and manual verification).
describe('RecordPanel — array ops via the right-click menu broadcast (#227)', () => {
  beforeEach(() => {
    vi.stubGlobal('mEditFormKey', '000001:Fallout4.esm');
    currentCompare = unsortedArrayControlsResult;
    currentChanges = [];
  });
  afterEach(() => vi.unstubAllGlobals());

  function postArrayOp(type: string, extra: Record<string, unknown>) {
    window.dispatchEvent(new MessageEvent('message', {
      data: { type, formKey: '000001:Fallout4.esm', plugin: 'MyMod.esp', fieldName: 'Items', ...extra },
    }));
  }

  it('ARRAY_ADD appends a default-valued element and saves the whole array', async () => {
    const { client } = renderPanel();
    await waitFor(() => screen.getByText('Items'));

    postArrayOp(EXTENSION_TO_WEBVIEW.ARRAY_ADD, {});

    await waitFor(() =>
      expect(client.save).toHaveBeenCalledWith(
        '000001:Fallout4.esm', 'MyMod.esp', { Items: ['alpha', 'beta', 'gamma', ''] }, undefined,
      ),
    );
  });

  it('ARRAY_REMOVE drops the element at the given index and saves the whole array', async () => {
    const { client } = renderPanel();
    await waitFor(() => screen.getByText('Items'));

    postArrayOp(EXTENSION_TO_WEBVIEW.ARRAY_REMOVE, { index: 1 });

    await waitFor(() =>
      expect(client.save).toHaveBeenCalledWith(
        '000001:Fallout4.esm', 'MyMod.esp', { Items: ['alpha', 'gamma'] }, undefined,
      ),
    );
  });

  it('ARRAY_MOVE_UP swaps the element with its predecessor and saves the whole array', async () => {
    const { client } = renderPanel();
    await waitFor(() => screen.getByText('Items'));

    postArrayOp(EXTENSION_TO_WEBVIEW.ARRAY_MOVE_UP, { index: 1 });

    await waitFor(() =>
      expect(client.save).toHaveBeenCalledWith(
        '000001:Fallout4.esm', 'MyMod.esp', { Items: ['beta', 'alpha', 'gamma'] }, undefined,
      ),
    );
  });

  it('ARRAY_MOVE_DOWN swaps the element with its successor and saves the whole array', async () => {
    const { client } = renderPanel();
    await waitFor(() => screen.getByText('Items'));

    postArrayOp(EXTENSION_TO_WEBVIEW.ARRAY_MOVE_DOWN, { index: 1 });

    await waitFor(() =>
      expect(client.save).toHaveBeenCalledWith(
        '000001:Fallout4.esm', 'MyMod.esp', { Items: ['alpha', 'gamma', 'beta'] }, undefined,
      ),
    );
  });

  it('a move at the array boundary does nothing (no save call)', async () => {
    const { client } = renderPanel();
    await waitFor(() => screen.getByText('Items'));

    postArrayOp(EXTENSION_TO_WEBVIEW.ARRAY_MOVE_UP, { index: 0 });
    expect(client.save).not.toHaveBeenCalled();
  });

  // Self-filter: a changeId is global in the pending-cell broadcasts, but array ops have no
  // changeId — formKey is what stops a broadcast meant for a different open record from acting
  // here (same reasoning as #209's column-header formKey self-filter).
  it('a broadcast for a different formKey is ignored', async () => {
    const { client } = renderPanel();
    await waitFor(() => screen.getByText('Items'));

    window.dispatchEvent(new MessageEvent('message', {
      data: { type: EXTENSION_TO_WEBVIEW.ARRAY_REMOVE, formKey: '000099:Other.esm', plugin: 'MyMod.esp', fieldName: 'Items', index: 1 },
    }));
    expect(client.save).not.toHaveBeenCalled();
  });
});

describe('RecordPanel — array add via the menu broadcast (struct elements)', () => {
  beforeEach(() => {
    vi.stubGlobal('mEditFormKey', '000001:Fallout4.esm');
    currentCompare = structInArrayResult;
    currentChanges = [];
  });
  afterEach(() => vi.unstubAllGlobals());

  it('ARRAY_ADD on the parent Packages row appends a metadata-derived default struct', async () => {
    const { client } = renderPanel();
    await waitFor(() => screen.getByText('Packages'));

    window.dispatchEvent(new MessageEvent('message', {
      data: { type: EXTENSION_TO_WEBVIEW.ARRAY_ADD, formKey: '000001:Fallout4.esm', plugin: 'MyMod.esp', fieldName: 'Packages' },
    }));

    await waitFor(() =>
      expect(client.save).toHaveBeenCalledWith(
        '000001:Fallout4.esm',
        'MyMod.esp',
        // MyMod.esp has a prior pending change (Priority 1 → 5, per structInArrayResult's
        // fixture comment) — the add builds off that pending-merged array, not disk.
        { Packages: [{ PkgId: 'PkgA', Priority: 5 }, { PkgId: '', Priority: 0 }] },
        undefined,
      ),
    );
  });
});

describe('RecordPanel — array arity/order ops absent for sorted arrays', () => {
  beforeEach(() => {
    vi.stubGlobal('mEditFormKey', '000001:Fallout4.esm');
    currentCompare = sortedArrayCompareResult;
    currentChanges = [];
  });
  afterEach(() => vi.unstubAllGlobals());

  it('no element row carries an arrayElement data-vscode-context, and keys do nothing', async () => {
    const { client } = renderPanel();
    await waitFor(() => screen.getByText('▶'));
    fireEvent.click(screen.getByText('▶'));
    await waitFor(() => screen.getAllByText('KwdA').length > 0);

    const cells = Array.from(document.querySelectorAll('td[data-vscode-context]'));
    const arrayCells = cells.filter(c => {
      const ctx = JSON.parse(c.getAttribute('data-vscode-context')!);
      return ctx.webviewSection === 'arrayElement' || ctx.webviewSection === 'arrayParent';
    });
    expect(arrayCells).toHaveLength(0);

    const kwdACell = screen.getAllByText('KwdA').find(el => el.tagName === 'TD')!.closest('td')!;
    fireEvent.keyDown(kwdACell, { key: 'Delete' });
    fireEvent.keyDown(kwdACell, { key: 'ArrowUp', ctrlKey: true });
    expect(client.save).not.toHaveBeenCalled();
  });
});
