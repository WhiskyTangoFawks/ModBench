import '@testing-library/jest-dom';
import React from 'react';
import { render, screen, fireEvent, waitFor, within, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('./vscode', () => ({ vscode: { postMessage: vi.fn() } }));

import { RecordPanel } from './RecordPanel';
import type { FieldMetadata } from './types';
import { columnKey } from './types';
import type { LoadResult, RecordSessionClient } from './RecordSessionClient';
import { vscode } from './vscode';
import { WEBVIEW_TO_EXTENSION, EXTENSION_TO_WEBVIEW } from './messages';

// #410 review: the read-path half of the deleted ArrayDiffRows.test.tsx. Array/struct *rendering*
// — collapsed counts, expand-to-children, the dimmed em-dash for a null element, deep nesting, and
// #114's collapsed-aggregate / expanded-defers-to-children conflict-colour rule (CONTEXT.md's own
// ConflictAll entry states that rule; DiffRow.tsx implements it) — is untouched by #410 and had
// zero coverage after that file was deleted for its editing content. Restored here without the
// staging half.

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

const pluginsResponse = [
  { name: 'Fallout4.esm', isImmutable: true,  loadOrderIndex: 0 },
  { name: 'MyMod.esp',    isImmutable: false, loadOrderIndex: 1 },
];

const sortedArrayCompareResult = {
  conflictAll: 'Override',
  overrides: [
    {
      formKey: '000001:Fallout4.esm', plugin: 'Fallout4.esm',
      loadOrderIndex: 0, isWinner: false, editorId: 'TestNPC',
      fields: [{ metadata: sortedArrayMeta, value: ['KwdA', 'KwdB'] }], conflictThis: 'Master',
    },
    {
      formKey: '000001:Fallout4.esm', plugin: 'MyMod.esp',
      loadOrderIndex: 1, isWinner: true, editorId: 'TestNPC',
      fields: [{ metadata: sortedArrayMeta, value: ['KwdA', 'KwdC'] }], conflictThis: 'Override',
    },
  ],
  diffs: [{
    fieldName: 'Keywords',
    values: { 'Fallout4.esm': ['KwdA', 'KwdB'], 'MyMod.esp': ['KwdA', 'KwdC'] },
    winnerColumn: 'MyMod.esp',
    winnerValue: ['KwdA', 'KwdC'],
    cellStates: { 'MyMod.esp': 'Override' },
    children: [
      {
        fieldName: 'KwdA',
        values: { 'Fallout4.esm': 'KwdA', 'MyMod.esp': 'KwdA' },
        winnerColumn: 'Fallout4.esm', winnerValue: 'KwdA',
        cellStates: { 'MyMod.esp': 'IdenticalToMaster' },
      },
      {
        fieldName: 'KwdB',
        values: { 'Fallout4.esm': 'KwdB', 'MyMod.esp': null },
        winnerColumn: 'Fallout4.esm', winnerValue: 'KwdB',
        cellStates: {},
      },
      {
        fieldName: 'KwdC',
        values: { 'Fallout4.esm': null, 'MyMod.esp': 'KwdC' },
        winnerColumn: 'MyMod.esp', winnerValue: 'KwdC',
        cellStates: { 'MyMod.esp': 'Override' },
      },
    ],
  }],
};

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

const structCollapseExpandResult = {
  conflictAll: 'Override',
  overrides: [
    {
      formKey: '000001:Fallout4.esm', plugin: 'Fallout4.esm',
      loadOrderIndex: 0, isWinner: false, editorId: 'TestNPC',
      fields: [{ metadata: structMeta, value: { X1: 0, X2: 100 } }], conflictThis: 'Master',
    },
    {
      formKey: '000001:Fallout4.esm', plugin: 'MyMod.esp',
      loadOrderIndex: 1, isWinner: true, editorId: 'TestNPC',
      fields: [{ metadata: structMeta, value: { X1: 5, X2: 100 } }], conflictThis: 'Override',
    },
  ],
  diffs: [{
    fieldName: 'ObjectBounds',
    values: { 'Fallout4.esm': { X1: 0, X2: 100 }, 'MyMod.esp': { X1: 5, X2: 100 } },
    winnerColumn: 'MyMod.esp', winnerValue: { X1: 5, X2: 100 },
    cellStates: { 'MyMod.esp': 'Override' },
    conflictAll: 'Override',
    children: [
      {
        fieldName: 'X1',
        values: { 'Fallout4.esm': 0, 'MyMod.esp': 5 },
        winnerColumn: 'MyMod.esp', winnerValue: 5,
        cellStates: { 'MyMod.esp': 'Override' },
        conflictAll: 'Override',
      },
      {
        fieldName: 'X2',
        values: { 'Fallout4.esm': 100, 'MyMod.esp': 100 },
        winnerColumn: 'Fallout4.esm', winnerValue: 100,
        cellStates: { 'MyMod.esp': 'IdenticalToMaster' },
        conflictAll: 'NoConflict',
      },
    ],
  }],
};

const nestedStructArrayMeta: FieldMetadata = {
  name: 'Container',
  type: 'struct',
  isArray: false,
  validFormKeyTypes: [],
  enumValues: [],
  fields: [
    {
      name: 'Entries',
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
          { name: 'Id', type: 'string', isArray: false, validFormKeyTypes: [], enumValues: [] },
          { name: 'Weight', type: 'int', isArray: false, validFormKeyTypes: [], enumValues: [] },
        ],
      },
    },
  ],
};

