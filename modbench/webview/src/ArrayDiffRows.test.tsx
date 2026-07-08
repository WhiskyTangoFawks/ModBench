import '@testing-library/jest-dom';
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('./vscode', () => ({ vscode: { postMessage: vi.fn() } }));

import { RecordPanel } from './RecordPanel';
import type { FieldMetadata } from './types';

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

function makeFetch(compareResult: object, changes: object[] = []) {
  return vi.fn((url: string) => {
    if (String(url).includes('/compare')) return { ok: true, json: () => Promise.resolve(compareResult) };
    if (String(url).includes('/changes'))  return { ok: true, json: () => Promise.resolve(changes) };
    if (String(url).includes('/plugins'))  return { ok: true, json: () => Promise.resolve(pluginsResponse) };
    return { ok: false, status: 404, statusText: 'Not Found' };
  });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('RecordPanel — array child rows (sorted)', () => {
  beforeEach(() => {
    vi.stubGlobal('mEditFormKey', '000001:Fallout4.esm');
    vi.stubGlobal('mEditBackendPort', 15172);
    vi.stubGlobal('fetch', makeFetch(sortedArrayCompareResult));
  });
  afterEach(() => vi.unstubAllGlobals());

  it('parent array row shows [2] when collapsed', async () => {
    render(<RecordPanel />);
    await waitFor(() => screen.getByText('Keywords'));
    // Both plugin columns have 2-element arrays; at least one [2] must be visible
    expect(screen.getAllByText('[2]').length).toBeGreaterThan(0);
    // No {…} placeholder for array parent
    expect(screen.queryByText('{…}')).not.toBeInTheDocument();
  });

  it('clicking ▶ expands to show 3 child rows for the sorted array', async () => {
    render(<RecordPanel />);
    await waitFor(() => screen.getByText('▶'));
    fireEvent.click(screen.getByText('▶'));
    // Field name TDs contain the element keys; use getAllByText since FormKey also renders them as links
    await waitFor(() => screen.getAllByText('KwdA').length > 0);
    expect(screen.getAllByText('KwdB').length).toBeGreaterThan(0);
    expect(screen.getAllByText('KwdC').length).toBeGreaterThan(0);
  });

  it('KwdB child row has dimmed em-dash for MyMod.esp (null value)', async () => {
    render(<RecordPanel />);
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
    vi.stubGlobal('mEditBackendPort', 15172);
    vi.stubGlobal('fetch', makeFetch(unsortedArrayWithPendingResult, [pendingChange]));
  });
  afterEach(() => vi.unstubAllGlobals());

  it('element [1] row is yellow-highlighted for MyMod.esp pending change', async () => {
    render(<RecordPanel />);
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
    render(<RecordPanel />);
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

  it('revert button ↩ appears on parent Items row', async () => {
    render(<RecordPanel />);
    await waitFor(() => screen.getByText('Items'));

    const parentRow = screen.getByText('Items').closest('tr')!;
    expect(parentRow.querySelector('button[title="Revert this change"]')).toBeTruthy();
  });

  it('revert button ↩ does NOT appear on element child rows', async () => {
    render(<RecordPanel />);
    await waitFor(() => screen.getByText('▶'));
    fireEvent.click(screen.getByText('▶'));
    await waitFor(() => screen.getByText('[1]'));

    const row1 = screen.getByText('[1]').closest('tr')!;
    expect(row1.querySelector('button[title="Revert this change"]')).toBeNull();

    const row0Td = screen.getAllByText('[0]').find(el => el.tagName === 'TD')!;
    const row0 = row0Td.closest('tr')!;
    expect(row0.querySelector('button[title="Revert this change"]')).toBeNull();
  });
});

describe('RecordPanel — array element edit', () => {
  beforeEach(() => {
    vi.stubGlobal('mEditFormKey', '000001:Fallout4.esm');
    vi.stubGlobal('mEditBackendPort', 15172);
    vi.stubGlobal('fetch', makeFetch(unsortedArrayWithPendingResult, []));
  });
  afterEach(() => vi.unstubAllGlobals());

  it('editing element [1] calls PATCH with full updated array', async () => {
    render(<RecordPanel />);
    await waitFor(() => screen.getByText('Edit'));
    fireEvent.click(screen.getByText('Edit'));
    await waitFor(() => screen.getByText('▶'));
    fireEvent.click(screen.getByText('▶'));
    await waitFor(() => screen.getByText('[1]'));

    // MyMod.esp's [1] element is 'gamma' — find and edit it
    const gammaInput = screen.getByDisplayValue('gamma');
    fireEvent.change(gammaInput, { target: { value: 'epsilon' } });
    fireEvent.blur(gammaInput);

    await waitFor(() =>
      expect(fetch).toHaveBeenCalledWith(
        expect.stringContaining('/records/'),
        expect.objectContaining({ method: 'PATCH' }),
      ),
    );

    const patchCall = (fetch as ReturnType<typeof vi.fn>).mock.calls.find(
      (c: unknown[]) => (c[1] as RequestInit)?.method === 'PATCH',
    )!;
    const body = JSON.parse((patchCall[1] as RequestInit).body as string) as {
      plugin: string;
      fields: Record<string, unknown>;
    };
    expect(body.plugin).toBe('MyMod.esp');
    // Element [0] unchanged ('alpha'), element [1] replaced ('epsilon')
    expect(body.fields['Items']).toEqual(['alpha', 'epsilon']);
  });
});

// ── Struct sub-field pending highlight ────────────────────────────────────────

describe('RecordPanel — struct sub-field pending highlight', () => {
  beforeEach(() => {
    vi.stubGlobal('mEditFormKey', '000001:Fallout4.esm');
    vi.stubGlobal('mEditBackendPort', 15172);
    vi.stubGlobal('fetch', makeFetch(structWithPendingResult, [structPendingChange]));
  });
  afterEach(() => vi.unstubAllGlobals());

  it('X1 sub-field row is highlighted (pending value differs from disk)', async () => {
    render(<RecordPanel />);
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
    render(<RecordPanel />);
    await waitFor(() => screen.getByText('▶'));
    fireEvent.click(screen.getByText('▶'));
    await waitFor(() => screen.getByText('X2'));

    const x2Row = screen.getByText('X2').closest('tr')!;
    const highlightedCells = Array.from(x2Row.querySelectorAll('td')).filter(
      td => td.style.backgroundColor === 'rgba(255, 200, 50, 0.10)',
    );
    expect(highlightedCells.length).toBe(0);
  });

  it('revert button ↩ appears on X1 sub-field row (triggers parent struct change)', async () => {
    render(<RecordPanel />);
    await waitFor(() => screen.getByText('▶'));
    fireEvent.click(screen.getByText('▶'));
    await waitFor(() => screen.getByText('X1'));

    const x1Row = screen.getByText('X1').closest('tr')!;
    expect(x1Row.querySelector('button[title="Revert this change"]')).toBeTruthy();
  });
});

// ── Struct sub-field edit ─────────────────────────────────────────────────────

describe('RecordPanel — struct sub-field edit', () => {
  beforeEach(() => {
    vi.stubGlobal('mEditFormKey', '000001:Fallout4.esm');
    vi.stubGlobal('mEditBackendPort', 15172);
    vi.stubGlobal('fetch', makeFetch(structEditResult, []));
  });
  afterEach(() => vi.unstubAllGlobals());

  it('editing X1 calls PATCH with full struct (X2 preserved from disk)', async () => {
    render(<RecordPanel />);
    await waitFor(() => screen.getByText('Edit'));
    fireEvent.click(screen.getByText('Edit'));
    await waitFor(() => screen.getByText('▶'));
    fireEvent.click(screen.getByText('▶'));
    await waitFor(() => screen.getByDisplayValue('5'));

    const x1Input = screen.getByDisplayValue('5');
    fireEvent.change(x1Input, { target: { value: '10' } });
    fireEvent.blur(x1Input);

    await waitFor(() =>
      expect(fetch).toHaveBeenCalledWith(
        expect.stringContaining('/records/'),
        expect.objectContaining({ method: 'PATCH' }),
      ),
    );

    const patchCall = (fetch as ReturnType<typeof vi.fn>).mock.calls.find(
      (c: unknown[]) => (c[1] as RequestInit)?.method === 'PATCH',
    )!;
    const body = JSON.parse((patchCall[1] as RequestInit).body as string) as {
      plugin: string; fields: Record<string, unknown>;
    };
    expect(body.plugin).toBe('MyMod.esp');
    expect(body.fields['ObjectBounds']).toEqual({ X1: 10, X2: 200 });
  });

  it('editing X1 with prior pending on X2 uses pending X2, not disk X2', async () => {
    vi.stubGlobal('fetch', makeFetch(structEditWithPriorPendingResult, [structEditPriorPendingChange]));
    render(<RecordPanel />);
    await waitFor(() => screen.getByText('Edit'));
    fireEvent.click(screen.getByText('Edit'));
    await waitFor(() => screen.getByText('▶'));
    fireEvent.click(screen.getByText('▶'));
    await waitFor(() => screen.getByDisplayValue('5'));

    const x1Input = screen.getByDisplayValue('5');
    fireEvent.change(x1Input, { target: { value: '10' } });
    fireEvent.blur(x1Input);

    await waitFor(() =>
      expect(fetch).toHaveBeenCalledWith(
        expect.stringContaining('/records/'),
        expect.objectContaining({ method: 'PATCH' }),
      ),
    );

    const patchCall = (fetch as ReturnType<typeof vi.fn>).mock.calls.find(
      (c: unknown[]) => (c[1] as RequestInit)?.method === 'PATCH',
    )!;
    const body = JSON.parse((patchCall[1] as RequestInit).body as string) as {
      plugin: string; fields: Record<string, unknown>;
    };
    expect(body.plugin).toBe('MyMod.esp');
    // X2 must come from pending (300), not disk (200)
    expect(body.fields['ObjectBounds']).toEqual({ X1: 10, X2: 300 });
  });
});

// ── Grandchild rows (struct inside array element) ─────────────────────────────

describe('RecordPanel — grandchild rows (struct sub-fields inside array element)', () => {
  beforeEach(() => {
    vi.stubGlobal('mEditFormKey', '000001:Fallout4.esm');
    vi.stubGlobal('mEditBackendPort', 15172);
    vi.stubGlobal('fetch', makeFetch(structInArrayResult, [structInArrayPendingChange]));
  });
  afterEach(() => vi.unstubAllGlobals());

  async function expandToGrandchildren() {
    render(<RecordPanel />);
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

  it('revert button ↩ does NOT appear on grandchild rows', async () => {
    await expandToGrandchildren();

    const priorityRow = screen.getByText('Priority').closest('tr')!;
    expect(priorityRow.querySelector('button[title="Revert this change"]')).toBeNull();

    const pkgIdRow = screen.getByText('PkgId').closest('tr')!;
    expect(pkgIdRow.querySelector('button[title="Revert this change"]')).toBeNull();
  });
});
