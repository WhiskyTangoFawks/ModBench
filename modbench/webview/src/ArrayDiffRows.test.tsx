import '@testing-library/jest-dom';
import React from 'react';
import { render, screen, fireEvent, waitFor, within, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('./vscode', () => ({ vscode: { postMessage: vi.fn() } }));

import { RecordPanel } from './RecordPanel';
import { vscode } from './vscode';
import { WEBVIEW_TO_EXTENSION, EXTENSION_TO_WEBVIEW, type WebviewToExtension } from './messages';
import { at, fieldMeta, keyed, lastPostedEnvelope, member, panelClient } from './test/fixtures';

const lastEnvelope = () => lastPostedEnvelope(vscode.postMessage);

// A miss here is a fixture bug, named at the point it would otherwise become a bare TypeError.
function required<T>(value: T | null | undefined, what: string): T {
  if (value === null || value === undefined) throw new Error(`expected ${what}`);
  return value;
}


const sortedArrayMeta = fieldMeta({
  name: 'Keywords',
  type: 'array',
  isArray: true,
  elementType: fieldMeta({ name: '', type: 'formKey' }),
});

// A decoy ahead of the array in every column's field list: the wire path has to be resolved
// against the root field's own value, which "the first field" would only accidentally be.
const decoyMeta = fieldMeta({ name: 'Level', type: 'int' });

const pluginsResponse = [
  { name: 'Fallout4.esm', isImmutable: true },
  { name: 'MyMod.esp' },
];

const sortedArrayCompareResult = {
  conflictAll: 'Override',
  overrides: [
    {
      formKey: '000001:Fallout4.esm', plugin: 'Fallout4.esm',
      loadOrderIndex: 0, isWinner: false, editorId: 'TestNPC',
      fields: [{ metadata: decoyMeta, value: 4 }, { metadata: sortedArrayMeta, value: ['KwdA', 'KwdB'] }],
      conflictThis: 'Master',
    },
    {
      formKey: '000001:Fallout4.esm', plugin: 'MyMod.esp',
      loadOrderIndex: 1, isWinner: true, editorId: 'TestNPC',
      fields: [{ metadata: decoyMeta, value: 4 }, { metadata: sortedArrayMeta, value: ['KwdA', 'KwdC'] }],
      conflictThis: 'Override',
    },
  ],
  diffs: [{
    fieldName: 'Keywords',
    values: { 'Fallout4.esm': ['KwdA', 'KwdB'], 'MyMod.esp': ['KwdA', 'KwdC'] },
    winnerColumn: 'MyMod.esp',
    cellStates: { 'MyMod.esp': 'Override' },
    children: [
      {
        fieldName: 'KwdA',
        values: { 'Fallout4.esm': 'KwdA', 'MyMod.esp': 'KwdA' },
        winnerColumn: 'Fallout4.esm',
        cellStates: { 'MyMod.esp': 'IdenticalToMaster' },
      },
      {
        fieldName: 'KwdB',
        values: { 'Fallout4.esm': 'KwdB', 'MyMod.esp': null },
        winnerColumn: 'Fallout4.esm',
        cellStates: {},
      },
      {
        fieldName: 'KwdC',
        values: { 'Fallout4.esm': null, 'MyMod.esp': 'KwdC' },
        winnerColumn: 'MyMod.esp',
        cellStates: { 'MyMod.esp': 'Override' },
      },
    ],
  }],
};

const structMeta = fieldMeta({
  name: 'ObjectBounds',
  type: 'struct',
  fields: [fieldMeta({ name: 'X1', type: 'int' }), fieldMeta({ name: 'X2', type: 'int' })],
});

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
    winnerColumn: 'MyMod.esp',
    cellStates: { 'MyMod.esp': 'Override' },
    conflictAll: 'Override',
    children: [
      {
        fieldName: 'X1',
        values: { 'Fallout4.esm': 0, 'MyMod.esp': 5 },
        winnerColumn: 'MyMod.esp',
        cellStates: { 'MyMod.esp': 'Override' },
        conflictAll: 'Override',
      },
      {
        fieldName: 'X2',
        values: { 'Fallout4.esm': 100, 'MyMod.esp': 100 },
        winnerColumn: 'Fallout4.esm',
        cellStates: { 'MyMod.esp': 'IdenticalToMaster' },
        conflictAll: 'NoConflict',
      },
    ],
  }],
};