const nestedStructArrayResult = {
  conflictAll: 'NoConflict',
  overrides: [
    {
      formKey: '000001:Fallout4.esm', plugin: 'Fallout4.esm',
      loadOrderIndex: 0, isWinner: false, editorId: 'TestNPC',
      fields: [{ metadata: nestedStructArrayMeta, value: { Entries: [{ Id: 'A', Weight: 1 }] } }], conflictThis: 'Master',
    },
    {
      formKey: '000001:Fallout4.esm', plugin: 'MyMod.esp',
      loadOrderIndex: 1, isWinner: true, editorId: 'TestNPC',
      fields: [{ metadata: nestedStructArrayMeta, value: { Entries: [{ Id: 'A', Weight: 1 }] } }], conflictThis: 'IdenticalToMaster',
    },
  ],
  diffs: [{
    fieldName: 'Container',
    values: {
      'Fallout4.esm': { Entries: [{ Id: 'A', Weight: 1 }] },
      'MyMod.esp': { Entries: [{ Id: 'A', Weight: 1 }] },
    },
    winnerColumn: 'Fallout4.esm', winnerValue: { Entries: [{ Id: 'A', Weight: 1 }] },
    cellStates: {},
    children: [{
      fieldName: 'Entries',
      values: { 'Fallout4.esm': [{ Id: 'A', Weight: 1 }], 'MyMod.esp': [{ Id: 'A', Weight: 1 }] },
      winnerColumn: 'Fallout4.esm', winnerValue: [{ Id: 'A', Weight: 1 }],
      cellStates: {},
      children: [{
        fieldName: '[0]',
        values: { 'Fallout4.esm': { Id: 'A', Weight: 1 }, 'MyMod.esp': { Id: 'A', Weight: 1 } },
        winnerColumn: 'Fallout4.esm', winnerValue: { Id: 'A', Weight: 1 },
        cellStates: {},
        children: [
          {
            fieldName: 'Id',
            values: { 'Fallout4.esm': 'A', 'MyMod.esp': 'A' },
            winnerColumn: 'Fallout4.esm', winnerValue: 'A',
            cellStates: {},
          },
          {
            fieldName: 'Weight',
            values: { 'Fallout4.esm': 1, 'MyMod.esp': 1 },
            winnerColumn: 'Fallout4.esm', winnerValue: 1,
            cellStates: {},
          },
        ],
      }],
    }],
  }],
};

let currentCompare: unknown = null;

