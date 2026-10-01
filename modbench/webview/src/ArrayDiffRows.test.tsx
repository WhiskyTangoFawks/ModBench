import '@testing-library/jest-dom';
import React from 'react';
import { render, screen, fireEvent, waitFor, within, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('./vscode', () => ({ vscode: { postMessage: vi.fn() } }));

import { RecordPanel } from './RecordPanel';
import { vscode } from './vscode';
import { WEBVIEW_TO_EXTENSION, EXTENSION_TO_WEBVIEW, type WebviewToExtension } from './messages';
import {
  at, compareOverride, compareResultFixture, diffNode, fieldMeta, keyed, lastElementCommand, lastPostedEnvelope, member,
  panelClient, required,
} from './test/fixtures';
import type { CompareResult } from './types';

const lastEnvelope = () => lastPostedEnvelope(vscode.postMessage);
const lastCommand = () => lastElementCommand(vscode.postMessage);


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

const sortedArrayCompareResult: CompareResult = compareResultFixture({
  conflictAll: 'Override',
  overrides: [
    compareOverride({
      formKey: '000001:Fallout4.esm', plugin: 'Fallout4.esm',
      isWinner: false, editorId: 'TestNPC',
      fields: [{ metadata: decoyMeta, value: 4 }, { metadata: sortedArrayMeta, value: ['KwdA', 'KwdB'] }],
      conflictThis: 'Master',
    }),
    compareOverride({
      formKey: '000001:Fallout4.esm', plugin: 'MyMod.esp',
      isWinner: true, editorId: 'TestNPC',
      fields: [{ metadata: decoyMeta, value: 4 }, { metadata: sortedArrayMeta, value: ['KwdA', 'KwdC'] }],
      conflictThis: 'Override',
    }),
  ],
  diffs: [diffNode({
    fieldName: 'Keywords',
    values: { 'Fallout4.esm': ['KwdA', 'KwdB'], 'MyMod.esp': ['KwdA', 'KwdC'] },
    winnerColumn: 'MyMod.esp',
    cellStates: { 'MyMod.esp': 'Override' },
    children: [
      diffNode({
        fieldName: 'KwdA',
        values: { 'Fallout4.esm': 'KwdA', 'MyMod.esp': 'KwdA' },
        winnerColumn: 'Fallout4.esm',
        cellStates: { 'MyMod.esp': 'IdenticalToMaster' },
      }),
      diffNode({
        fieldName: 'KwdB',
        values: { 'Fallout4.esm': 'KwdB', 'MyMod.esp': null },
        winnerColumn: 'Fallout4.esm',
        cellStates: {},
      }),
      diffNode({
        fieldName: 'KwdC',
        values: { 'Fallout4.esm': null, 'MyMod.esp': 'KwdC' },
        winnerColumn: 'MyMod.esp',
        cellStates: { 'MyMod.esp': 'Override' },
      }),
    ],
  })],
});

const structMeta = fieldMeta({
  name: 'ObjectBounds',
  type: 'struct',
  fields: [fieldMeta({ name: 'X1', type: 'int' }), fieldMeta({ name: 'X2', type: 'int' })],
});

const structCollapseExpandResult: CompareResult = compareResultFixture({
  conflictAll: 'Override',
  overrides: [
    compareOverride({
      formKey: '000001:Fallout4.esm', plugin: 'Fallout4.esm',
      isWinner: false, editorId: 'TestNPC',
      fields: [{ metadata: structMeta, value: { X1: 0, X2: 100 } }], conflictThis: 'Master',
    }),
    compareOverride({
      formKey: '000001:Fallout4.esm', plugin: 'MyMod.esp',
      isWinner: true, editorId: 'TestNPC',
      fields: [{ metadata: structMeta, value: { X1: 5, X2: 100 } }], conflictThis: 'Override',
    }),
  ],
  diffs: [diffNode({
    fieldName: 'ObjectBounds',
    values: { 'Fallout4.esm': { X1: 0, X2: 100 }, 'MyMod.esp': { X1: 5, X2: 100 } },
    winnerColumn: 'MyMod.esp',
    cellStates: { 'MyMod.esp': 'Override' },
    conflictAll: 'Override',
    children: [
      diffNode({
        fieldName: 'X1',
        values: { 'Fallout4.esm': 0, 'MyMod.esp': 5 },
        winnerColumn: 'MyMod.esp',
        cellStates: { 'MyMod.esp': 'Override' },
        conflictAll: 'Override',
      }),
      diffNode({
        fieldName: 'X2',
        values: { 'Fallout4.esm': 100, 'MyMod.esp': 100 },
        winnerColumn: 'Fallout4.esm',
        cellStates: { 'MyMod.esp': 'IdenticalToMaster' },
        conflictAll: 'NoConflict',
      }),
    ],
  })],
});

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

const nestedStructArrayResult: CompareResult = compareResultFixture({
  conflictAll: 'NoConflict',
  overrides: [
    compareOverride({
      formKey: '000001:Fallout4.esm', plugin: 'Fallout4.esm',
      isWinner: false, editorId: 'TestNPC',
      fields: [{ metadata: nestedStructArrayMeta, value: { Entries: [{ Id: 'A', Weight: 1 }] } }], conflictThis: 'Master',
    }),
    compareOverride({
      formKey: '000001:Fallout4.esm', plugin: 'MyMod.esp',
      isWinner: true, editorId: 'TestNPC',
      fields: [{ metadata: nestedStructArrayMeta, value: { Entries: [{ Id: 'A', Weight: 1 }] } }], conflictThis: 'IdenticalToMaster',
    }),
  ],
  diffs: [diffNode({
    fieldName: 'Container',
    values: {
      'Fallout4.esm': { Entries: [{ Id: 'A', Weight: 1 }] },
      'MyMod.esp': { Entries: [{ Id: 'A', Weight: 1 }] },
    },
    winnerColumn: 'Fallout4.esm',
    cellStates: {},
    children: [diffNode({
      fieldName: 'Entries',
      values: { 'Fallout4.esm': [{ Id: 'A', Weight: 1 }], 'MyMod.esp': [{ Id: 'A', Weight: 1 }] },
      winnerColumn: 'Fallout4.esm',
      cellStates: {},
      children: [diffNode({
        fieldName: '[0]',
        values: { 'Fallout4.esm': { Id: 'A', Weight: 1 }, 'MyMod.esp': { Id: 'A', Weight: 1 } },
        winnerColumn: 'Fallout4.esm',
        cellStates: {},
        children: [
          diffNode({
            fieldName: 'Id',
            values: { 'Fallout4.esm': 'A', 'MyMod.esp': 'A' },
            winnerColumn: 'Fallout4.esm',
            cellStates: {},
          }),
          diffNode({
            fieldName: 'Weight',
            values: { 'Fallout4.esm': 1, 'MyMod.esp': 1 },
            winnerColumn: 'Fallout4.esm',
            cellStates: {},
          }),
        ],
      })],
    })],
  })],
});

let currentCompare: CompareResult = compareResultFixture();

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
    fireEvent.click(within(required(screen.getByText('Keywords').closest('tr'), "Keywords's row")).getByText('▼'));
    // Both plugin columns have 2-element arrays; at least one [2] must be visible
    expect(screen.getAllByText('[2]').length).toBeGreaterThan(0);
    // No {…} placeholder for array parent
    expect(screen.queryByText('{…}')).not.toBeInTheDocument();
  });

  it('opens showing 3 child rows for the sorted array', async () => {
    renderPanel();
    // Field name TDs contain the element keys; use getAllByText since FormKey also renders them as links
    await waitFor(() => screen.getAllByText('KwdA').length > 0);
    expect(screen.getAllByText('KwdB').length).toBeGreaterThan(0);
    expect(screen.getAllByText('KwdC').length).toBeGreaterThan(0);
  });

  // An element the column does not carry is nothing there — not a null link, which reads "—".
  it('KwdB child row is empty for MyMod.esp, whose array has no such element', async () => {
    renderPanel();
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
    await waitFor(() => screen.getByText('X1'));
    fireEvent.click(within(required(screen.getByText('ObjectBounds').closest('tr'), "ObjectBounds's row")).getByText('▼'));
    await waitFor(() => expect(screen.queryByText('X1')).not.toBeInTheDocument());
    const structRow = required(screen.getByText('ObjectBounds').closest('tr'), "ObjectBounds's row");
    expect(structRow.style.backgroundColor).toBe('var(--vscode-modbench-conflict-rowOverride)');
  });

  it('expanded: the struct row loses its own background, and only the differing child is tinted', async () => {
    renderPanel();
    await waitFor(() => screen.getByText('X1'));

    const structRow = required(screen.getByText('ObjectBounds').closest('tr'), "ObjectBounds's row");
    const x1Row = required(screen.getByText('X1').closest('tr'), "X1's row");
    const x2Row = required(screen.getByText('X2').closest('tr'), "X2's row");
    expect(structRow.style.backgroundColor).toBe('');
    expect(x1Row.style.backgroundColor).toBe('var(--vscode-modbench-conflict-rowOverride)');
    expect(x2Row.style.backgroundColor).toBe('');
  });

  it('re-collapsed: the aggregate tint returns to the struct row', async () => {
    renderPanel();
    await waitFor(() => screen.getByText('X1'));
    const structRowOf = () => required(screen.getByText('ObjectBounds').closest('tr'), "ObjectBounds's row");
    fireEvent.click(within(structRowOf()).getByText('▼'));
    await waitFor(() => expect(screen.queryByText('X1')).not.toBeInTheDocument());
    fireEvent.click(within(structRowOf()).getByText('▶'));
    await waitFor(() => screen.getByText('X1'));
    fireEvent.click(within(structRowOf()).getByText('▼'));
    await waitFor(() => expect(screen.queryByText('X1')).not.toBeInTheDocument());

    const structRow = required(screen.getByText('ObjectBounds').closest('tr'), "ObjectBounds's row");
    expect(structRow.style.backgroundColor).toBe('var(--vscode-modbench-conflict-rowOverride)');
  });
});