const nestedStructArrayMeta = fieldMeta({
  name: 'Container',
  type: 'struct',
  fields: [
    fieldMeta({
      name: 'Entries',
      type: 'array',
      isArray: true,
      elementType: fieldMeta({
        name: '',
        type: 'struct',
        fields: [fieldMeta({ name: 'Id', type: 'string' }), fieldMeta({ name: 'Weight', type: 'int' })],
      }),
    }),
  ],
});

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
    winnerColumn: 'Fallout4.esm',
    cellStates: {},
    children: [{
      fieldName: 'Entries',
      values: { 'Fallout4.esm': [{ Id: 'A', Weight: 1 }], 'MyMod.esp': [{ Id: 'A', Weight: 1 }] },
      winnerColumn: 'Fallout4.esm',
      cellStates: {},
      children: [{
        fieldName: '[0]',
        values: { 'Fallout4.esm': { Id: 'A', Weight: 1 }, 'MyMod.esp': { Id: 'A', Weight: 1 } },
        winnerColumn: 'Fallout4.esm',
        cellStates: {},
        children: [
          {
            fieldName: 'Id',
            values: { 'Fallout4.esm': 'A', 'MyMod.esp': 'A' },
            winnerColumn: 'Fallout4.esm',
            cellStates: {},
          },
          {
            fieldName: 'Weight',
            values: { 'Fallout4.esm': 1, 'MyMod.esp': 1 },
            winnerColumn: 'Fallout4.esm',
            cellStates: {},
          },
        ],
      }],
    }],
  }],
};

let currentCompare: unknown = null;