function fakeClient(): RecordSessionClient {
  return {
    load: vi.fn().mockImplementation(() => Promise.resolve({
      ok: true,
      result: currentCompare,
      immutableSet: new Set(pluginsResponse.filter(p => p.isImmutable).map(p => columnKey(p.name, null))),
      notInLoadOrderSet: new Set(),
      conflictsComputed: true,
    } as unknown as LoadResult)),
    conditionRunOnTargets: vi.fn().mockResolvedValue([]),
  };
}

function renderPanel() {
  const client = fakeClient();
  return { client, ...render(<RecordPanel client={client} />) };
}

describe('RecordPanel — array child rows (sorted)', () => {
  beforeEach(() => {
    vi.stubGlobal('mEditFormKey', '000001:Fallout4.esm');
    currentCompare = sortedArrayCompareResult;
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


describe('RecordPanel — struct row conflict color follows collapse state (#114)', () => {
  beforeEach(() => {
    vi.stubGlobal('mEditFormKey', '000001:Fallout4.esm');
    currentCompare = structCollapseExpandResult;
  });
  afterEach(() => vi.unstubAllGlobals());

  it('collapsed: the struct row shows the aggregate tint from its conflicting child', async () => {
    renderPanel();
    await waitFor(() => screen.getByText('▶'));
    const structRow = screen.getByText('ObjectBounds').closest('tr')!;
    expect(structRow.style.backgroundColor).toBe('rgba(76, 175, 80, 0.20)');
  });

  it('expanded: the struct row loses its own background, and only the differing child is tinted', async () => {
    renderPanel();
    await waitFor(() => screen.getByText('▶'));
    fireEvent.click(screen.getByText('▶'));
    await waitFor(() => screen.getByText('X1'));

    const structRow = screen.getByText('ObjectBounds').closest('tr')!;
    const x1Row = screen.getByText('X1').closest('tr')!;
    const x2Row = screen.getByText('X2').closest('tr')!;
    expect(structRow.style.backgroundColor).toBe('');
    expect(x1Row.style.backgroundColor).toBe('rgba(76, 175, 80, 0.20)');
    expect(x2Row.style.backgroundColor).toBe('');
  });

  it('re-collapsed: the aggregate tint returns to the struct row', async () => {
    renderPanel();
    await waitFor(() => screen.getByText('▶'));
    fireEvent.click(screen.getByText('▶')); // expand
    await waitFor(() => screen.getByText('X1'));
    fireEvent.click(screen.getByText('▼')); // collapse again
    await waitFor(() => expect(screen.queryByText('X1')).not.toBeInTheDocument());

    const structRow = screen.getByText('ObjectBounds').closest('tr')!;
    expect(structRow.style.backgroundColor).toBe('rgba(76, 175, 80, 0.20)');
  });
});


describe('RecordPanel — a struct member that is itself an array of structs (issue #231)', () => {
  beforeEach(() => {
    vi.stubGlobal('mEditFormKey', '000001:Fallout4.esm');
    currentCompare = nestedStructArrayResult;
  });
  afterEach(() => vi.unstubAllGlobals());

  async function expandToDepth4() {
    await waitFor(() => screen.getByText('Container'));
    fireEvent.click(screen.getAllByText('▶')[0]); // expand Container -> Entries
    await waitFor(() => screen.getByText('Entries'));
    fireEvent.click(screen.getAllByText('▶')[0]); // expand Entries -> [0]
    await waitFor(() => {
      const td = screen.getAllByText('[0]').find(el => el.tagName === 'TD');
      if (!td) throw new Error('[0] TD not found yet');
    });
    fireEvent.click(screen.getAllByText('▶')[0]); // expand [0] -> Id/Weight
    await waitFor(() => screen.getByText('Weight'));
  }

  it('renders all four levels: Container, Entries, [0], and its Id/Weight members', async () => {
    renderPanel();
    await expandToDepth4();
    expect(screen.getByText('Container')).toBeInTheDocument();
    expect(screen.getByText('Entries')).toBeInTheDocument();
    expect(screen.getByText('Weight')).toBeInTheDocument();
    expect(screen.getByText('Id')).toBeInTheDocument();
  });

});

// #426 Track 4 (resurrected #142/#227): Add/Remove/Move Up/Move Down on an unsorted array — the
// keyboard accelerators (Insert/Delete/Ctrl+↑/Ctrl+↓) on the focused cell, writing the whole
// array through the exact same write path (EDIT_FIELD) every other gesture uses.
describe('RecordPanel — array editing (unsorted, #426)', () => {
  const intArrayMeta: FieldMetadata = {
    name: 'Values', type: 'array', isArray: true, validFormKeyTypes: [], enumValues: [],
    elementType: { name: '', type: 'int', isArray: false, validFormKeyTypes: [], enumValues: [] },
  };

  const intArrayCompareResult = {
    conflictAll: 'NoConflict',
    overrides: [
      {
        formKey: '000001:Fallout4.esm', plugin: 'MyMod.esp', origin: 'Data',
        loadOrderIndex: 1, isWinner: true, editorId: 'TestNPC',
        fields: [{ metadata: intArrayMeta, value: [1, 2, 3] }], conflictThis: 'Master',
      },
    ],
    diffs: [{
      fieldName: 'Values',
      values: { 'MyMod.esp': [1, 2, 3] },
      winnerColumn: 'MyMod.esp', winnerValue: [1, 2, 3],
      cellStates: {},
      children: [
        { fieldName: '[0]', values: { 'MyMod.esp': 1 }, winnerColumn: 'MyMod.esp', winnerValue: 1, cellStates: {} },
        { fieldName: '[1]', values: { 'MyMod.esp': 2 }, winnerColumn: 'MyMod.esp', winnerValue: 2, cellStates: {} },
        { fieldName: '[2]', values: { 'MyMod.esp': 3 }, winnerColumn: 'MyMod.esp', winnerValue: 3, cellStates: {} },
      ],
    }],
  };

  function fakeEditableClient(): RecordSessionClient {
    return {
      load: vi.fn().mockImplementation(() => Promise.resolve({
        ok: true,
        result: intArrayCompareResult,
        immutableSet: new Set(),
        notInLoadOrderSet: new Set(),
        trackedSet: new Set([columnKey('MyMod.esp', null)]),
        conflictsComputed: true,
      } as unknown as LoadResult)),
      conditionRunOnTargets: vi.fn().mockResolvedValue([]),
    };
  }

  function renderEditablePanel() {
    const client = fakeEditableClient();
    return { client, ...render(<RecordPanel client={client} />) };
  }

  function lastEditFieldValue(): unknown {
    const calls = (vscode.postMessage as ReturnType<typeof vi.fn>).mock.calls;
    const call = [...calls].reverse().find(([m]) => (m as { type?: string }).type === WEBVIEW_TO_EXTENSION.EDIT_FIELD);
    return (call?.[0] as { value?: unknown } | undefined)?.value;
  }

  beforeEach(() => {
    vi.stubGlobal('mEditFormKey', '000001:Fallout4.esm');
    currentCompare = intArrayCompareResult;
    (vscode.postMessage as ReturnType<typeof vi.fn>).mockClear();
  });
  afterEach(() => vi.unstubAllGlobals());

  it('Insert on the focused array-parent cell appends a default element (0)', async () => {
    renderEditablePanel();
    await waitFor(() => screen.getByText('Values'));
    const cell = screen.getAllByText('[3]')[0].closest('td')!;
    fireEvent.click(cell); // focus
    fireEvent.keyDown(cell, { key: 'Insert' });

    expect(lastEditFieldValue()).toEqual([1, 2, 3, 0]);
  });

  it('Delete on a focused array-element cell removes it', async () => {
    renderEditablePanel();
    await waitFor(() => screen.getByText('Values'));
    fireEvent.click(screen.getAllByText('▶')[0]); // expand
    await waitFor(() => screen.getByText('[1]'));
    const cell = screen.getByText('2').closest('td')!;
    fireEvent.click(cell);
    fireEvent.keyDown(cell, { key: 'Delete' });

    expect(lastEditFieldValue()).toEqual([1, 3]);
  });

  it('Ctrl+ArrowDown on a focused array-element cell swaps it with its next neighbour', async () => {
    renderEditablePanel();
    await waitFor(() => screen.getByText('Values'));
    fireEvent.click(screen.getAllByText('▶')[0]);
    await waitFor(() => screen.getByText('[0]'));
    const cell = screen.getByText('1').closest('td')!;
    fireEvent.click(cell);
    fireEvent.keyDown(cell, { key: 'ArrowDown', ctrlKey: true });

    expect(lastEditFieldValue()).toEqual([2, 1, 3]);
  });

  it('Delete on the first element does not corrupt the array when Ctrl+ArrowUp would be a boundary no-op', async () => {
    renderEditablePanel();
    await waitFor(() => screen.getByText('Values'));
    fireEvent.click(screen.getAllByText('▶')[0]);
    await waitFor(() => screen.getByText('[0]'));
    const cell = screen.getByText('1').closest('td')!;
    fireEvent.click(cell);
    fireEvent.keyDown(cell, { key: 'ArrowUp', ctrlKey: true }); // boundary — must no-op

    expect((vscode.postMessage as ReturnType<typeof vi.fn>).mock.calls
      .some(([m]) => (m as { type?: string }).type === WEBVIEW_TO_EXTENSION.EDIT_FIELD)).toBe(false);
  });

  // #426 Track 4: the right-click menu's own trigger — a broadcast from the extension host (no
  // live reference into this panel's React state), self-filtered on formKey, reaching the exact
  // same handleArrayOp computation the keyboard accelerators already use.
  it('an ARRAY_REMOVE broadcast for this open record writes the array via EDIT_FIELD', async () => {
    renderEditablePanel();
    await waitFor(() => screen.getByText('Values'));

    window.postMessage(
      { type: EXTENSION_TO_WEBVIEW.ARRAY_REMOVE, formKey: '000001:Fallout4.esm', plugin: 'MyMod.esp', origin: 'Data', fieldName: 'Values', index: 1 },
      '*',
    );
    await waitFor(() => expect(lastEditFieldValue()).toEqual([1, 3]));
  });

  it('an ARRAY_REMOVE broadcast for a different open record is ignored', async () => {
    renderEditablePanel();
    await waitFor(() => screen.getByText('Values'));

    window.postMessage(
      { type: EXTENSION_TO_WEBVIEW.ARRAY_REMOVE, formKey: '999999:Other.esp', plugin: 'MyMod.esp', origin: 'Data', fieldName: 'Values', index: 1 },
      '*',
    );
    // Give the (synchronous) handler a turn; nothing should have posted.
    await new Promise(r => setTimeout(r, 0));
    expect((vscode.postMessage as ReturnType<typeof vi.fn>).mock.calls
      .some(([m]) => (m as { type?: string }).type === WEBVIEW_TO_EXTENSION.EDIT_FIELD)).toBe(false);
  });
});

// #533: hoisted out of the #503 describe block below (module scope, alongside
// structCollapseExpandResult/nestedStructArrayResult above) so the #533 describe block further
// down — same shapes, different trigger — can share them without duplicating fixtures.
const editableIntArrayMeta: FieldMetadata = {
  name: 'Values', type: 'array', isArray: true, validFormKeyTypes: [], enumValues: [],
  elementType: { name: '', type: 'int', isArray: false, validFormKeyTypes: [], enumValues: [] },
};

const editableIntArrayResult = {
  conflictAll: 'NoConflict',
  overrides: [
    {
      formKey: '000001:Fallout4.esm', plugin: 'MyMod.esp', origin: 'Data',
      loadOrderIndex: 1, isWinner: true, editorId: 'TestNPC',
      fields: [{ metadata: editableIntArrayMeta, value: [11, 22, 33] }], conflictThis: 'Master',
    },
  ],
  diffs: [{
    fieldName: 'Values',
    values: { 'MyMod.esp': [11, 22, 33] },
    winnerColumn: 'MyMod.esp', winnerValue: [11, 22, 33],
    cellStates: {},
    children: [
      { fieldName: '[0]', values: { 'MyMod.esp': 11 }, winnerColumn: 'MyMod.esp', winnerValue: 11, cellStates: {} },
      { fieldName: '[1]', values: { 'MyMod.esp': 22 }, winnerColumn: 'MyMod.esp', winnerValue: 22, cellStates: {} },
      { fieldName: '[2]', values: { 'MyMod.esp': 33 }, winnerColumn: 'MyMod.esp', winnerValue: 33, cellStates: {} },
    ],
  }],
};

const scalarMeta: FieldMetadata = {
  name: 'Level', type: 'int', isArray: false, validFormKeyTypes: [], enumValues: [],
};

const scalarResult = {
  conflictAll: 'NoConflict',
  overrides: [
    {
      formKey: '000001:Fallout4.esm', plugin: 'MyMod.esp', origin: 'Data',
      loadOrderIndex: 1, isWinner: true, editorId: 'TestNPC',
      fields: [{ metadata: scalarMeta, value: 4 }], conflictThis: 'Master',
    },
  ],
  diffs: [{
    fieldName: 'Level',
    values: { 'MyMod.esp': 4 },
    winnerColumn: 'MyMod.esp', winnerValue: 4,
    cellStates: {},
  }],
};

// #503: a *value* edit inside a complex field commits the whole field, exactly as the arity ops
// (Add/Remove/Move, above) always did. CONTEXT.md: a complex field is "always edited as one atomic
// value — a field-level write to the source document, never per-element". Before this, a leaf inside
// an array or struct committed its own bare value under the array's/struct's field name, the backend
// applier silently declined the shape, and the write path reported success — the edit vanished.
describe('RecordPanel — a value edit inside a complex field commits the whole field (#503)', () => {
  function renderEditablePanel() {
    const client: RecordSessionClient = {
      load: vi.fn().mockImplementation(() => Promise.resolve({
        ok: true,
        result: currentCompare,
        immutableSet: new Set(pluginsResponse.filter(p => p.isImmutable).map(p => columnKey(p.name, null))),
        notInLoadOrderSet: new Set(),
        trackedSet: new Set([columnKey('MyMod.esp', null)]),
        conflictsComputed: true,
      } as unknown as LoadResult)),
      conditionRunOnTargets: vi.fn().mockResolvedValue([]),
    };
    return { client, ...render(<RecordPanel client={client} />) };
  }

  function lastEditField(): { fieldPath?: string; value?: unknown } | undefined {
    const calls = (vscode.postMessage as ReturnType<typeof vi.fn>).mock.calls;
    const call = [...calls].reverse().find(([m]) => (m as { type?: string }).type === WEBVIEW_TO_EXTENSION.EDIT_FIELD);
    return call?.[0] as { fieldPath?: string; value?: unknown } | undefined;
  }

  // The editable column is the last one in every fixture here, so a row's own last cell is the one
  // with somewhere to write — addressed by row rather than by value text, since the same number can
  // appear in more than one column (and in a collapsed-array label).
  function editLastCellOfRow(rowLabel: string, shownValue: string, typed: string) {
    const row = screen.getByText(rowLabel).closest('tr')!;
    const cells = row.querySelectorAll('td');
    const cell = cells[cells.length - 1];
    // xEdit's own gesture (ADR-0034): a double click opens the editor on a resting cell.
    fireEvent.doubleClick(within(cell as HTMLElement).getByText(shownValue));
    const input = (cell as HTMLElement).querySelector('input')!;
    fireEvent.change(input, { target: { value: typed } });
    fireEvent.keyDown(input, { key: 'Enter' });
  }

  beforeEach(() => {
    vi.stubGlobal('mEditFormKey', '000001:Fallout4.esm');
    (vscode.postMessage as ReturnType<typeof vi.fn>).mockClear();
  });
  afterEach(() => vi.unstubAllGlobals());

  it('editing one element of an array commits the whole array under the array\'s own field path', async () => {
    currentCompare = editableIntArrayResult;
    renderEditablePanel();
    await waitFor(() => screen.getByText('Values'));
    fireEvent.click(screen.getAllByText('▶')[0]); // expand
    await waitFor(() => screen.getByText('[1]'));

    editLastCellOfRow('[1]', '22', '99');

    expect(lastEditField()?.fieldPath).toBe('Values');
    expect(lastEditField()?.value).toEqual([11, 99, 33]);
  });

  it('editing one member of a struct commits the whole struct', async () => {
    currentCompare = structCollapseExpandResult;
    renderEditablePanel();
    await waitFor(() => screen.getByText('ObjectBounds'));
    fireEvent.click(screen.getAllByText('▶')[0]); // expand
    await waitFor(() => screen.getByText('X1'));

    editLastCellOfRow('X1', '5', '7');

    expect(lastEditField()?.fieldPath).toBe('ObjectBounds');
    expect(lastEditField()?.value).toEqual({ X1: 7, X2: 100 });
  });

  // The shape #503 was reported against (OMOD `Properties[i].step`): the edited leaf is a member of
  // a struct that is itself an element of an array, so reconstruction has to run two hops deep.
  it('editing a sub-field of a struct-element array commits the whole root value', async () => {
    currentCompare = nestedStructArrayResult;
    renderEditablePanel();
    await waitFor(() => screen.getByText('Container'));
    fireEvent.click(screen.getAllByText('▶')[0]);
    await waitFor(() => screen.getByText('Entries'));
    fireEvent.click(screen.getAllByText('▶')[0]);
    await waitFor(() => screen.getAllByText('[0]').find(el => el.tagName === 'TD'));
    fireEvent.click(screen.getAllByText('▶')[0]);
    await waitFor(() => screen.getByText('Weight'));

    editLastCellOfRow('Weight', '1', '7');

    expect(lastEditField()?.fieldPath).toBe('Container');
    expect(lastEditField()?.value).toEqual({ Entries: [{ Id: 'A', Weight: 7 }] });
  });

  // The other half of the same rule: a top-level row *is* the whole field, so its commit is the bare
  // value — nothing to reconstruct, and wrapping it would corrupt every scalar edit in the grid.
  it('editing a top-level scalar still commits the bare value', async () => {
    currentCompare = scalarResult;
    renderEditablePanel();
    await waitFor(() => screen.getByText('Level'));

    editLastCellOfRow('Level', '4', '6');

    expect(lastEditField()?.fieldPath).toBe('Level');
    expect(lastEditField()?.value).toBe(6);
  });
});

// #533: the extended editor's own trigger (right-click → FIELD_OPEN_EXTENDED_EDITOR → a real Ctrl+S
// in the opened tab, simulated here as EXTENDED_EDITOR_COMMITTED per the pattern
// RecordPanel.test.tsx's own extended-editor wiring tests already use) reconstructs the whole
// complex field exactly the way an inline edit already does (#503, above) — before this, it
// committed the saved text alone under the subtree root's own field path, and the backend's #503
// shape guards refused it. Same fixtures, same four shapes as the #503 block above; only the
// trigger differs.
describe('RecordPanel — the extended editor commits the whole field, at any depth (#533)', () => {
  function renderEditablePanel() {
    const client: RecordSessionClient = {
      load: vi.fn().mockImplementation(() => Promise.resolve({
        ok: true,
        result: currentCompare,
        immutableSet: new Set(pluginsResponse.filter(p => p.isImmutable).map(p => columnKey(p.name, null))),
        notInLoadOrderSet: new Set(),
        trackedSet: new Set([columnKey('MyMod.esp', null)]),
        conflictsComputed: true,
      } as unknown as LoadResult)),
      conditionRunOnTargets: vi.fn().mockResolvedValue([]),
    };
    return { client, ...render(<RecordPanel client={client} />) };
  }

  function lastEditField(): { fieldPath?: string; value?: unknown } | undefined {
    const calls = (vscode.postMessage as ReturnType<typeof vi.fn>).mock.calls;
    const call = [...calls].reverse().find(([m]) => (m as { type?: string }).type === WEBVIEW_TO_EXTENSION.EDIT_FIELD);
    return call?.[0] as { fieldPath?: string; value?: unknown } | undefined;
  }

  function lastOpenExtendedEditorRequestId(): string {
    const calls = (vscode.postMessage as ReturnType<typeof vi.fn>).mock.calls;
    const call = [...calls].reverse().find(([m]) => (m as { type?: string }).type === WEBVIEW_TO_EXTENSION.OPEN_EXTENDED_EDITOR);
    return (call?.[0] as { requestId: string }).requestId;
  }

  // Simulates the right-click command's own broadcast (FIELD_OPEN_EXTENDED_EDITOR), then the
  // extension host's reply to a real Ctrl+S in the opened tab (EXTENDED_EDITOR_COMMITTED) — the
  // full round trip RecordPanel.test.tsx's own "opens the extended editor bridge call" test already
  // exercises the open half of.
  function saveThroughExtendedEditor(
    fieldName: string, path: { kind: string; name?: string; index?: number }[], rootField: string, value: string,
  ) {
    act(() => {
      window.dispatchEvent(new MessageEvent('message', {
        data: {
          type: EXTENSION_TO_WEBVIEW.FIELD_OPEN_EXTENDED_EDITOR,
          formKey: '000001:Fallout4.esm', plugin: 'MyMod.esp', origin: 'Data',
          fieldName, value: 'irrelevant seed value', readOnly: false, path, rootField,
        },
      }));
    });
    const requestId = lastOpenExtendedEditorRequestId();
    act(() => {
      window.dispatchEvent(new MessageEvent('message', {
        data: { type: EXTENSION_TO_WEBVIEW.EXTENDED_EDITOR_COMMITTED, requestId, value },
      }));
    });
  }

  beforeEach(() => {
    vi.stubGlobal('mEditFormKey', '000001:Fallout4.esm');
    (vscode.postMessage as ReturnType<typeof vi.fn>).mockClear();
  });
  afterEach(() => vi.unstubAllGlobals());

  it('saving an array element commits the whole array under the array\'s own field path', async () => {
    currentCompare = editableIntArrayResult;
    renderEditablePanel();
    await waitFor(() => screen.getByText('Values'));

    saveThroughExtendedEditor('Values', [{ kind: 'index', index: 1 }], 'Values', '99');

    expect(lastEditField()?.fieldPath).toBe('Values');
    expect(lastEditField()?.value).toEqual([11, '99', 33]);
  });

  it('saving a struct member commits the whole struct', async () => {
    currentCompare = structCollapseExpandResult;
    renderEditablePanel();
    await waitFor(() => screen.getByText('ObjectBounds'));

    saveThroughExtendedEditor('ObjectBounds', [{ kind: 'member', name: 'X1' }], 'ObjectBounds', '7');

    expect(lastEditField()?.fieldPath).toBe('ObjectBounds');
    expect(lastEditField()?.value).toEqual({ X1: '7', X2: 100 });
  });

  // The shape #503/#533 were both reported against (OMOD `Properties[i].step`): the edited leaf is
  // a member of a struct that is itself an element of an array, two hops deep.
  it('saving a sub-field of a struct-element array commits the whole root value', async () => {
    currentCompare = nestedStructArrayResult;
    renderEditablePanel();
    await waitFor(() => screen.getByText('Container'));

    saveThroughExtendedEditor(
      'Container',
      [{ kind: 'member', name: 'Entries' }, { kind: 'index', index: 0 }, { kind: 'member', name: 'Id' }],
      'Container', 'Z',
    );

    expect(lastEditField()?.fieldPath).toBe('Container');
    expect(lastEditField()?.value).toEqual({ Entries: [{ Id: 'Z', Weight: 1 }] });
  });

  // The other half of the same rule (#503's own both-directions pin): a top-level row *is* the
  // whole field, so its commit stays the bare value — no double-wrap.
  it('saving a top-level field still commits the bare value', async () => {
    currentCompare = scalarResult;
    renderEditablePanel();
    await waitFor(() => screen.getByText('Level'));

    saveThroughExtendedEditor('Level', [], 'Level', '6');

    expect(lastEditField()?.fieldPath).toBe('Level');
    expect(lastEditField()?.value).toBe('6');
  });
});