describe('RecordPanel — a struct member that is itself an array of structs', () => {
  beforeEach(() => {
    vi.stubGlobal('mEditFormKey', '000001:Fallout4.esm');
    currentCompare = nestedStructArrayResult;
  });
  afterEach(() => vi.unstubAllGlobals());

  async function waitForAllFourLevels() {
    await waitFor(() => screen.getByText('Container'));
    await waitFor(() => {
      const td = screen.getAllByText('[0]').find(el => el.tagName === 'TD');
      if (!td) throw new Error('[0] TD not found yet');
    });
    await waitFor(() => screen.getByText('Weight'));
  }

  it('renders all four levels: Container, Entries, [0], and its Id/Weight members', async () => {
    renderPanel();
    await waitForAllFourLevels();
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

  const intArrayCompareResult: CompareResult = compareResultFixture({
    conflictAll: 'NoConflict',
    overrides: [
      compareOverride({
        formKey: '000001:Fallout4.esm', plugin: 'MyMod.esp', origin: 'Data',
        isWinner: true, editorId: 'TestNPC',
        fields: [{ metadata: intArrayMeta, value: [1, 2, 3] }], conflictThis: 'Master',
      }),
    ],
    diffs: [diffNode({
      fieldName: 'Values',
      values: { 'MyMod.esp': [1, 2, 3] },
      winnerColumn: 'MyMod.esp',
      cellStates: {},
      children: [
        diffNode({ fieldName: '[0]', values: { 'MyMod.esp': 1 }, winnerColumn: 'MyMod.esp', cellStates: {} }),
        diffNode({ fieldName: '[1]', values: { 'MyMod.esp': 2 }, winnerColumn: 'MyMod.esp', cellStates: {} }),
        diffNode({ fieldName: '[2]', values: { 'MyMod.esp': 3 }, winnerColumn: 'MyMod.esp', cellStates: {} }),
      ],
    })],
  });

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

  it('Delete on a focused array-element cell fires remove element at its own index', async () => {
    renderEditablePanel();
    await waitFor(() => screen.getByText('Values'));
    await waitFor(() => screen.getByText('[1]'));
    const cell = required(screen.getByText('2').closest('td'), "the '2' cell's td ancestor");
    fireEvent.click(cell);
    fireEvent.keyDown(cell, { key: 'Delete' });

    expect(lastCommand()).toMatchObject({ command: 'removeElement', context: { path: [member('Values'), at(1)] } });
    expect(lastEnvelope()).toBeUndefined();
  });

  it('Alt+ArrowDown on a focused element fires move element down', async () => {
    renderEditablePanel();
    await waitFor(() => screen.getByText('Values'));
    await waitFor(() => screen.getByText('[0]'));
    const cell = required(screen.getByText('1').closest('td'), "the '1' cell's td ancestor");
    fireEvent.click(cell);
    fireEvent.keyDown(cell, { key: 'ArrowDown', altKey: true });

    expect(lastCommand()).toMatchObject({ command: 'moveElementDown', context: { path: [member('Values'), at(0)] } });
  });

  it('Alt+ArrowUp on a focused element fires move element up', async () => {
    renderEditablePanel();
    await waitFor(() => screen.getByText('Values'));
    await waitFor(() => screen.getByText('[2]'));
    const cell = required(screen.getByText('3').closest('td'), "the '3' cell's td ancestor");
    fireEvent.click(cell);
    fireEvent.keyDown(cell, { key: 'ArrowUp', altKey: true });

    expect(lastCommand()).toMatchObject({ command: 'moveElementUp', context: { path: [member('Values'), at(2)] } });
  });

  // As VS Code moves a line: at the end of the array nothing happens.
  it('Alt+ArrowUp on the first element fires nothing and leaves the key unhandled', async () => {
    renderEditablePanel();
    await waitFor(() => screen.getByText('Values'));
    await waitFor(() => screen.getByText('[0]'));
    const cell = required(screen.getByText('1').closest('td'), "the '1' cell's td ancestor");
    fireEvent.click(cell);

    expect(fireEvent.keyDown(cell, { key: 'ArrowUp', altKey: true })).toBe(true);
    expect(lastCommand()).toBeUndefined();
  });

  it('Alt+ArrowDown on the last element fires nothing and leaves the key unhandled', async () => {
    renderEditablePanel();
    await waitFor(() => screen.getByText('Values'));
    await waitFor(() => screen.getByText('[2]'));
    const cell = required(screen.getByText('3').closest('td'), "the '3' cell's td ancestor");
    fireEvent.click(cell);

    expect(fireEvent.keyDown(cell, { key: 'ArrowDown', altKey: true })).toBe(true);
    expect(lastCommand()).toBeUndefined();
  });
});

// Module scope: the inline-edit blocks below share these fixtures.
const editableIntArrayMeta = fieldMeta({
  name: 'Values', type: 'array', isArray: true,
  elementType: fieldMeta({ name: '', type: 'int' }),
});

const editableIntArrayResult: CompareResult = compareResultFixture({
  conflictAll: 'NoConflict',
  overrides: [
    compareOverride({
      formKey: '000001:Fallout4.esm', plugin: 'MyMod.esp', origin: 'Data',
      isWinner: true, editorId: 'TestNPC',
      fields: [{ metadata: editableIntArrayMeta, value: [11, 22, 33] }], conflictThis: 'Master',
    }),
  ],
  diffs: [diffNode({
    fieldName: 'Values',
    values: { 'MyMod.esp': [11, 22, 33] },
    winnerColumn: 'MyMod.esp',
    cellStates: {},
    children: [
      diffNode({ fieldName: '[0]', values: { 'MyMod.esp': 11 }, winnerColumn: 'MyMod.esp', cellStates: {} }),
      diffNode({ fieldName: '[1]', values: { 'MyMod.esp': 22 }, winnerColumn: 'MyMod.esp', cellStates: {} }),
      diffNode({ fieldName: '[2]', values: { 'MyMod.esp': 33 }, winnerColumn: 'MyMod.esp', cellStates: {} }),
    ],
  })],
});

const scalarMeta = fieldMeta({ name: 'Level', type: 'int' });

const scalarResult: CompareResult = compareResultFixture({
  conflictAll: 'NoConflict',
  overrides: [
    compareOverride({
      formKey: '000001:Fallout4.esm', plugin: 'MyMod.esp', origin: 'Data',
      isWinner: true, editorId: 'TestNPC',
      fields: [{ metadata: scalarMeta, value: 4 }], conflictThis: 'Master',
    }),
  ],
  diffs: [diffNode({
    fieldName: 'Level',
    values: { 'MyMod.esp': 4 },
    winnerColumn: 'MyMod.esp',
    cellStates: {},
  })],
});

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
    await waitFor(() => screen.getByText('[1]'));

    editLastCellOfRow('[1]', '22', '99');

    expect(lastEnvelope()).toEqual({ op: 'set', path: [member('Values'), at(1)], value: 99 });
  });

  it('a struct member: the struct, then the member by name', async () => {
    currentCompare = structCollapseExpandResult;
    renderEditablePanel();
    await waitFor(() => screen.getByText('ObjectBounds'));
    await waitFor(() => screen.getByText('X1'));

    editLastCellOfRow('X1', '5', '7');

    expect(lastEnvelope()).toEqual({ op: 'set', path: [member('ObjectBounds'), member('X1')], value: 7 });
  });

  // OMOD `Properties[i].step` shape: the leaf sits two hops deep, and every hop travels.
  it('a member of a struct element inside a struct: every hop from the record down', async () => {
    currentCompare = nestedStructArrayResult;
    renderEditablePanel();
    await waitFor(() => screen.getByText('Container'));
    await waitFor(() => screen.getByText('Entries'));
    await waitFor(() => screen.getAllByText('[0]').find(el => el.tagName === 'TD'));
    await waitFor(() => screen.getByText('Weight'));

    editLastCellOfRow('Weight', '1', '7');

    expect(lastEnvelope()).toEqual({
      op: 'set', path: [member('Container'), member('Entries'), at(0), member('Weight')], value: 7,
    });
  });

  it('Delete on an element nested inside a struct fires remove element with every hop', async () => {
    currentCompare = nestedStructArrayResult;
    renderEditablePanel();
    await waitFor(() => screen.getByText('Container'));
    await waitFor(() => screen.getByText('Entries'));
    await waitFor(() => screen.getAllByText('[0]').find(el => el.tagName === 'TD'));

    const indexCell = required(screen.getAllByText('[0]').find(el => el.tagName === 'TD'), "the '[0]' index cell");
    const row = required(indexCell.closest('tr'), "the row containing the '[0]' index cell");
    const cells = row.querySelectorAll('td');
    const cell = required(cells[cells.length - 1], "the last cell in the row");
    fireEvent.click(cell);
    fireEvent.keyDown(cell, { key: 'Delete' });

    expect(lastCommand()).toMatchObject({
      command: 'removeElement', context: { path: [member('Container'), member('Entries'), at(0)] },
    });
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
    const postedCall = required([...calls].reverse().find(([m]) => (m as { type?: string }).type === WEBVIEW_TO_EXTENSION.EDIT_FIELD), "a posted EDIT_FIELD message");
    const posted = postedCall[0];
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

  const keyedResult: CompareResult = compareResultFixture({
    conflictAll: 'Override',
    overrides: [
      compareOverride({
        formKey: '000001:Fallout4.esm', plugin: 'Fallout4.esm', origin: 'Data',
        isWinner: false, editorId: 'TestNPC',
        fields: [{ metadata: scriptMeta, value: master }], conflictThis: 'Master',
      }),
      compareOverride({
        formKey: '000001:Fallout4.esm', plugin: 'MyMod.esp', origin: 'Data',
        isWinner: true, editorId: 'TestNPC',
        fields: [{ metadata: scriptMeta, value: override }], conflictThis: 'Override',
      }),
    ],
    diffs: [diffNode({
      fieldName: 'Scripts',
      values: { 'Fallout4.esm': master, 'MyMod.esp': override },
      winnerColumn: 'MyMod.esp',
      cellStates: {},
      children: [
        diffNode({
          fieldName: 'Ambush',
          values: { 'MyMod.esp': override[0] },
          winnerColumn: 'MyMod.esp', cellStates: {},
          children: [
            diffNode({ fieldName: 'name', values: { 'MyMod.esp': 'Ambush' }, winnerColumn: 'MyMod.esp', cellStates: {} }),
            diffNode({ fieldName: 'flags', values: { 'MyMod.esp': 'a' }, winnerColumn: 'MyMod.esp', cellStates: {} }),
          ],
        }),
        diffNode({
          fieldName: 'Guard',
          values: { 'Fallout4.esm': master[0], 'MyMod.esp': override[1] },
          winnerColumn: 'MyMod.esp', cellStates: {},
          children: [
            diffNode({ fieldName: 'name', values: { 'Fallout4.esm': 'Guard', 'MyMod.esp': 'Guard' }, winnerColumn: 'MyMod.esp', cellStates: {} }),
            diffNode({ fieldName: 'flags', values: { 'Fallout4.esm': 'm', 'MyMod.esp': 'g' }, winnerColumn: 'MyMod.esp', cellStates: {} }),
          ],
        }),
      ],
    })],
  });

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

  async function renderOpen(label: string) {
    renderKeyedPanel();
    await waitFor(() => screen.getAllByText(label));
    await waitFor(() => screen.getAllByText('flags'));
  }

  // `Guard` is element 1 in the column being written and element 0 in the master; the key names
  // it in both, where a position could name only one.
  it('a value edit on a keyed element posts set through the key hop', async () => {
    await renderOpen('Guard');
    const row = required(screen.getByText('g').closest('tr'), "the row for Guard's 'flags'");
    const cells = row.querySelectorAll('td');
    const cell = required(cells[cells.length - 1], "the last cell in the row");
    fireEvent.doubleClick(within(cell).getByText('g'));
    const input = required(cell.querySelector('input'), "the cell's input");
    fireEvent.change(input, { target: { value: 'EDITED' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(lastEnvelope()).toEqual({
      op: 'set', path: [member('Scripts'), keyed('Guard'), member('flags')], value: 'EDITED',
    });
  });

  it('Delete on a keyed element fires remove element naming the key', async () => {
    await renderOpen('Guard');
    const guardCell = required(screen.getAllByText('Guard')[0], "the first 'Guard' match");
    const row = required(guardCell.closest('tr'), "the row for 'Guard'");
    const cells = row.querySelectorAll('td');
    const cell = required(cells[cells.length - 1], "the last cell in the row");
    fireEvent.click(cell);
    fireEvent.keyDown(cell, { key: 'Delete' });

    expect(lastCommand()).toMatchObject({ command: 'removeElement', context: { path: [member('Scripts'), keyed('Guard')] } });
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
    const client = panelClient(() => compareResultFixture({
          conflictAll: 'OnlyOne',
          overrides: [compareOverride({
            formKey: '000001:Fallout4.esm', plugin: 'MyMod.esp', origin: 'Data', isWinner: true,
            editorId: 'TestNPC', fields: [{ metadata: fragmentsMeta, value: [element] }], conflictThis: 'OnlyOne',
          })],
          diffs: [diffNode({
            fieldName: 'Fragments', values: { 'MyMod.esp': [element] }, winnerColumn: 'MyMod.esp',
            cellStates: {},
            children: [diffNode({
              fieldName: '10 / 0', values: { 'MyMod.esp': element }, winnerColumn: 'MyMod.esp',
              cellStates: {},
              children: [diffNode({ fieldName: 'Stage', values: { 'MyMod.esp': 10 }, winnerColumn: 'MyMod.esp', cellStates: {} })],
            })],
          })],
    }), { plugins: [{ name: 'MyMod.esp', isTracked: true }] });
    render(<RecordPanel client={client} />);
    await waitFor(() => screen.getByText('Fragments'));
    await waitFor(() => screen.getByText('10 / 0'));
    const stageRow = required(screen.getByText('10 / 0').closest('tr'), "the '10 / 0' row");
    const cell = required(stageRow.querySelectorAll('td')[1], "the '10 / 0' row's second cell");
    fireEvent.click(cell);
    fireEvent.keyDown(cell, { key: 'Delete' });

    expect(lastCommand()).toMatchObject({ command: 'removeElement', context: { path: [member('Fragments'), keyed('10 / 0')] } });
  });

  // A keyed array is stored in key order, so no Move could change the file: the accelerator is
  // inert on its rows.
  it('Alt+ArrowDown on a keyed element fires nothing', async () => {
    await renderOpen('Guard');
    const guardCell = required(screen.getAllByText('Guard')[0], "the first 'Guard' match");
    const row = required(guardCell.closest('tr'), "the row for 'Guard'");
    const cells = row.querySelectorAll('td');
    const cell = required(cells[cells.length - 1], "the last cell in the row");
    fireEvent.click(cell);
    fireEvent.keyDown(cell, { key: 'ArrowDown', altKey: true });

    expect(lastCommand()).toBeUndefined();
  });

  // Inert means the row never offers the op, not that the envelope builder refuses it afterwards:
  // a row that offered it would swallow the key and still post nothing, indistinguishable above.
  it('Alt+ArrowDown on a keyed element leaves the key unhandled', async () => {
    await renderOpen('Guard');
    const guardCell = required(screen.getAllByText('Guard')[0], "the first 'Guard' match");
    const row = required(guardCell.closest('tr'), "the row for 'Guard'");
    const cells = row.querySelectorAll('td');
    const cell = required(cells[cells.length - 1], "the last cell in the row");
    fireEvent.click(cell);

    expect(fireEvent.keyDown(cell, { key: 'ArrowDown', altKey: true })).toBe(true);
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
    await waitFor(() => screen.getAllByText('KwdC').length > 0);

    // KwdC is element 1 of MyMod.esp's own ['KwdA', 'KwdC'].
    const kwdCCell = required(screen.getAllByText('KwdC').find(el => el.tagName === 'TD'), "the 'KwdC' td cell");
    const row = required(kwdCCell.closest('tr'), "the row for 'KwdC'");
    const cells = row.querySelectorAll('td');
    const cell = required(cells[cells.length - 1], "the last cell in the row");
    fireEvent.click(cell);
    fireEvent.doubleClick(within(cell).getByText('KwdC'));

    // The native QuickPick answers through the bridge; this is its reply.
    type OpenFormKeyPicker = Extract<WebviewToExtension, { type: typeof WEBVIEW_TO_EXTENSION.OPEN_FORM_KEY_PICKER }>;
    const isOpenFormKeyPicker = (call: [WebviewToExtension]): call is [OpenFormKeyPicker] =>
      call[0].type === WEBVIEW_TO_EXTENSION.OPEN_FORM_KEY_PICKER;
    const calls = vi.mocked(vscode.postMessage).mock.calls;
    const requestCall = required([...calls].reverse().find(isOpenFormKeyPicker), "a posted OPEN_FORM_KEY_PICKER message");
    const request = requestCall[0];
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