function renderPanel() {
  const client = panelClient(() => currentCompare, { plugins: pluginsResponse });
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
    const kwdBTd = required(screen.getAllByText('KwdB').find(el => el.tagName === 'TD'), 'a KwdB TD');
    const row = required(kwdBTd.closest('tr'), "the KwdB TD's row");
    const cells = row.querySelectorAll('td');
    const secondCell = required(cells[1], "the KwdB row's second cell");
    const thirdCell = required(cells[2], "the KwdB row's third cell");
    expect(secondCell.textContent).toBe('KwdB');
    expect(thirdCell.textContent).toBe('');
    expect(thirdCell.querySelector('[data-open-trigger]')).toBeNull();
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
    const structRow = required(screen.getByText('ObjectBounds').closest('tr'), "ObjectBounds's row");
    expect(structRow.style.backgroundColor).toBe('rgba(76, 175, 80, 0.20)');
  });

  it('expanded: the struct row loses its own background, and only the differing child is tinted', async () => {
    renderPanel();
    await waitFor(() => screen.getByText('▶'));
    fireEvent.click(screen.getByText('▶'));
    await waitFor(() => screen.getByText('X1'));

    const structRow = required(screen.getByText('ObjectBounds').closest('tr'), "ObjectBounds's row");
    const x1Row = required(screen.getByText('X1').closest('tr'), "X1's row");
    const x2Row = required(screen.getByText('X2').closest('tr'), "X2's row");
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

    const structRow = required(screen.getByText('ObjectBounds').closest('tr'), "ObjectBounds's row");
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
    fireEvent.click(required(screen.getAllByText('▶')[0], "the expand toggle")); // expand Container -> Entries
    await waitFor(() => screen.getByText('Entries'));
    fireEvent.click(required(screen.getAllByText('▶')[0], "the expand toggle")); // expand Entries -> [0]
    await waitFor(() => {
      const td = screen.getAllByText('[0]').find(el => el.tagName === 'TD');
      if (!td) throw new Error('[0] TD not found yet');
    });
    fireEvent.click(required(screen.getAllByText('▶')[0], "the expand toggle")); // expand [0] -> Id/Weight
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

describe('RecordPanel — array editing (unsorted)', () => {
  const intArrayMeta = fieldMeta({
    name: 'Values', type: 'array', isArray: true,
    elementType: fieldMeta({ name: '', type: 'int' }),
  });

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
      winnerColumn: 'MyMod.esp',
      cellStates: {},
      children: [
        { fieldName: '[0]', values: { 'MyMod.esp': 1 }, winnerColumn: 'MyMod.esp', cellStates: {} },
        { fieldName: '[1]', values: { 'MyMod.esp': 2 }, winnerColumn: 'MyMod.esp', cellStates: {} },
        { fieldName: '[2]', values: { 'MyMod.esp': 3 }, winnerColumn: 'MyMod.esp', cellStates: {} },
      ],
    }],
  };

  function renderEditablePanel() {
    const client = panelClient(() => intArrayCompareResult, {
      plugins: [{ name: 'MyMod.esp', isTracked: true }],
    });
    return { client, ...render(<RecordPanel client={client} />) };
  }

  beforeEach(() => {
    vi.stubGlobal('mEditFormKey', '000001:Fallout4.esm');
    currentCompare = intArrayCompareResult;
    vi.mocked(vscode.postMessage).mockClear();
  });
  afterEach(() => vi.unstubAllGlobals());

  it('Insert on the focused array-parent cell posts add at the array, carrying no value', async () => {
    renderEditablePanel();
    await waitFor(() => screen.getByText('Values'));
    const label = required(screen.getAllByText('[3]')[0], 'the [3] index label');
    const cell = required(label.closest('td'), "the [3] index label's cell");
    fireEvent.click(cell); // focus
    fireEvent.keyDown(cell, { key: 'Insert' });

    expect(lastEnvelope()).toEqual({ op: 'add', path: [member('Values')] });
    expect(lastEnvelope()).not.toHaveProperty('value');
  });

  it('Delete on a focused array-element cell posts remove at its own index', async () => {
    renderEditablePanel();
    await waitFor(() => screen.getByText('Values'));
    fireEvent.click(required(screen.getAllByText('▶')[0], "the expand toggle")); // expand
    await waitFor(() => screen.getByText('[1]'));
    const cell = screen.getByText('2').closest('td')!;
    fireEvent.click(cell);
    fireEvent.keyDown(cell, { key: 'Delete' });

    expect(lastEnvelope()).toEqual({ op: 'remove', path: [member('Values'), at(1)] });
  });

  it('Ctrl+ArrowDown on a focused element posts move with the next position as its value', async () => {
    renderEditablePanel();
    await waitFor(() => screen.getByText('Values'));
    fireEvent.click(required(screen.getAllByText('▶')[0], "the expand toggle"));
    await waitFor(() => screen.getByText('[0]'));
    const cell = screen.getByText('1').closest('td')!;
    fireEvent.click(cell);
    fireEvent.keyDown(cell, { key: 'ArrowDown', ctrlKey: true });

    expect(lastEnvelope()).toEqual({ op: 'move', path: [member('Values'), at(0)], value: 1 });
  });

  it('Ctrl+ArrowUp on a focused element posts move with the previous position as its value', async () => {
    renderEditablePanel();
    await waitFor(() => screen.getByText('Values'));
    fireEvent.click(required(screen.getAllByText('▶')[0], "the expand toggle"));
    await waitFor(() => screen.getByText('[2]'));
    const cell = screen.getByText('3').closest('td')!;
    fireEvent.click(cell);
    fireEvent.keyDown(cell, { key: 'ArrowUp', ctrlKey: true });

    expect(lastEnvelope()).toEqual({ op: 'move', path: [member('Values'), at(2)], value: 1 });
  });

  // The webview posts what the user asked for; a move off either end is the backend's to refuse
  // by name (ADR-0005), not a boundary this side answers.
  it('Ctrl+ArrowUp on the first element still posts the move, to the position before it', async () => {
    renderEditablePanel();
    await waitFor(() => screen.getByText('Values'));
    fireEvent.click(required(screen.getAllByText('▶')[0], "the expand toggle"));
    await waitFor(() => screen.getByText('[0]'));
    const cell = screen.getByText('1').closest('td')!;
    fireEvent.click(cell);
    fireEvent.keyDown(cell, { key: 'ArrowUp', ctrlKey: true });

    expect(lastEnvelope()).toEqual({ op: 'move', path: [member('Values'), at(0)], value: -1 });
  });

});

// Module scope: the inline-edit blocks below share these fixtures.
const editableIntArrayMeta = fieldMeta({
  name: 'Values', type: 'array', isArray: true,
  elementType: fieldMeta({ name: '', type: 'int' }),
});

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
    winnerColumn: 'MyMod.esp',
    cellStates: {},
    children: [
      { fieldName: '[0]', values: { 'MyMod.esp': 11 }, winnerColumn: 'MyMod.esp', cellStates: {} },
      { fieldName: '[1]', values: { 'MyMod.esp': 22 }, winnerColumn: 'MyMod.esp', cellStates: {} },
      { fieldName: '[2]', values: { 'MyMod.esp': 33 }, winnerColumn: 'MyMod.esp', cellStates: {} },
    ],
  }],
};

