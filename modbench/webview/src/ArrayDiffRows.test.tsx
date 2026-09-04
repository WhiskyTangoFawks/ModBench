import '@testing-library/jest-dom';
import React from 'react';
import { render, screen, fireEvent, waitFor, within, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('./vscode', () => ({ vscode: { postMessage: vi.fn() } }));

import { RecordPanel } from './RecordPanel';
import type { FieldMetadata } from './types';
import { columnKey } from './types';
import type { LoadResult, RecordPanelClient } from './RecordPanelClient';
import { vscode } from './vscode';
import { WEBVIEW_TO_EXTENSION, EXTENSION_TO_WEBVIEW } from './messages';


const sortedArrayMeta: FieldMetadata = {
  name: 'Keywords',
  type: 'array',
  isArray: true,
  validFormKeyTypes: [],
  enumMembers: [],
  elementType: {
    name: '',
    type: 'formKey',
    isArray: false,
    validFormKeyTypes: [],
    enumMembers: [],
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
  enumMembers: [],
  fields: [
    { name: 'X1', type: 'int', isArray: false, validFormKeyTypes: [], enumMembers: [] },
    { name: 'X2', type: 'int', isArray: false, validFormKeyTypes: [], enumMembers: [] },
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
  enumMembers: [],
  fields: [
    {
      name: 'Entries',
      type: 'array',
      isArray: true,
      validFormKeyTypes: [],
      enumMembers: [],
      elementType: {
        name: '',
        type: 'struct',
        isArray: false,
        validFormKeyTypes: [],
        enumMembers: [],
        fields: [
          { name: 'Id', type: 'string', isArray: false, validFormKeyTypes: [], enumMembers: [] },
          { name: 'Weight', type: 'int', isArray: false, validFormKeyTypes: [], enumMembers: [] },
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

function fakeClient(): RecordPanelClient {
  return {
    load: vi.fn().mockImplementation(() => Promise.resolve({
      ok: true,
      result: currentCompare,
      immutableSet: new Set(pluginsResponse.filter(p => p.isImmutable).map(p => columnKey(p.name, null))),
      notInLoadOrderSet: new Set(),
      conflictsComputed: true,
    } as unknown as LoadResult)),
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

describe('RecordPanel — array editing (unsorted, #426)', () => {
  const intArrayMeta: FieldMetadata = {
    name: 'Values', type: 'array', isArray: true, validFormKeyTypes: [], enumMembers: [],
    elementType: { name: '', type: 'int', isArray: false, validFormKeyTypes: [], enumMembers: [] },
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

  function fakeEditableClient(): RecordPanelClient {
    return {
      load: vi.fn().mockImplementation(() => Promise.resolve({
        ok: true,
        result: intArrayCompareResult,
        immutableSet: new Set(),
        notInLoadOrderSet: new Set(),
        trackedSet: new Set([columnKey('MyMod.esp', null)]),
        conflictsComputed: true,
      } as unknown as LoadResult)),
    };
  }

  function renderEditablePanel() {
    const client = fakeEditableClient();
    return { client, ...render(<RecordPanel client={client} />) };
  }

  function lastEditField(): { fieldPath?: string; value?: unknown } | undefined {
    const calls = (vscode.postMessage as ReturnType<typeof vi.fn>).mock.calls;
    const call = [...calls].reverse().find(([m]) => (m as { type?: string }).type === WEBVIEW_TO_EXTENSION.EDIT_FIELD);
    return call?.[0] as { fieldPath?: string; value?: unknown } | undefined;
  }

  beforeEach(() => {
    vi.stubGlobal('mEditFormKey', '000001:Fallout4.esm');
    currentCompare = intArrayCompareResult;
    (vscode.postMessage as ReturnType<typeof vi.fn>).mockClear();
  });
  afterEach(() => vi.unstubAllGlobals());

  // The next array is computed server-side from the record's own value and schema; the
  // accelerators own only which op envelope is posted under the field's fieldPath.

  it('Insert on the focused array-parent cell posts an array_add envelope', async () => {
    renderEditablePanel();
    await waitFor(() => screen.getByText('Values'));
    const cell = screen.getAllByText('[3]')[0].closest('td')!;
    fireEvent.click(cell); // focus
    fireEvent.keyDown(cell, { key: 'Insert' });

    expect(lastEditField()?.fieldPath).toBe('Values');
    expect(lastEditField()?.value).toEqual({ op: 'array_add', path: [] });
  });

  it('Delete on a focused array-element cell posts an array_remove envelope at its own index', async () => {
    renderEditablePanel();
    await waitFor(() => screen.getByText('Values'));
    fireEvent.click(screen.getAllByText('▶')[0]); // expand
    await waitFor(() => screen.getByText('[1]'));
    const cell = screen.getByText('2').closest('td')!;
    fireEvent.click(cell);
    fireEvent.keyDown(cell, { key: 'Delete' });

    expect(lastEditField()?.fieldPath).toBe('Values');
    expect(lastEditField()?.value).toEqual({ op: 'array_remove', path: [{ kind: 'index', index: 1 }] });
  });

  it('Ctrl+ArrowDown on a focused array-element cell posts an array_move_down envelope at its own index', async () => {
    renderEditablePanel();
    await waitFor(() => screen.getByText('Values'));
    fireEvent.click(screen.getAllByText('▶')[0]);
    await waitFor(() => screen.getByText('[0]'));
    const cell = screen.getByText('1').closest('td')!;
    fireEvent.click(cell);
    fireEvent.keyDown(cell, { key: 'ArrowDown', ctrlKey: true });

    expect(lastEditField()?.fieldPath).toBe('Values');
    expect(lastEditField()?.value).toEqual({ op: 'array_move_down', path: [{ kind: 'index', index: 0 }] });
  });

  it('an ARRAY_STRUCTURAL_OP broadcast for this open record posts the op envelope via EDIT_FIELD', async () => {
    renderEditablePanel();
    await waitFor(() => screen.getByText('Values'));

    window.postMessage(
      {
        type: EXTENSION_TO_WEBVIEW.ARRAY_STRUCTURAL_OP, formKey: '000001:Fallout4.esm', plugin: 'MyMod.esp', origin: 'Data',
        rootField: 'Values', path: [{ kind: 'index', index: 1 }], op: 'remove',
      },
      '*',
    );
    await waitFor(() => expect(lastEditField()?.fieldPath).toBe('Values'));
    expect(lastEditField()?.value).toEqual({ op: 'array_remove', path: [{ kind: 'index', index: 1 }] });
  });

  it('an ARRAY_STRUCTURAL_OP broadcast for a different open record is ignored', async () => {
    renderEditablePanel();
    await waitFor(() => screen.getByText('Values'));

    window.postMessage(
      {
        type: EXTENSION_TO_WEBVIEW.ARRAY_STRUCTURAL_OP, formKey: '999999:Other.esp', plugin: 'MyMod.esp', origin: 'Data',
        rootField: 'Values', path: [{ kind: 'index', index: 1 }], op: 'remove',
      },
      '*',
    );
    // Give the (synchronous) handler a turn; nothing should have posted.
    await new Promise(r => setTimeout(r, 0));
    expect((vscode.postMessage as ReturnType<typeof vi.fn>).mock.calls
      .some(([m]) => (m as { type?: string }).type === WEBVIEW_TO_EXTENSION.EDIT_FIELD)).toBe(false);
  });
});

// Module scope: the inline-edit and extended-editor blocks below share these fixtures.
const editableIntArrayMeta: FieldMetadata = {
  name: 'Values', type: 'array', isArray: true, validFormKeyTypes: [], enumMembers: [],
  elementType: { name: '', type: 'int', isArray: false, validFormKeyTypes: [], enumMembers: [] },
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
  name: 'Level', type: 'int', isArray: false, validFormKeyTypes: [], enumMembers: [],
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

// A complex field is always edited as one atomic value: a leaf committing its own bare value
// under the array's or struct's field name is silently declined by the backend applier.
describe('RecordPanel — a value edit inside a complex field commits the whole field (#503)', () => {
  function renderEditablePanel() {
    const client: RecordPanelClient = {
      load: vi.fn().mockImplementation(() => Promise.resolve({
        ok: true,
        result: currentCompare,
        immutableSet: new Set(pluginsResponse.filter(p => p.isImmutable).map(p => columnKey(p.name, null))),
        notInLoadOrderSet: new Set(),
        trackedSet: new Set([columnKey('MyMod.esp', null)]),
        conflictsComputed: true,
      } as unknown as LoadResult)),
    };
    return { client, ...render(<RecordPanel client={client} />) };
  }

  function lastEditField(): { fieldPath?: string; value?: unknown } | undefined {
    const calls = (vscode.postMessage as ReturnType<typeof vi.fn>).mock.calls;
    const call = [...calls].reverse().find(([m]) => (m as { type?: string }).type === WEBVIEW_TO_EXTENSION.EDIT_FIELD);
    return call?.[0] as { fieldPath?: string; value?: unknown } | undefined;
  }

  // The same number can appear in more than one column, so the editable last cell is addressed
  // by row rather than by value text.
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

  // OMOD `Properties[i].step` shape: the leaf sits two hops deep, so reconstruction runs twice.
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

// Committing the saved text alone under the subtree root's own field path would be refused by
// the backend's shape guards.
describe('RecordPanel — the extended editor commits the whole field, at any depth (#533)', () => {
  function renderEditablePanel() {
    const client: RecordPanelClient = {
      load: vi.fn().mockImplementation(() => Promise.resolve({
        ok: true,
        result: currentCompare,
        immutableSet: new Set(pluginsResponse.filter(p => p.isImmutable).map(p => columnKey(p.name, null))),
        notInLoadOrderSet: new Set(),
        trackedSet: new Set([columnKey('MyMod.esp', null)]),
        conflictsComputed: true,
      } as unknown as LoadResult)),
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

  // OMOD `Properties[i].step` shape: the leaf sits two hops deep.
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

  // The other half of the same rule: a top-level row *is* the
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

// One row's path is shared by every column, so a keyed array's path addresses the element by
// key and each column resolves it against its own array — the same key, two positions.
describe('RecordPanel — a keyed array\'s element is addressed by key, per column (#716)', () => {
  const scriptMeta: FieldMetadata = {
    name: 'Scripts', type: 'array', isArray: true, validFormKeyTypes: [], enumMembers: [],
    keyMembers: ['name'],
    elementType: {
      name: '', type: 'struct', isArray: false, validFormKeyTypes: [], enumMembers: [],
      fields: [
        { name: 'name', type: 'string', isArray: false, validFormKeyTypes: [], enumMembers: [] },
        { name: 'flags', type: 'string', isArray: false, validFormKeyTypes: [], enumMembers: [] },
      ],
    },
  };

  const master = [{ name: 'Guard', flags: 'm' }];
  const override = [{ name: 'Ambush', flags: 'a' }, { name: 'Guard', flags: 'g' }];

  const keyedResult = {
    conflictAll: 'Override',
    overrides: [
      {
        formKey: '000001:Fallout4.esm', plugin: 'Fallout4.esm', origin: 'Data',
        loadOrderIndex: 0, isWinner: false, editorId: 'TestNPC',
        fields: [{ metadata: scriptMeta, value: master }], conflictThis: 'Master',
      },
      {
        formKey: '000001:Fallout4.esm', plugin: 'MyMod.esp', origin: 'Data',
        loadOrderIndex: 1, isWinner: true, editorId: 'TestNPC',
        fields: [{ metadata: scriptMeta, value: override }], conflictThis: 'Override',
      },
    ],
    diffs: [{
      fieldName: 'Scripts',
      values: { 'Fallout4.esm': master, 'MyMod.esp': override },
      winnerColumn: 'MyMod.esp', winnerValue: override,
      cellStates: {},
      children: [
        {
          fieldName: 'Ambush',
          values: { 'MyMod.esp': override[0] },
          winnerColumn: 'MyMod.esp', winnerValue: override[0], cellStates: {},
          children: [
            { fieldName: 'name', values: { 'MyMod.esp': 'Ambush' }, winnerColumn: 'MyMod.esp', winnerValue: 'Ambush', cellStates: {} },
            { fieldName: 'flags', values: { 'MyMod.esp': 'a' }, winnerColumn: 'MyMod.esp', winnerValue: 'a', cellStates: {} },
          ],
        },
        {
          fieldName: 'Guard',
          values: { 'Fallout4.esm': master[0], 'MyMod.esp': override[1] },
          winnerColumn: 'MyMod.esp', winnerValue: override[1], cellStates: {},
          children: [
            { fieldName: 'name', values: { 'Fallout4.esm': 'Guard', 'MyMod.esp': 'Guard' }, winnerColumn: 'MyMod.esp', winnerValue: 'Guard', cellStates: {} },
            { fieldName: 'flags', values: { 'Fallout4.esm': 'm', 'MyMod.esp': 'g' }, winnerColumn: 'MyMod.esp', winnerValue: 'g', cellStates: {} },
          ],
        },
      ],
    }],
  };

  function renderEditablePanel() {
    const client: RecordPanelClient = {
      load: vi.fn().mockImplementation(() => Promise.resolve({
        ok: true,
        result: keyedResult,
        immutableSet: new Set([columnKey('Fallout4.esm', null)]),
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
    vi.stubGlobal('mEditFormKey', '000001:Fallout4.esm');
    (vscode.postMessage as ReturnType<typeof vi.fn>).mockClear();
  });
  afterEach(() => vi.unstubAllGlobals());

  async function expandTo(label: string) {
    renderEditablePanel();
    await waitFor(() => screen.getByText('Scripts'));
    fireEvent.click(screen.getByText('Scripts').closest('tr')!.querySelector('button')!);
    await waitFor(() => screen.getByText(label));
    // The row's own label cell comes first; once expanded, the key text also appears as the value
    // of the element's own `name` member.
    fireEvent.click(screen.getAllByText(label)[0].closest('tr')!.querySelector('button')!);
    await waitFor(() => screen.getAllByText('flags'));
  }

  // `Guard` is element 1 in the column being written and element 0 in the master. Addressing it
  // by index parses NaN, and JSON.stringify drops that property, posting the array unchanged.
  it('a value edit on a keyed element writes that element, at its own position in this column', async () => {
    await expandTo('Guard');
    const row = screen.getAllByText('flags')[0].closest('tr')!;
    const cells = row.querySelectorAll('td');
    const cell = cells[cells.length - 1] as HTMLElement;
    fireEvent.doubleClick(within(cell).getByText('g'));
    const input = cell.querySelector('input')!;
    fireEvent.change(input, { target: { value: 'EDITED' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(lastEditField()?.fieldPath).toBe('Scripts');
    expect(lastEditField()?.value).toEqual([{ name: 'Ambush', flags: 'a' }, { name: 'Guard', flags: 'EDITED' }]);
  });

  // Delete on the focused element cell posts the op envelope naming the element by key — an index
  // could not name it, since the two columns hold it in different places.
  it('Delete on a keyed element posts an array_remove naming the key', async () => {
    await expandTo('Guard');
    const row = screen.getAllByText('Guard')[0].closest('tr')!;
    const cells = row.querySelectorAll('td');
    const cell = cells[cells.length - 1] as HTMLElement;
    fireEvent.click(cell);
    fireEvent.keyDown(cell, { key: 'Delete' });

    expect(lastEditField()?.value).toEqual({
      op: 'array_remove',
      path: [{ kind: 'key', key: 'Guard', members: ['name'] }],
    });
  });
});
