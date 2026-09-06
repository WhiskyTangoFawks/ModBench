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

  // An element the column does not carry is nothing there — not a null link, which reads "—".
  it('KwdB child row is empty for MyMod.esp, whose array has no such element', async () => {
    renderPanel();
    await waitFor(() => screen.getByText('▶'));
    fireEvent.click(screen.getByText('▶'));
    await waitFor(() => screen.getAllByText('KwdB').length > 0);
    const kwdBTd = screen.getAllByText('KwdB').find(el => el.tagName === 'TD');
    expect(kwdBTd).toBeTruthy();
    const cells = kwdBTd!.closest('tr')!.querySelectorAll('td');
    expect(cells[1].textContent).toBe('KwdB');
    expect(cells[2].textContent).toBe('');
    expect(cells[2].querySelector('[data-open-trigger]')).toBeNull();
  });
});


describe('RecordPanel — struct row conflict color follows collapse state', () => {
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


describe('RecordPanel — a struct member that is itself an array of structs', () => {
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

// Every gesture posts one envelope: an operation, the hops from the record's own member down to
// the row, and a value where the operation takes one. The backend resolves the hops against the
// document it holds.
type Envelope = { op: string; path: unknown[]; value?: unknown };

function lastEnvelope(): Envelope | undefined {
  const calls = (vscode.postMessage as ReturnType<typeof vi.fn>).mock.calls;
  const call = [...calls].reverse().find(([m]) => (m as { type?: string }).type === WEBVIEW_TO_EXTENSION.EDIT_FIELD);
  return (call?.[0] as { envelope?: Envelope } | undefined)?.envelope;
}

const member = (name: string) => ({ kind: 'member', name });
const at = (index: number) => ({ kind: 'index', index });
const keyed = (key: string) => ({ kind: 'key', key });

describe('RecordPanel — array editing (unsorted)', () => {
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

  beforeEach(() => {
    vi.stubGlobal('mEditFormKey', '000001:Fallout4.esm');
    currentCompare = intArrayCompareResult;
    (vscode.postMessage as ReturnType<typeof vi.fn>).mockClear();
  });
  afterEach(() => vi.unstubAllGlobals());

  it('Insert on the focused array-parent cell posts add at the array, carrying no value', async () => {
    renderEditablePanel();
    await waitFor(() => screen.getByText('Values'));
    const cell = screen.getAllByText('[3]')[0].closest('td')!;
    fireEvent.click(cell); // focus
    fireEvent.keyDown(cell, { key: 'Insert' });

    expect(lastEnvelope()).toEqual({ op: 'add', path: [member('Values')] });
    expect(lastEnvelope()).not.toHaveProperty('value');
  });

  it('Delete on a focused array-element cell posts remove at its own index', async () => {
    renderEditablePanel();
    await waitFor(() => screen.getByText('Values'));
    fireEvent.click(screen.getAllByText('▶')[0]); // expand
    await waitFor(() => screen.getByText('[1]'));
    const cell = screen.getByText('2').closest('td')!;
    fireEvent.click(cell);
    fireEvent.keyDown(cell, { key: 'Delete' });

    expect(lastEnvelope()).toEqual({ op: 'remove', path: [member('Values'), at(1)] });
  });

  it('Ctrl+ArrowDown on a focused element posts move with the next position as its value', async () => {
    renderEditablePanel();
    await waitFor(() => screen.getByText('Values'));
    fireEvent.click(screen.getAllByText('▶')[0]);
    await waitFor(() => screen.getByText('[0]'));
    const cell = screen.getByText('1').closest('td')!;
    fireEvent.click(cell);
    fireEvent.keyDown(cell, { key: 'ArrowDown', ctrlKey: true });

    expect(lastEnvelope()).toEqual({ op: 'move', path: [member('Values'), at(0)], value: 1 });
  });

  it('Ctrl+ArrowUp on a focused element posts move with the previous position as its value', async () => {
    renderEditablePanel();
    await waitFor(() => screen.getByText('Values'));
    fireEvent.click(screen.getAllByText('▶')[0]);
    await waitFor(() => screen.getByText('[2]'));
    const cell = screen.getByText('3').closest('td')!;
    fireEvent.click(cell);
    fireEvent.keyDown(cell, { key: 'ArrowUp', ctrlKey: true });

    expect(lastEnvelope()).toEqual({ op: 'move', path: [member('Values'), at(2)], value: 1 });
  });

  // The webview posts what the user asked for; a move off either end is the backend's to refuse
  // by name (ADR-0032), not a boundary this side answers.
  it('Ctrl+ArrowUp on the first element still posts the move, to the position before it', async () => {
    renderEditablePanel();
    await waitFor(() => screen.getByText('Values'));
    fireEvent.click(screen.getAllByText('▶')[0]);
    await waitFor(() => screen.getByText('[0]'));
    const cell = screen.getByText('1').closest('td')!;
    fireEvent.click(cell);
    fireEvent.keyDown(cell, { key: 'ArrowUp', ctrlKey: true });

    expect(lastEnvelope()).toEqual({ op: 'move', path: [member('Values'), at(0)], value: -1 });
  });

});

// Module scope: the inline-edit blocks below share these fixtures.
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

describe('RecordPanel — a value edit posts one set envelope addressing the leaf', () => {
  beforeEach(() => {
    vi.stubGlobal('mEditFormKey', '000001:Fallout4.esm');
    (vscode.postMessage as ReturnType<typeof vi.fn>).mockClear();
  });
  afterEach(() => vi.unstubAllGlobals());

  it('an array element: the array member, then the element by position', async () => {
    currentCompare = editableIntArrayResult;
    renderEditablePanel();
    await waitFor(() => screen.getByText('Values'));
    fireEvent.click(screen.getAllByText('▶')[0]); // expand
    await waitFor(() => screen.getByText('[1]'));

    editLastCellOfRow('[1]', '22', '99');

    expect(lastEnvelope()).toEqual({ op: 'set', path: [member('Values'), at(1)], value: 99 });
  });

  it('a struct member: the struct, then the member by name', async () => {
    currentCompare = structCollapseExpandResult;
    renderEditablePanel();
    await waitFor(() => screen.getByText('ObjectBounds'));
    fireEvent.click(screen.getAllByText('▶')[0]); // expand
    await waitFor(() => screen.getByText('X1'));

    editLastCellOfRow('X1', '5', '7');

    expect(lastEnvelope()).toEqual({ op: 'set', path: [member('ObjectBounds'), member('X1')], value: 7 });
  });

  // OMOD `Properties[i].step` shape: the leaf sits two hops deep, and every hop travels.
  it('a member of a struct element inside a struct: every hop from the record down', async () => {
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

    expect(lastEnvelope()).toEqual({
      op: 'set', path: [member('Container'), member('Entries'), at(0), member('Weight')], value: 7,
    });
  });

  it('Delete on an element nested inside a struct posts remove with every hop', async () => {
    currentCompare = nestedStructArrayResult;
    renderEditablePanel();
    await waitFor(() => screen.getByText('Container'));
    fireEvent.click(screen.getAllByText('▶')[0]);
    await waitFor(() => screen.getByText('Entries'));
    fireEvent.click(screen.getAllByText('▶')[0]);
    await waitFor(() => screen.getAllByText('[0]').find(el => el.tagName === 'TD'));

    const row = screen.getAllByText('[0]').find(el => el.tagName === 'TD')!.closest('tr')!;
    const cells = row.querySelectorAll('td');
    const cell = cells[cells.length - 1] as HTMLElement;
    fireEvent.click(cell);
    fireEvent.keyDown(cell, { key: 'Delete' });

    expect(lastEnvelope()).toEqual({ op: 'remove', path: [member('Container'), member('Entries'), at(0)] });
  });

  it('Ctrl+ArrowDown on an element nested inside a struct posts move with every hop', async () => {
    currentCompare = nestedStructArrayResult;
    renderEditablePanel();
    await waitFor(() => screen.getByText('Container'));
    fireEvent.click(screen.getAllByText('▶')[0]);
    await waitFor(() => screen.getByText('Entries'));
    fireEvent.click(screen.getAllByText('▶')[0]);
    await waitFor(() => screen.getAllByText('[0]').find(el => el.tagName === 'TD'));

    const row = screen.getAllByText('[0]').find(el => el.tagName === 'TD')!.closest('tr')!;
    const cells = row.querySelectorAll('td');
    const cell = cells[cells.length - 1] as HTMLElement;
    fireEvent.click(cell);
    fireEvent.keyDown(cell, { key: 'ArrowDown', ctrlKey: true });

    expect(lastEnvelope()).toEqual({ op: 'move', path: [member('Container'), member('Entries'), at(0)], value: 1 });
  });

  it('a top-level scalar: the one member hop', async () => {
    currentCompare = scalarResult;
    renderEditablePanel();
    await waitFor(() => screen.getByText('Level'));

    editLastCellOfRow('Level', '4', '6');

    expect(lastEnvelope()).toEqual({ op: 'set', path: [member('Level')], value: 6 });
  });

  // The message carries the column's compound identity beside the envelope, nothing else.
  it('the message names the record and the column, and carries the envelope alone', async () => {
    currentCompare = scalarResult;
    renderEditablePanel();
    await waitFor(() => screen.getByText('Level'));

    editLastCellOfRow('Level', '4', '6');

    const calls = (vscode.postMessage as ReturnType<typeof vi.fn>).mock.calls;
    const posted = [...calls].reverse().find(([m]) => (m as { type?: string }).type === WEBVIEW_TO_EXTENSION.EDIT_FIELD)![0];
    expect(posted).toEqual({
      type: WEBVIEW_TO_EXTENSION.EDIT_FIELD, formKey: '000001:Fallout4.esm', plugin: 'MyMod.esp', origin: 'Data',
      envelope: { op: 'set', path: [member('Level')], value: 6 },
    });
  });
});

// One row's path is shared by every column, so a keyed array's element is addressed by the key
// text the diff node states, and the backend finds it in each column's own array.
describe('RecordPanel — a keyed array\'s element is addressed by key', () => {
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

  function renderKeyedPanel() {
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

  beforeEach(() => {
    vi.stubGlobal('mEditFormKey', '000001:Fallout4.esm');
    (vscode.postMessage as ReturnType<typeof vi.fn>).mockClear();
  });
  afterEach(() => vi.unstubAllGlobals());

  async function expandTo(label: string) {
    renderKeyedPanel();
    await waitFor(() => screen.getByText('Scripts'));
    fireEvent.click(screen.getByText('Scripts').closest('tr')!.querySelector('button')!);
    await waitFor(() => screen.getByText(label));
    // The row's own label cell comes first; once expanded, the key text also appears as the value
    // of the element's own `name` member.
    fireEvent.click(screen.getAllByText(label)[0].closest('tr')!.querySelector('button')!);
    await waitFor(() => screen.getAllByText('flags'));
  }

  // `Guard` is element 1 in the column being written and element 0 in the master; the key names
  // it in both, where a position could name only one.
  it('a value edit on a keyed element posts set through the key hop', async () => {
    await expandTo('Guard');
    const row = screen.getAllByText('flags')[0].closest('tr')!;
    const cells = row.querySelectorAll('td');
    const cell = cells[cells.length - 1] as HTMLElement;
    fireEvent.doubleClick(within(cell).getByText('g'));
    const input = cell.querySelector('input')!;
    fireEvent.change(input, { target: { value: 'EDITED' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(lastEnvelope()).toEqual({
      op: 'set', path: [member('Scripts'), keyed('Guard'), member('flags')], value: 'EDITED',
    });
  });

  it('Delete on a keyed element posts remove naming the key', async () => {
    await expandTo('Guard');
    const row = screen.getAllByText('Guard')[0].closest('tr')!;
    const cells = row.querySelectorAll('td');
    const cell = cells[cells.length - 1] as HTMLElement;
    fireEvent.click(cell);
    fireEvent.keyDown(cell, { key: 'Delete' });

    expect(lastEnvelope()).toEqual({ op: 'remove', path: [member('Scripts'), keyed('Guard')] });
  });

  // The backend spells a key from the element's declared defaults, so an element omitting a key
  // member is labelled "10 / 0"; the row posts that text as stated, never a respelling of its own.
  it('posts the key text the diff node states, not one read off the element', async () => {
    const fragmentsMeta: FieldMetadata = {
      name: 'Fragments', type: 'array', isArray: true, validFormKeyTypes: [], enumMembers: [],
      keyMembers: ['Stage', 'StageIndex'],
      elementType: {
        name: '', type: 'struct', isArray: false, validFormKeyTypes: [], enumMembers: [],
        fields: [
          { name: 'Stage', type: 'int', isArray: false, validFormKeyTypes: [], enumMembers: [] },
          { name: 'StageIndex', type: 'int', isArray: false, validFormKeyTypes: [], enumMembers: [] },
        ],
      },
    };
    const element = { Stage: 10 };
    const client: RecordPanelClient = {
      load: vi.fn().mockImplementation(() => Promise.resolve({
        ok: true,
        result: {
          conflictAll: 'OnlyOne',
          overrides: [{
            formKey: '000001:Fallout4.esm', plugin: 'MyMod.esp', origin: 'Data', loadOrderIndex: 1, isWinner: true,
            editorId: 'TestNPC', fields: [{ metadata: fragmentsMeta, value: [element] }], conflictThis: 'OnlyOne',
          }],
          diffs: [{
            fieldName: 'Fragments', values: { 'MyMod.esp': [element] }, winnerColumn: 'MyMod.esp', winnerValue: [element],
            cellStates: {},
            children: [{
              fieldName: '10 / 0', values: { 'MyMod.esp': element }, winnerColumn: 'MyMod.esp', winnerValue: element,
              cellStates: {},
              children: [{ fieldName: 'Stage', values: { 'MyMod.esp': 10 }, winnerColumn: 'MyMod.esp', winnerValue: 10, cellStates: {} }],
            }],
          }],
        },
        immutableSet: new Set(), notInLoadOrderSet: new Set(),
        trackedSet: new Set([columnKey('MyMod.esp', null)]), conflictsComputed: true,
      } as unknown as LoadResult)),
    };
    render(<RecordPanel client={client} />);
    await waitFor(() => screen.getByText('Fragments'));
    fireEvent.click(screen.getByText('Fragments').closest('tr')!.querySelector('button')!);
    await waitFor(() => screen.getByText('10 / 0'));
    const cell = screen.getByText('10 / 0').closest('tr')!.querySelectorAll('td')[1] as HTMLElement;
    fireEvent.click(cell);
    fireEvent.keyDown(cell, { key: 'Delete' });

    expect(lastEnvelope()).toEqual({ op: 'remove', path: [member('Fragments'), keyed('10 / 0')] });
  });

  // A keyed array is stored in key order, so no Move could change the file: the accelerator is
  // inert on its rows.
  it('Ctrl+ArrowDown on a keyed element posts nothing', async () => {
    await expandTo('Guard');
    const row = screen.getAllByText('Guard')[0].closest('tr')!;
    const cells = row.querySelectorAll('td');
    const cell = cells[cells.length - 1] as HTMLElement;
    fireEvent.click(cell);
    fireEvent.keyDown(cell, { key: 'ArrowDown', ctrlKey: true });

    expect(lastEnvelope()).toBeUndefined();
  });
});

// A pure-FormLink array is sorted by its own values, so an element sits at a different position in
// every column; the hop is that position in the column being written.
describe('RecordPanel — an element of a sorted array is addressed at its position in this column', () => {
  const sortedPlugins = [
    { name: 'Fallout4.esm', isImmutable: true, loadOrderIndex: 0 },
    { name: 'MyMod.esp', isImmutable: false, loadOrderIndex: 1 },
  ];

  function renderSortedPanel() {
    const client: RecordPanelClient = {
      load: vi.fn().mockImplementation(() => Promise.resolve({
        ok: true,
        result: sortedArrayCompareResult,
        immutableSet: new Set(sortedPlugins.filter(p => p.isImmutable).map(p => columnKey(p.name, null))),
        notInLoadOrderSet: new Set(),
        trackedSet: new Set([columnKey('MyMod.esp', null)]),
        conflictsComputed: true,
      } as unknown as LoadResult)),
    };
    return render(<RecordPanel client={client} />);
  }

  beforeEach(() => {
    vi.stubGlobal('mEditFormKey', '000001:Fallout4.esm');
    (vscode.postMessage as ReturnType<typeof vi.fn>).mockClear();
  });
  afterEach(() => vi.unstubAllGlobals());

  it('a picked replacement posts set at the value\'s own index in the written column', async () => {
    renderSortedPanel();
    await waitFor(() => screen.getByText('Keywords'));
    fireEvent.click(screen.getByText('▶'));
    await waitFor(() => screen.getAllByText('KwdC').length > 0);

    // KwdC is element 1 of MyMod.esp's own ['KwdA', 'KwdC'].
    const row = screen.getAllByText('KwdC').find(el => el.tagName === 'TD')!.closest('tr')!;
    const cells = row.querySelectorAll('td');
    const cell = cells[cells.length - 1] as HTMLElement;
    fireEvent.click(cell);
    fireEvent.doubleClick(within(cell).getByText('KwdC'));

    // The native QuickPick answers through the bridge; this is its reply.
    const calls = (vscode.postMessage as ReturnType<typeof vi.fn>).mock.calls;
    const request = [...calls].reverse()
      .find(([m]) => (m as { type?: string }).type === WEBVIEW_TO_EXTENSION.OPEN_FORM_KEY_PICKER)![0] as { requestId: string };
    act(() => {
      window.dispatchEvent(new MessageEvent('message', {
        data: { type: EXTENSION_TO_WEBVIEW.FORM_KEY_PICKED, requestId: request.requestId, formKey: '000123:Fallout4.esm' },
      }));
    });

    await waitFor(() => expect(lastEnvelope()).toEqual({
      op: 'set', path: [member('Keywords'), at(1)], value: '000123:Fallout4.esm',
    }));
  });
});