const scalarMeta = fieldMeta({ name: 'Level', type: 'int' });

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
    winnerColumn: 'MyMod.esp',
    cellStates: {},
  }],
};

function renderEditablePanel() {
  const client = panelClient(() => currentCompare, {
    plugins: [{ name: 'Fallout4.esm', isImmutable: true }, { name: 'MyMod.esp', isTracked: true }],
  });
  return { client, ...render(<RecordPanel client={client} />) };
}

// The same number can appear in more than one column, so the editable last cell is addressed
// by row rather than by value text.
function editLastCellOfRow(rowLabel: string, shownValue: string, typed: string) {
  const row = required(screen.getByText(rowLabel).closest('tr'), `${rowLabel}'s row`);
  const cells = row.querySelectorAll('td');
  const cell = required(cells[cells.length - 1], `${rowLabel}'s last cell`);
  // xEdit's own gesture (ADR-0018): a double click opens the editor on a resting cell.
  fireEvent.doubleClick(within(cell).getByText(shownValue));
  const input = required(cell.querySelector('input'), `${rowLabel}'s open editor input`);
  fireEvent.change(input, { target: { value: typed } });
  fireEvent.keyDown(input, { key: 'Enter' });
}

describe('RecordPanel — a value edit posts one set envelope addressing the leaf', () => {
  beforeEach(() => {
    vi.stubGlobal('mEditFormKey', '000001:Fallout4.esm');
    vi.mocked(vscode.postMessage).mockClear();
  });
  afterEach(() => vi.unstubAllGlobals());

  it('an array element: the array member, then the element by position', async () => {
    currentCompare = editableIntArrayResult;
    renderEditablePanel();
    await waitFor(() => screen.getByText('Values'));
    fireEvent.click(required(screen.getAllByText('▶')[0], "the expand toggle")); // expand
    await waitFor(() => screen.getByText('[1]'));

    editLastCellOfRow('[1]', '22', '99');

    expect(lastEnvelope()).toEqual({ op: 'set', path: [member('Values'), at(1)], value: 99 });
  });

  it('a struct member: the struct, then the member by name', async () => {
    currentCompare = structCollapseExpandResult;
    renderEditablePanel();
    await waitFor(() => screen.getByText('ObjectBounds'));
    fireEvent.click(required(screen.getAllByText('▶')[0], "the expand toggle")); // expand
    await waitFor(() => screen.getByText('X1'));

    editLastCellOfRow('X1', '5', '7');

    expect(lastEnvelope()).toEqual({ op: 'set', path: [member('ObjectBounds'), member('X1')], value: 7 });
  });

  // OMOD `Properties[i].step` shape: the leaf sits two hops deep, and every hop travels.
  it('a member of a struct element inside a struct: every hop from the record down', async () => {
    currentCompare = nestedStructArrayResult;
    renderEditablePanel();
    await waitFor(() => screen.getByText('Container'));
    fireEvent.click(required(screen.getAllByText('▶')[0], "the expand toggle"));
    await waitFor(() => screen.getByText('Entries'));
    fireEvent.click(required(screen.getAllByText('▶')[0], "the expand toggle"));
    await waitFor(() => screen.getAllByText('[0]').find(el => el.tagName === 'TD'));
    fireEvent.click(required(screen.getAllByText('▶')[0], "the expand toggle"));
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
    fireEvent.click(required(screen.getAllByText('▶')[0], "the expand toggle"));
    await waitFor(() => screen.getByText('Entries'));
    fireEvent.click(required(screen.getAllByText('▶')[0], "the expand toggle"));
    await waitFor(() => screen.getAllByText('[0]').find(el => el.tagName === 'TD'));

    const row = screen.getAllByText('[0]').find(el => el.tagName === 'TD')!.closest('tr')!;
    const cells = row.querySelectorAll('td');
    const cell = cells[cells.length - 1]!;
    fireEvent.click(cell);
    fireEvent.keyDown(cell, { key: 'Delete' });

    expect(lastEnvelope()).toEqual({ op: 'remove', path: [member('Container'), member('Entries'), at(0)] });
  });

  it('Ctrl+ArrowDown on an element nested inside a struct posts move with every hop', async () => {
    currentCompare = nestedStructArrayResult;
    renderEditablePanel();
    await waitFor(() => screen.getByText('Container'));
    fireEvent.click(required(screen.getAllByText('▶')[0], "the expand toggle"));
    await waitFor(() => screen.getByText('Entries'));
    fireEvent.click(required(screen.getAllByText('▶')[0], "the expand toggle"));
    await waitFor(() => screen.getAllByText('[0]').find(el => el.tagName === 'TD'));

    const row = screen.getAllByText('[0]').find(el => el.tagName === 'TD')!.closest('tr')!;
    const cells = row.querySelectorAll('td');
    const cell = cells[cells.length - 1]!;
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

    const calls = vi.mocked(vscode.postMessage).mock.calls;
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
  const scriptMeta = fieldMeta({
    name: 'Scripts', type: 'array', isArray: true,
    keyMembers: ['name'],
    elementType: fieldMeta({
      name: '', type: 'struct',
      fields: [fieldMeta({ name: 'name', type: 'string' }), fieldMeta({ name: 'flags', type: 'string' })],
    }),
  });

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
      winnerColumn: 'MyMod.esp',
      cellStates: {},
      children: [
        {
          fieldName: 'Ambush',
          values: { 'MyMod.esp': override[0] },
          winnerColumn: 'MyMod.esp', cellStates: {},
          children: [
            { fieldName: 'name', values: { 'MyMod.esp': 'Ambush' }, winnerColumn: 'MyMod.esp', cellStates: {} },
            { fieldName: 'flags', values: { 'MyMod.esp': 'a' }, winnerColumn: 'MyMod.esp', cellStates: {} },
          ],
        },
        {
          fieldName: 'Guard',
          values: { 'Fallout4.esm': master[0], 'MyMod.esp': override[1] },
          winnerColumn: 'MyMod.esp', cellStates: {},
          children: [
            { fieldName: 'name', values: { 'Fallout4.esm': 'Guard', 'MyMod.esp': 'Guard' }, winnerColumn: 'MyMod.esp', cellStates: {} },
            { fieldName: 'flags', values: { 'Fallout4.esm': 'm', 'MyMod.esp': 'g' }, winnerColumn: 'MyMod.esp', cellStates: {} },
          ],
        },
      ],
    }],
  };

  function renderKeyedPanel() {
    const client = panelClient(() => keyedResult, {
      plugins: [{ name: 'Fallout4.esm', isImmutable: true }, { name: 'MyMod.esp', isTracked: true }],
    });
    return render(<RecordPanel client={client} />);
  }

  beforeEach(() => {
    vi.stubGlobal('mEditFormKey', '000001:Fallout4.esm');
    vi.mocked(vscode.postMessage).mockClear();
  });
  afterEach(() => vi.unstubAllGlobals());

  async function expandTo(label: string) {
    renderKeyedPanel();
    await waitFor(() => screen.getByText('Scripts'));
    fireEvent.click(screen.getByText('Scripts').closest('tr')!.querySelector('button')!);
    await waitFor(() => screen.getByText(label));
    // The row's own label cell comes first; once expanded, the key text also appears as the value
    // of the element's own `name` member.
    fireEvent.click(screen.getAllByText(label)[0]!.closest('tr')!.querySelector('button')!);
    await waitFor(() => screen.getAllByText('flags'));
  }

  // `Guard` is element 1 in the column being written and element 0 in the master; the key names
  // it in both, where a position could name only one.
  it('a value edit on a keyed element posts set through the key hop', async () => {
    await expandTo('Guard');
    const row = screen.getAllByText('flags')[0]!.closest('tr')!;
    const cells = row.querySelectorAll('td');
    const cell = cells[cells.length - 1]!;
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
    const row = screen.getAllByText('Guard')[0]!.closest('tr')!;
    const cells = row.querySelectorAll('td');
    const cell = cells[cells.length - 1]!;
    fireEvent.click(cell);
    fireEvent.keyDown(cell, { key: 'Delete' });

    expect(lastEnvelope()).toEqual({ op: 'remove', path: [member('Scripts'), keyed('Guard')] });
  });

  // The backend spells a key from the element's declared defaults, so an element omitting a key
  // member is labelled "10 / 0"; the row posts that text as stated, never a respelling of its own.
  it('posts the key text the diff node states, not one read off the element', async () => {
    const fragmentsMeta = fieldMeta({
      name: 'Fragments', type: 'array', isArray: true,
      keyMembers: ['Stage', 'StageIndex'],
      elementType: fieldMeta({
        name: '', type: 'struct',
        fields: [fieldMeta({ name: 'Stage', type: 'int' }), fieldMeta({ name: 'StageIndex', type: 'int' })],
      }),
    });
    const element = { Stage: 10 };
    const client = panelClient(() => ({
          conflictAll: 'OnlyOne',
          overrides: [{
            formKey: '000001:Fallout4.esm', plugin: 'MyMod.esp', origin: 'Data', loadOrderIndex: 1, isWinner: true,
            editorId: 'TestNPC', fields: [{ metadata: fragmentsMeta, value: [element] }], conflictThis: 'OnlyOne',
          }],
          diffs: [{
            fieldName: 'Fragments', values: { 'MyMod.esp': [element] }, winnerColumn: 'MyMod.esp',
            cellStates: {},
            children: [{
              fieldName: '10 / 0', values: { 'MyMod.esp': element }, winnerColumn: 'MyMod.esp',
              cellStates: {},
              children: [{ fieldName: 'Stage', values: { 'MyMod.esp': 10 }, winnerColumn: 'MyMod.esp', cellStates: {} }],
            }],
          }],
    }), { plugins: [{ name: 'MyMod.esp', isTracked: true }] });
    render(<RecordPanel client={client} />);
    await waitFor(() => screen.getByText('Fragments'));
    fireEvent.click(screen.getByText('Fragments').closest('tr')!.querySelector('button')!);
    await waitFor(() => screen.getByText('10 / 0'));
    const cell = screen.getByText('10 / 0').closest('tr')!.querySelectorAll('td')[1]!;
    fireEvent.click(cell);
    fireEvent.keyDown(cell, { key: 'Delete' });

    expect(lastEnvelope()).toEqual({ op: 'remove', path: [member('Fragments'), keyed('10 / 0')] });
  });

  // A keyed array is stored in key order, so no Move could change the file: the accelerator is
  // inert on its rows.
  it('Ctrl+ArrowDown on a keyed element posts nothing', async () => {
    await expandTo('Guard');
    const row = screen.getAllByText('Guard')[0]!.closest('tr')!;
    const cells = row.querySelectorAll('td');
    const cell = cells[cells.length - 1]!;
    fireEvent.click(cell);
    fireEvent.keyDown(cell, { key: 'ArrowDown', ctrlKey: true });

    expect(lastEnvelope()).toBeUndefined();
  });

  // Inert means the row never offers the op, not that the envelope builder refuses it afterwards:
  // a row that offered it would swallow the key and still post nothing, indistinguishable above.
  it('Ctrl+ArrowDown on a keyed element leaves the key unhandled', async () => {
    await expandTo('Guard');
    const row = screen.getAllByText('Guard')[0]!.closest('tr')!;
    const cells = row.querySelectorAll('td');
    const cell = cells[cells.length - 1]!;
    fireEvent.click(cell);

    expect(fireEvent.keyDown(cell, { key: 'ArrowDown', ctrlKey: true })).toBe(true);
  });
});

