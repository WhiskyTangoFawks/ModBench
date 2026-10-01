import '@testing-library/jest-dom';
import React from 'react';
import { render, screen, fireEvent, waitFor, within, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('./vscode', () => ({ vscode: { postMessage: vi.fn() } }));

import { RecordPanel } from './RecordPanel';
import { vscode } from './vscode';
import { WEBVIEW_TO_EXTENSION, EXTENSION_TO_WEBVIEW, type WebviewToExtension } from './messages';
import {
  at, compareOverride, compareResultFixture, diffNode, fieldMeta, lastElementCommand, lastPostedEnvelope, member,
  panelClient, required,
} from './test/fixtures';
import type { CompareResult } from './types';

const lastEnvelope = () => lastPostedEnvelope(vscode.postMessage);
const lastCommand = () => lastElementCommand(vscode.postMessage);


const linkArrayMeta = fieldMeta({
  name: 'Packages',
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

// mEdit's alignment of ['PkgA', 'PkgX'] and ['PkgA', 'PkgA'] in sequence: MyMod.esp's second PkgA
// is row [2], and its own element 1.
const linkArrayCompareResult: CompareResult = compareResultFixture({
  conflictAll: 'Override',
  overrides: [
    compareOverride({
      formKey: '000001:Fallout4.esm', plugin: 'Fallout4.esm',
      isWinner: false, editorId: 'TestNPC',
      fields: [{ metadata: decoyMeta, value: 4 }, { metadata: linkArrayMeta, value: ['PkgA', 'PkgX'] }],
      conflictThis: 'Master',
    }),
    compareOverride({
      formKey: '000001:Fallout4.esm', plugin: 'MyMod.esp',
      isWinner: true, editorId: 'TestNPC',
      fields: [{ metadata: decoyMeta, value: 4 }, { metadata: linkArrayMeta, value: ['PkgA', 'PkgA'] }],
      conflictThis: 'Override',
    }),
  ],
  diffs: [diffNode({
    fieldName: 'Packages',
    values: { 'Fallout4.esm': ['PkgA', 'PkgX'], 'MyMod.esp': ['PkgA', 'PkgA'] },
    winnerColumn: 'MyMod.esp',
    cellStates: { 'MyMod.esp': 'Override' },
    children: [
      diffNode({
        fieldName: '[0]',
        values: { 'Fallout4.esm': 'PkgA', 'MyMod.esp': 'PkgA' },
        indexes: { 'Fallout4.esm': 0, 'MyMod.esp': 0 },
        winnerColumn: 'MyMod.esp',
        cellStates: { 'MyMod.esp': 'IdenticalToMaster' },
      }),
      diffNode({
        fieldName: '[1]',
        values: { 'Fallout4.esm': 'PkgX', 'MyMod.esp': null },
        indexes: { 'Fallout4.esm': 1 },
        winnerColumn: 'Fallout4.esm',
        cellStates: {},
      }),
      diffNode({
        fieldName: '[2]',
        values: { 'Fallout4.esm': null, 'MyMod.esp': 'PkgA' },
        indexes: { 'MyMod.esp': 1 },
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
        indexes: { 'Fallout4.esm': 0, 'MyMod.esp': 0 },
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

describe('RecordPanel — array child rows (in sequence)', () => {
  beforeEach(() => {
    vi.stubGlobal('mEditFormKey', '000001:Fallout4.esm');
    currentCompare = linkArrayCompareResult;
  });
  afterEach(() => vi.unstubAllGlobals());

  it('parent array row shows [2] when collapsed', async () => {
    renderPanel();
    await waitFor(() => screen.getByText('Packages'));
    fireEvent.click(within(required(screen.getByText('Packages').closest('tr'), "Packages's row")).getByText('▼'));
    expect(screen.getAllByText('[2]').length).toBeGreaterThan(0);
    expect(screen.queryByText('{…}')).not.toBeInTheDocument();
  });

  // An element the column does not carry is nothing there — not a null link, which reads "—".
  it('row [1] is empty for MyMod.esp, whose array has no such element', async () => {
    renderPanel();
    await waitFor(() => screen.getByText('[1]'));
    const cells = required(screen.getByText('[1]').closest('tr'), 'the [1] row').querySelectorAll('td');
    expect(required(cells[1], "the [1] row's Fallout4.esm cell").textContent).toBe('PkgX');
    const mine = required(cells[2], "the [1] row's MyMod.esp cell");
    expect(mine.textContent).toBe('');
    expect(mine.querySelector('[data-open-trigger]')).toBeNull();
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

describe('RecordPanel — array editing', () => {
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
        diffNode({ fieldName: '[0]', values: { 'MyMod.esp': 1 }, indexes: { 'MyMod.esp': 0 }, winnerColumn: 'MyMod.esp', cellStates: {} }),
        diffNode({ fieldName: '[1]', values: { 'MyMod.esp': 2 }, indexes: { 'MyMod.esp': 1 }, winnerColumn: 'MyMod.esp', cellStates: {} }),
        diffNode({ fieldName: '[2]', values: { 'MyMod.esp': 3 }, indexes: { 'MyMod.esp': 2 }, winnerColumn: 'MyMod.esp', cellStates: {} }),
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
      diffNode({ fieldName: '[0]', values: { 'MyMod.esp': 11 }, indexes: { 'MyMod.esp': 0 }, winnerColumn: 'MyMod.esp', cellStates: {} }),
      diffNode({ fieldName: '[1]', values: { 'MyMod.esp': 22 }, indexes: { 'MyMod.esp': 1 }, winnerColumn: 'MyMod.esp', cellStates: {} }),
      diffNode({ fieldName: '[2]', values: { 'MyMod.esp': 33 }, indexes: { 'MyMod.esp': 2 }, winnerColumn: 'MyMod.esp', cellStates: {} }),
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

describe('RecordPanel — a keyed array\'s element is addressed at its position in this column', () => {
  const scriptMeta = fieldMeta({
    name: 'Scripts', type: 'array', isArray: true,
    keyMembers: ['name'],
    elementType: fieldMeta({
      name: '', type: 'struct',
      fields: [fieldMeta({ name: 'name', type: 'string' }), fieldMeta({ name: 'flags', type: 'string' })],
    }),
  });

  const scriptRow = (fieldName: string, held: Record<string, { name: string; flags: string }>, indexes: Record<string, number>) =>
    diffNode({
      fieldName,
      values: held,
      winnerColumn: 'MyMod.esp', cellStates: {}, indexes,
      children: [
        diffNode({ fieldName: 'name', values: Object.fromEntries(Object.entries(held).map(([c, s]) => [c, s.name])), winnerColumn: 'MyMod.esp', cellStates: {} }),
        diffNode({ fieldName: 'flags', values: Object.fromEntries(Object.entries(held).map(([c, s]) => [c, s.flags])), winnerColumn: 'MyMod.esp', cellStates: {} }),
      ],
    });

  function renderScripts(master: { name: string; flags: string }[], override: { name: string; flags: string }[], rows: ReturnType<typeof scriptRow>[]) {
    const client = panelClient(() => compareResultFixture({
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
        winnerColumn: 'MyMod.esp', cellStates: {}, children: rows,
      })],
    }), { plugins: [{ name: 'Fallout4.esm', isImmutable: true }, { name: 'MyMod.esp', isTracked: true }] });
    return render(<RecordPanel client={client} />);
  }

  const guard = { name: 'Guard', flags: 'g' };
  const ambush = { name: 'Ambush', flags: 'a' };
  async function renderGuardAfterAmbush() {
    renderScripts([{ name: 'Guard', flags: 'm' }], [guard, ambush], [
      scriptRow('Ambush', { 'MyMod.esp': ambush }, { 'MyMod.esp': 1 }),
      scriptRow('Guard', { 'Fallout4.esm': { name: 'Guard', flags: 'm' }, 'MyMod.esp': guard }, { 'Fallout4.esm': 0, 'MyMod.esp': 0 }),
    ]);
    await waitFor(() => screen.getAllByText('flags'));
  }

  const myCell = (row: Element) => {
    const cells = row.querySelectorAll('td');
    return required(cells[cells.length - 1], "the row's MyMod.esp cell");
  };
  const rowLabelled = (label: string, nth = 0) =>
    required(Array.from(document.querySelectorAll('tbody tr')).filter(tr => tr.querySelector('td')?.textContent.endsWith(label))[nth],
      `row '${label}' #${nth}`);

  beforeEach(() => {
    vi.stubGlobal('mEditFormKey', '000001:Fallout4.esm');
    vi.mocked(vscode.postMessage).mockClear();
  });
  afterEach(() => vi.unstubAllGlobals());

  it('offers add at the keyed array', async () => {
    await renderGuardAfterAmbush();

    const context: unknown = JSON.parse(myCell(rowLabelled('Scripts')).getAttribute('data-vscode-context') ?? '{}');
    expect(context).toMatchObject({ webviewSection: 'arrayParent', path: [member('Scripts')] });
  });

  it('a value edit on a keyed element posts set at its index in the written column', async () => {
    await renderGuardAfterAmbush();
    const cell = myCell(required(screen.getByText('a').closest('tr'), "the row for Ambush's 'flags'"));
    fireEvent.doubleClick(within(cell).getByText('a'));
    const input = required(cell.querySelector('input'), "the cell's input");
    fireEvent.change(input, { target: { value: 'EDITED' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(lastEnvelope()).toEqual({
      op: 'set', path: [member('Scripts'), at(1), member('flags')], value: 'EDITED',
    });
  });

  it('Delete on a keyed element fires remove element at its index', async () => {
    await renderGuardAfterAmbush();
    const cell = myCell(rowLabelled('Ambush'));
    fireEvent.click(cell);
    fireEvent.keyDown(cell, { key: 'Delete' });

    expect(lastCommand()).toMatchObject({ command: 'removeElement', context: { path: [member('Scripts'), at(1)] } });
  });

  it('Alt+ArrowUp and Alt+ArrowDown on a keyed element leave the key unhandled and fire nothing', async () => {
    await renderGuardAfterAmbush();
    for (const [label, key] of [['Ambush', 'ArrowUp'], ['Guard', 'ArrowDown']] as const) {
      const cell = myCell(rowLabelled(label));
      fireEvent.click(cell);
      expect(fireEvent.keyDown(cell, { key, altKey: true })).toBe(true);
    }

    expect(lastCommand()).toBeUndefined();
  });

  it('a keyed element\'s menu offers neither move', async () => {
    await renderGuardAfterAmbush();

    for (const label of ['Ambush', 'Guard']) {
      expect(JSON.parse(myCell(rowLabelled(label)).getAttribute('data-vscode-context') ?? '{}'))
        .toMatchObject({ webviewSection: 'arrayElement', canMoveUp: false, canMoveDown: false });
    }
  });

  it('Delete on the second of two elements sharing a key fires remove element at its index', async () => {
    const second = { name: 'Guard', flags: 'h' };
    renderScripts([], [guard, second], [
      scriptRow('Guard', { 'MyMod.esp': guard }, { 'MyMod.esp': 0 }),
      scriptRow('Guard', { 'MyMod.esp': second }, { 'MyMod.esp': 1 }),
    ]);
    await waitFor(() => expect(screen.getAllByText('flags')).toHaveLength(2));
    const cell = myCell(rowLabelled('Guard', 1));
    fireEvent.click(cell);
    fireEvent.keyDown(cell, { key: 'Delete' });

    expect(lastCommand()).toMatchObject({ command: 'removeElement', context: { path: [member('Scripts'), at(1)] } });
  });

  it('collapsing the second of two elements sharing a key leaves the first expanded', async () => {
    const second = { name: 'Guard', flags: 'h' };
    renderScripts([], [guard, second], [
      scriptRow('Guard', { 'MyMod.esp': guard }, { 'MyMod.esp': 0 }),
      scriptRow('Guard', { 'MyMod.esp': second }, { 'MyMod.esp': 1 }),
    ]);
    await waitFor(() => expect(screen.getAllByText('flags')).toHaveLength(2));

    fireEvent.click(required(rowLabelled('Guard', 1).querySelector('button'), "the second Guard row's toggle"));

    await waitFor(() => expect(screen.getAllByText('flags')).toHaveLength(1));
    expect(rowLabelled('Guard', 0).querySelector('td')?.textContent).toBe('▼Guard');
    expect(rowLabelled('Guard', 1).querySelector('td')?.textContent).toBe('▶Guard');
  });
});

// Aligned in sequence, an element sits at its own position in each column; the hop is that position
// in the column being written, whatever the row's place and whatever else holds the same value.
describe('RecordPanel — an element of an array without a key is addressed at its position in this column', () => {
  function renderLinkArrayPanel() {
    const client = panelClient(() => linkArrayCompareResult, {
      plugins: [{ name: 'Fallout4.esm', isImmutable: true }, { name: 'MyMod.esp', isTracked: true }],
    });
    return render(<RecordPanel client={client} />);
  }

  const myCell = (rowLabel: string) => {
    const cells = required(screen.getByText(rowLabel).closest('tr'), `the ${rowLabel} row`).querySelectorAll('td');
    return required(cells[cells.length - 1], `the ${rowLabel} row's MyMod.esp cell`);
  };

  beforeEach(() => {
    vi.stubGlobal('mEditFormKey', '000001:Fallout4.esm');
    vi.mocked(vscode.postMessage).mockClear();
  });
  afterEach(() => vi.unstubAllGlobals());

  it('a picked replacement posts set at the element\'s own index in the written column', async () => {
    renderLinkArrayPanel();
    await waitFor(() => screen.getByText('[2]'));
    const cell = myCell('[2]');
    fireEvent.click(cell);
    fireEvent.doubleClick(within(cell).getByText('PkgA'));

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
      op: 'set', path: [member('Packages'), at(1)], value: '000123:Fallout4.esm',
    }));
  });

  it('Delete fires remove element at the element\'s own index', async () => {
    renderLinkArrayPanel();
    await waitFor(() => screen.getByText('[2]'));
    const cell = myCell('[2]');
    fireEvent.click(cell);
    fireEvent.keyDown(cell, { key: 'Delete' });

    expect(lastCommand()).toMatchObject({ command: 'removeElement', context: { path: [member('Packages'), at(1)] } });
  });

  it('Alt+ArrowUp fires move element up from the element\'s own index', async () => {
    renderLinkArrayPanel();
    await waitFor(() => screen.getByText('[2]'));
    const cell = myCell('[2]');
    fireEvent.click(cell);
    fireEvent.keyDown(cell, { key: 'ArrowUp', altKey: true });

    expect(lastCommand()).toMatchObject({ command: 'moveElementUp', context: { path: [member('Packages'), at(1)] } });
  });

  it('Alt+ArrowDown on the column\'s own last element fires nothing', async () => {
    renderLinkArrayPanel();
    await waitFor(() => screen.getByText('[2]'));
    const cell = myCell('[2]');
    fireEvent.click(cell);

    expect(fireEvent.keyDown(cell, { key: 'ArrowDown', altKey: true })).toBe(true);
    expect(lastCommand()).toBeUndefined();
  });

  it('offers add at the array', async () => {
    renderLinkArrayPanel();
    await waitFor(() => screen.getByText('Packages'));
    const context: unknown = JSON.parse(myCell('Packages').getAttribute('data-vscode-context') ?? '{}');
    expect(context).toMatchObject({ webviewSection: 'arrayParent', path: [member('Packages')] });
  });
});

// A null slot is an element its column holds, so the elements after it sit one place further on.
describe('RecordPanel — an element after a null slot is addressed at its own index', () => {
  const itemsMeta = fieldMeta({ name: 'Items', type: 'array', isArray: true, elementType: fieldMeta({ name: '', type: 'string' }) });
  // mEdit's alignment of ['A', 'B'] and ['A', null, 'B'].
  const withNullSlot = compareResultFixture({
    overrides: [
      compareOverride({
        formKey: '000001:Fallout4.esm', plugin: 'Fallout4.esm', editorId: 'TestNPC',
        fields: [{ metadata: itemsMeta, value: ['A', 'B'] }],
      }),
      compareOverride({
        formKey: '000001:Fallout4.esm', plugin: 'MyMod.esp', isWinner: true, editorId: 'TestNPC',
        fields: [{ metadata: itemsMeta, value: ['A', null, 'B'] }],
      }),
    ],
    diffs: [diffNode({
      fieldName: 'Items',
      values: { 'Fallout4.esm': ['A', 'B'], 'MyMod.esp': ['A', null, 'B'] },
      children: [
        diffNode({ fieldName: '[0]', values: { 'Fallout4.esm': 'A', 'MyMod.esp': 'A' }, indexes: { 'Fallout4.esm': 0, 'MyMod.esp': 0 } }),
        diffNode({ fieldName: '[1]', values: { 'Fallout4.esm': null, 'MyMod.esp': null }, indexes: { 'MyMod.esp': 1 } }),
        diffNode({ fieldName: '[2]', values: { 'Fallout4.esm': 'B', 'MyMod.esp': 'B' }, indexes: { 'Fallout4.esm': 1, 'MyMod.esp': 2 } }),
      ],
    })],
  });

  const myCell = () => {
    const cells = required(screen.getByText('[2]').closest('tr'), 'the [2] row').querySelectorAll('td');
    return required(cells[cells.length - 1], "the [2] row's MyMod.esp cell");
  };

  beforeEach(() => {
    vi.stubGlobal('mEditFormKey', '000001:Fallout4.esm');
    vi.mocked(vscode.postMessage).mockClear();
    render(<RecordPanel client={panelClient(() => withNullSlot, {
      plugins: [{ name: 'Fallout4.esm', isImmutable: true }, { name: 'MyMod.esp', isTracked: true }],
    })} />);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('Delete removes the element at its own index', async () => {
    await waitFor(() => screen.getByText('[2]'));
    fireEvent.click(myCell());
    fireEvent.keyDown(myCell(), { key: 'Delete' });

    expect(lastCommand()).toMatchObject({ command: 'removeElement', context: { path: [member('Items'), at(2)] } });
  });

  it('Alt+ArrowUp moves the element from its own index', async () => {
    await waitFor(() => screen.getByText('[2]'));
    fireEvent.click(myCell());
    fireEvent.keyDown(myCell(), { key: 'ArrowUp', altKey: true });

    expect(lastCommand()).toMatchObject({ command: 'moveElementUp', context: { path: [member('Items'), at(2)] } });
  });

  it('an edit sets the element at its own index', async () => {
    await waitFor(() => screen.getByText('[2]'));
    fireEvent.doubleClick(within(myCell()).getByText('B'));
    const input = required(myCell().querySelector('input'), "the cell's input");
    fireEvent.change(input, { target: { value: 'Z' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(lastEnvelope()).toEqual({ op: 'set', path: [member('Items'), at(2)], value: 'Z' });
  });
});