// A pure-FormLink array is sorted by its own values, so an element sits at a different position in
// every column; the hop is that position in the column being written.
describe('RecordPanel — an element of a sorted array is addressed at its position in this column', () => {
  function renderSortedPanel() {
    const client = panelClient(() => sortedArrayCompareResult, {
      plugins: [{ name: 'Fallout4.esm', isImmutable: true }, { name: 'MyMod.esp', isTracked: true }],
    });
    return render(<RecordPanel client={client} />);
  }

  beforeEach(() => {
    vi.stubGlobal('mEditFormKey', '000001:Fallout4.esm');
    vi.mocked(vscode.postMessage).mockClear();
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
    const cell = cells[cells.length - 1]!;
    fireEvent.click(cell);
    fireEvent.doubleClick(within(cell).getByText('KwdC'));

    // The native QuickPick answers through the bridge; this is its reply.
    type OpenFormKeyPicker = Extract<WebviewToExtension, { type: typeof WEBVIEW_TO_EXTENSION.OPEN_FORM_KEY_PICKER }>;
    const isOpenFormKeyPicker = (call: [WebviewToExtension]): call is [OpenFormKeyPicker] =>
      call[0].type === WEBVIEW_TO_EXTENSION.OPEN_FORM_KEY_PICKER;
    const calls = vi.mocked(vscode.postMessage).mock.calls;
    const request = [...calls].reverse().find(isOpenFormKeyPicker)![0];
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
