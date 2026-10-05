import '@testing-library/jest-dom';
import React from 'react';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { describe, it, expect, vi, afterEach } from 'vitest';

const pickFormKeyBehindAcquireVsCodeApi = vi.fn<(seed: string, validTypes: string[]) => Promise<string | null>>().mockResolvedValue(null);
vi.mock('./nativeBridge', () => ({
  pickFormKey: (seed: string, validTypes: string[]) => pickFormKeyBehindAcquireVsCodeApi(seed, validTypes),
}));

import { DiffRow } from './DiffRow';
import type { Column, PathSegment } from './recordUtils';
import type { ColumnKey, CompareOverride, FieldDiff, FieldMetadata, FormKeyResolution } from './types';
import { fieldRow } from './recordRows';
import { columnKey } from '../../src/wire/columnKey';
import { pluginAddressOf } from '../../src/wire/pluginAddress';
import { DIMMED_OPACITY } from './gridStyles';
import { diffNode, fieldMeta, parseJsonRecord, required } from './test/fixtures';

const strMeta = fieldMeta({ name: 'Name', type: 'string' });
const intMeta = fieldMeta({ name: 'Level', type: 'int' });
const CHILDREN_THAT_OFFER_THE_EXPAND_TOGGLE: FieldDiff[] = [diffNode({ fieldName: 'child' })];

function override(plugin: string, partial: Partial<CompareOverride> = {}): CompareOverride {
  return {
    formKey: '000001:Fallout4.esm', plugin, loadIndex: '00', isWinner: false,
    editorId: 'TestNPC', fields: [{ metadata: strMeta, value: 'disk-value' }],
    conflictThis: 'Master', origin: 'Data',
    recordType: 'npc_', isPartialForm: false, isInOverwrite: false,
    ...partial,
  };
}

function diskColumn(o: CompareOverride): Column {
  return { key: columnKey(pluginAddressOf(o)), override: o };
}
function diff(partial: Partial<FieldDiff> = {}): FieldDiff {
  return diffNode({
    fieldName: 'Name',
    values: { 'Fallout4.esm': 'disk-value', 'MyMod.esp': 'disk-value' },
    winnerColumn: 'Fallout4.esm',
    ...partial,
  });
}

type RowProps = Omit<React.ComponentProps<typeof DiffRow>, 'row'> & {
  diff: FieldDiff;
  meta: FieldMetadata;
  context: { path: PathSegment[]; rootField: string; depth: number };
  rowKey: string;
  parentRowKey: string | null;
  editableColumns: ReadonlySet<ColumnKey>;
  recordLabel: string;
  ownerPresent?: (column: ColumnKey) => boolean;
};

function baseProps(overrides: Partial<RowProps> = {}): RowProps {
  const master = override('Fallout4.esm');
  const mod = override('MyMod.esp');
  const diffOfThisCallBehindTheDefaultContext = overrides.diff ?? diff();
  return {
    diff: diffOfThisCallBehindTheDefaultContext,
    meta: strMeta,
    columns: [diskColumn(master), diskColumn(mod)],
    columnStyle: () => ({}),
    collapsedColumns: new Set(),
    editableColumns: new Set(),
    recordLabel: 'TestNPC [000001:Fallout4.esm]',
    context: { path: [], rootField: diffOfThisCallBehindTheDefaultContext.fieldName, depth: 0 },
    rowKey: 'Name',
    parentRowKey: null,
    focusedCell: null,
    onFocusCell: vi.fn(),
    onEdit: vi.fn(),
    onAddElement: vi.fn(),
    ...overrides,
  };
}

function renderRow(props: Partial<RowProps> = {}) {
  const { diff: node, meta, context, rowKey, parentRowKey, editableColumns, recordLabel, ownerPresent, ...rowProps } = baseProps(props);
  const row = fieldRow(node, meta, {
    ...context, key: rowKey, parent: parentRowKey, present: ownerPresent ?? (() => true), editable: editableColumns,
  }, rowProps.columns, recordLabel);
  return render(<table><tbody><DiffRow {...rowProps} row={row} /></tbody></table>);
}

describe('DiffRow — top-level scalar row', () => {
  it('renders the field name and both plugin values', () => {
    renderRow();
    expect(screen.getByText('Name')).toBeInTheDocument();
    expect(screen.getAllByText('disk-value').length).toBe(2);
  });

  it('does not render an expand toggle when there are no children', () => {
    renderRow();
    expect(screen.queryByRole('button', { name: '▶' })).not.toBeInTheDocument();
  });

  it('renders the expand toggle when hasChildren is set, and calls onToggle', () => {
    const onToggle = vi.fn();
    renderRow({ diff: diff({ children: CHILDREN_THAT_OFFER_THE_EXPAND_TOGGLE }), isExpanded: false, onToggle });
    const btn = screen.getByText('▶');
    fireEvent.click(btn);
    expect(onToggle).toHaveBeenCalled();
  });

  it('shows ▼ when expanded', () => {
    renderRow({ diff: diff({ children: CHILDREN_THAT_OFFER_THE_EXPAND_TOGGLE }), isExpanded: true });
    expect(screen.getByText('▼')).toBeInTheDocument();
  });

  it('with no editable columns wired, a value cell opens no editor on click, second click or double click', () => {
    renderRow({ meta: intMeta, diff: diff({ values: { 'Fallout4.esm': 5, 'MyMod.esp': 5 } }) });
    const cell = required(screen.getAllByText('5')[1], "the second '5' match (MyMod.esp)");
    fireEvent.click(cell);
    fireEvent.click(cell);
    fireEvent.doubleClick(cell);
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(screen.queryByDisplayValue('5')).not.toBeInTheDocument();
  });

  it('double click on an immutable disk cell opens nothing', () => {
    renderRow({ focusedCell: null, meta: intMeta, diff: diff({ values: { 'Fallout4.esm': 5, 'MyMod.esp': 5 } }) });
    fireEvent.doubleClick(required(screen.getAllByText('5')[0], "the first '5' match (Fallout4.esm)"));
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  });

  it('double click on the label column toggles expand/collapse without breaking the existing button', () => {
    const onToggle = vi.fn();
    renderRow({ diff: diff({ children: CHILDREN_THAT_OFFER_THE_EXPAND_TOGGLE }), isExpanded: false, onToggle });
    const labelCell = required(screen.getByText('▶').closest('td'), "the '▶' cell's td ancestor");
    fireEvent.doubleClick(labelCell);
    expect(onToggle).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByText('▶'));
    expect(onToggle).toHaveBeenCalledTimes(2);
  });

  it('double click on the label column does nothing for a leaf row with no children', () => {
    renderRow();
    const labelCell = required(screen.getByText('Name').closest('td'), "the 'Name' cell's td ancestor");
    expect(() => fireEvent.doubleClick(labelCell)).not.toThrow();
  });
});

describe('DiffRow — dimmed columns, the panel deciding each column\'s look and the row applying it to every cell of that column and asking nothing else', () => {
  it('dims a cell whose column the panel named dimmed', () => {
    const dimmed = columnKey({ name: 'MyMod.esp', origin: 'Data' });
    renderRow({ columnStyle: column => (column === dimmed ? { opacity: DIMMED_OPACITY } : {}) });
    const cell = required(required(screen.getAllByText('disk-value')[1], "the 'disk-value' match at index 1").closest('td'), "its td ancestor");
    expect(cell).toHaveStyle({ opacity: String(DIMMED_OPACITY) });
  });

  it('does not dim a column outside that set', () => {
    renderRow();
    const cell = required(required(screen.getAllByText('disk-value')[1], "the 'disk-value' match at index 1").closest('td'), "its td ancestor");
    expect(cell).not.toHaveStyle({ opacity: String(DIMMED_OPACITY) });
  });
});

describe('DiffRow — drag affordance on leaf cells', () => {
  it('shows no grab cursor at rest on a leaf cell, the grid resting on the default arrow with drag unadvertised as in xEdit', () => {
    renderRow();
    const cell = required(required(screen.getAllByText('disk-value')[0], "the 'disk-value' match at index 0").closest('td'), "its td ancestor");
    expect(cell.style.cursor).not.toBe('grab');
  });
});

describe('DiffRow — cell focus, whose identity lives above DiffRow: it reports the clicked row and plugin and reflects back the `focusedCell` it was given', () => {
  it('clicking a value cell reports its row and plugin to onFocusCell', () => {
    const onFocusCell = vi.fn();
    renderRow({ onFocusCell });
    fireEvent.click(required(screen.getAllByText('disk-value')[1], "the 'disk-value' match at index 1"));
    expect(onFocusCell).toHaveBeenCalledWith('Name', 'MyMod.esp');
  });

  it('a disk cell matching focusedCell is tabbable and carries real DOM focus', () => {
    renderRow({ focusedCell: { rowKey: 'Name', plugin: columnKey({ name: 'MyMod.esp', origin: 'Data' }) } });
    const cell = required(required(screen.getAllByText('disk-value')[1], "the 'disk-value' match at index 1").closest('td'), "its td ancestor");
    expect(cell).toHaveAttribute('tabindex', '0');
    expect(cell).toHaveFocus();
  });

  it('a cell not matching focusedCell does not carry DOM focus', () => {
    renderRow({ focusedCell: { rowKey: 'Name', plugin: columnKey({ name: 'MyMod.esp', origin: 'Data' }) } });
    const cell = required(required(screen.getAllByText('disk-value')[0], "the 'disk-value' match at index 0").closest('td'), "its td ancestor");
    expect(cell).not.toHaveFocus();
  });

  it('the row containing the focused cell is highlighted', () => {
    renderRow({ focusedCell: { rowKey: 'Name', plugin: columnKey({ name: 'MyMod.esp', origin: 'Data' }) } });
    const row = required(required(screen.getAllByText('disk-value')[1], "the 'disk-value' match at index 1").closest('tr'), "its tr ancestor");
    expect(row.style.boxShadow).toContain('var(--vscode-focusBorder');
  });

  it('a row with no focused cell in it is not highlighted', () => {
    renderRow({ focusedCell: null });
    const row = required(required(screen.getAllByText('disk-value')[0], "the 'disk-value' match at index 0").closest('tr'), "its tr ancestor");
    expect(row.style.boxShadow).toBe('');
  });

  it('the focused cell itself is visibly distinguished from the rest of its row', () => {
    renderRow({ focusedCell: { rowKey: 'Name', plugin: columnKey({ name: 'MyMod.esp', origin: 'Data' }) } });
    const focusedTd = required(required(screen.getAllByText('disk-value')[1], "the 'disk-value' match at index 1").closest('td'), "its td ancestor");
    const otherTd = required(required(screen.getAllByText('disk-value')[0], "the 'disk-value' match at index 0").closest('td'), "its td ancestor");
    expect(focusedTd.style.boxShadow).toContain('var(--vscode-focusBorder');
    const row = required(focusedTd.closest('tr'), "the focused cell's tr ancestor");
    expect(focusedTd.style.boxShadow).not.toBe(row.style.boxShadow);
    expect(otherTd.style.boxShadow).toBe('');
  });

  it('no cell carries DOM focus when focusedCell is null', () => {
    renderRow({ focusedCell: null });
    expect(document.body).toHaveFocus();
  });

  it('focusing one of two same-filename, different-origin columns does not focus the other, as a bare-string FocusedCell.plugin would read both as focused', () => {
    const colA = override('Shared.esp', { origin: 'ModA' });
    const colB = override('Shared.esp', { origin: 'ModB' });
    renderRow({
      columns: [diskColumn(colA), diskColumn(colB)],
      diff: diff({ values: { [columnKey({ name: 'Shared.esp', origin: 'ModA' })]: 'disk-value', [columnKey({ name: 'Shared.esp', origin: 'ModB' })]: 'disk-value' } }),
      focusedCell: { rowKey: 'Name', plugin: columnKey({ name: 'Shared.esp', origin: 'ModA' }) },
    });
    const cells = screen.getAllByText('disk-value');
    const cellA = required(required(cells[0], "the first 'disk-value' match").closest('td'), "its td ancestor");
    const cellB = required(required(cells[1], "the second 'disk-value' match").closest('td'), "its td ancestor");

    expect(cellA).toHaveFocus();
    expect(cellB).not.toHaveFocus();
  });
});

describe('DiffRow — FormKey leaf resolution is independent of the parent field aggregate: go to record keys off the leaf\'s own `diff.resolutions` entry, so a dangling sibling does not hide a live reference beside it', () => {
  const fkMeta = fieldMeta({ name: '', type: 'formKey' });
  const validType: FormKeyResolution = { state: 'ResolvedValidType', recordType: 'kywd', editorId: 'SomeKeyword' };
  const wrongType: FormKeyResolution = { state: 'ResolvedWrongType', recordType: 'npc_', editorId: 'SomeNpc' };
  const unresolved: FormKeyResolution = { state: 'Unresolved', recordType: null, editorId: null };

  function leafPropsUnderParentWithDanglingSiblingCheckError(
    kind: 'array-element' | 'struct-child',
    resolution: FormKeyResolution,
    value = '000019:Fallout4.esm',
  ) {
    const parentFieldName = kind === 'array-element' ? 'Keywords' : 'LinkedRef';
    const parentType = kind === 'array-element' ? 'array' : 'struct';
    const master = override('Fallout4.esm', {
      fields: [{
        metadata: fieldMeta({ name: parentFieldName, type: parentType, isArray: kind === 'array-element' }),
        value: kind === 'array-element' ? [] : {},
        checkError: 'aggregate: one sibling is dangling',
      }],
    });
    const path: PathSegment[] = kind === 'array-element'
      ? [{ kind: 'index', index: 1 }]
      : [{ kind: 'member', name: 'Reference' }];
    return baseProps({
      diff: diff({ fieldName: kind === 'array-element' ? '[1]' : 'Reference', values: { 'Fallout4.esm': value }, resolutions: { 'Fallout4.esm': resolution } }),
      columns: [diskColumn(master)],
      meta: fkMeta,
      context: { path, rootField: parentFieldName, depth: path.length },
    });
  }

  function menuOf(label: string): Record<string, unknown> {
    const td = required(screen.getByText(label).closest('td'), 'the reference cell');
    return parseJsonRecord(required(td.getAttribute('data-vscode-context'), "the cell's data-vscode-context attribute"));
  }

  it.each([
    ['an array-element', 'array-element', validType, '000019:Fallout4.esm', 'SomeKeyword [000019:Fallout4.esm]'],
    ['an array-element wrong-type', 'array-element', wrongType, '00001A:Fallout4.esm', 'SomeNpc [00001A:Fallout4.esm]'],
    ['a struct-child', 'struct-child', validType, '000019:Fallout4.esm', 'SomeKeyword [000019:Fallout4.esm]'],
    ['a struct-child wrong-type', 'struct-child', wrongType, '00001A:Fallout4.esm', 'SomeNpc [00001A:Fallout4.esm]'],
  ] as const)('%s leaf that resolves offers go to record despite the parent field checkError', (_what, kind, resolution, value, label) => {
    renderRow(leafPropsUnderParentWithDanglingSiblingCheckError(kind, resolution, value));
    const menu = menuOf(label);
    expect(menu.webviewSection).toEqual(expect.stringContaining('reference'));
    expect(menu.referenceTarget).toBe(value);
  });

  it.each(['array-element', 'struct-child'] as const)('%s leaf that is unresolved offers no go to record', (kind) => {
    renderRow(leafPropsUnderParentWithDanglingSiblingCheckError(kind, unresolved, 'FFFFFF:Dangling.esm'));
    expect(menuOf('FFFFFF:Dangling.esm').webviewSection).not.toEqual(expect.stringContaining('reference'));
  });
});

describe('DiffRow — the check error is the diff node\'s own, per column', () => {
  const locationMeta = fieldMeta({ name: 'Location', type: 'struct', fields: [fieldMeta({ name: 'aliasId', type: 'int' })] });
  const fkMeta = fieldMeta({ name: 'Reference', type: 'formKey', validFormKeyTypes: ['REFR'] });

  const decoyed = (plugin: string) => override(plugin, {
    fields: [
      { metadata: fieldMeta({ name: 'Level', type: 'int' }), value: 4, checkError: 'decoy: a different field is dangling' },
      { metadata: locationMeta, value: {}, checkError: 'decoy: the root field\'s own error' },
    ],
  });

  it('shows the warning from the row\'s own diff node, not from any field in the column', () => {
    renderRow({
      diff: diff({
        fieldName: 'Location', values: { 'Fallout4.esm': {} },
        checkErrors: { 'Fallout4.esm': 'Location: its reference is dangling' },
      }),
      meta: locationMeta,
      columns: [diskColumn(decoyed('Fallout4.esm'))],
      context: { path: [], rootField: 'Location', depth: 0 },
    });
    expect(screen.getByTitle('Location: its reference is dangling')).toBeInTheDocument();
    expect(screen.queryByTitle('decoy: a different field is dangling')).not.toBeInTheDocument();
    expect(screen.queryByTitle('decoy: the root field\'s own error')).not.toBeInTheDocument();
  });

  it('warns only in the column whose entry the node carries', () => {
    renderRow({
      diff: diff({
        fieldName: 'Location', values: { 'Fallout4.esm': {}, 'MyMod.esp': {} },
        checkErrors: { 'MyMod.esp': 'Location: its reference is dangling' },
      }),
      meta: locationMeta,
      columns: [diskColumn(decoyed('Fallout4.esm')), diskColumn(decoyed('MyMod.esp'))],
      context: { path: [], rootField: 'Location', depth: 0 },
    });
    const cells = screen.getAllByText('{…}').map(s => required(s.closest('td'), "its td ancestor"));
    expect(within(required(cells[0], "the first '{…}' cell")).queryByTitle('Location: its reference is dangling')).not.toBeInTheDocument();
    expect(within(required(cells[1], "the second '{…}' cell")).getByTitle('Location: its reference is dangling')).toBeInTheDocument();
  });

  const nested = {
    meta: fkMeta,
    columns: [diskColumn(decoyed('Fallout4.esm'))],
    context: { path: [{ kind: 'member', name: 'Reference' }] as PathSegment[], rootField: 'Location', depth: 1 },
  };

  it('a struct-member row shows the error its own node carries', () => {
    renderRow({
      ...nested,
      diff: diff({
        fieldName: 'Reference', values: { 'Fallout4.esm': 'FFFFFF:Dangling.esm' },
        checkErrors: { 'Fallout4.esm': 'Reference: [FFFFFF:Dangling.esm] <Error: Could not be resolved>' },
      }),
    });
    expect(screen.getByTitle('Reference: [FFFFFF:Dangling.esm] <Error: Could not be resolved>')).toBeInTheDocument();
  });

  it('a struct-member row whose node carries none shows none', () => {
    renderRow({
      ...nested,
      diff: diff({ fieldName: 'Reference', values: { 'Fallout4.esm': '000019:Fallout4.esm' } }),
    });
    expect(screen.queryByText('⚠')).not.toBeInTheDocument();
  });

  it('an array-element row shows its own error, so an element hop does not suppress it', () => {
    renderRow({
      diff: diff({
        fieldName: '[1]', values: { 'Fallout4.esm': 'FFFFFF:Dangling.esm' },
        checkErrors: { 'Fallout4.esm': '[FFFFFF:Dangling.esm] <Error: Could not be resolved>' },
      }),
      meta: fieldMeta({ name: '', type: 'formKey' }),
      columns: [diskColumn(decoyed('Fallout4.esm'))],
      context: { path: [{ kind: 'index', index: 1 }], rootField: 'Keywords', depth: 1 },
    });
    expect(screen.getByTitle('[FFFFFF:Dangling.esm] <Error: Could not be resolved>')).toBeInTheDocument();
  });
});

describe('DiffRow — flags cell wiring', () => {
  const flagMeta = fieldMeta({
    name: 'Flags', type: 'flags',
    enumMembers: [{ value: 'A', bitValue: '1' }, { value: 'B', bitValue: '2' }],
  });

  function flagsRow(overrides: Partial<RowProps> = {}) {
    return renderRow({
      meta: flagMeta,
      diff: diff({ values: { 'Fallout4.esm': ['A'], 'MyMod.esp': ['A'] } }),
      ...overrides,
    });
  }

  it('a click on a flag in a non-editable column writes nothing', () => {
    const onEdit = vi.fn();
    flagsRow({ isExpanded: true, editableColumns: new Set([columnKey({ name: 'MyMod.esp', origin: 'Data' })]), onEdit });
    fireEvent.click(required(screen.getAllByRole('checkbox')[1], "the second checkbox (Fallout4.esm's B)"));
    expect(onEdit).not.toHaveBeenCalled();
  });

  it('a flags row, which has the collapse toggle though its children are the checkbox lines inside the cell rather than child rows, starts collapsed: chevron closed, compact summary, no checkboxes', () => {
    const onToggle = vi.fn();
    flagsRow({ onToggle });
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    expect(screen.getAllByText('A')).toHaveLength(2);
    const btn = screen.getByRole('button', { name: '▶' });
    fireEvent.click(btn);
    expect(onToggle).toHaveBeenCalled();
  });

  it('toggling a checkbox writes the names now set, at the row\'s path, to the column\'s plugin copy', () => {
    const onEdit = vi.fn();
    flagsRow({
      isExpanded: true,
      editableColumns: new Set([columnKey({ name: 'MyMod.esp', origin: 'Data' })]),
      onEdit,
    });
    fireEvent.click(required(screen.getAllByRole('checkbox')[3], "the fourth checkbox (MyMod.esp's B)"));
    expect(onEdit).toHaveBeenCalledWith(columnKey({ name: 'MyMod.esp', origin: 'Data' }), [{ kind: 'member', name: 'Name' }], ['A', 'B']);
  });
});

describe('DiffRow — formKey cell wiring', () => {
  const fkMeta = fieldMeta({ name: 'Race', type: 'formKey', validFormKeyTypes: ['race'] });

  function fkRow(overrides: Partial<RowProps> = {}) {
    return renderRow({
      meta: fkMeta,
      diff: diff({ values: { 'Fallout4.esm': '000019:Fallout4.esm', 'MyMod.esp': '000019:Fallout4.esm' } }),
      ...overrides,
    });
  }

  afterEach(() => { pickFormKeyBehindAcquireVsCodeApi.mockClear(); });

  it('a formKey cell in a non-editable column does not open the picker when clicked', () => {
    fkRow({ focusedCell: { rowKey: 'Name', plugin: columnKey({ name: 'MyMod.esp', origin: 'Data' }) } });
    fireEvent.click(required(screen.getAllByText('000019:Fallout4.esm')[1], "the '000019:Fallout4.esm' match at index 1"));
    expect(pickFormKeyBehindAcquireVsCodeApi).not.toHaveBeenCalled();
  });

  it('a formKey cell in an editable, focused column opens the picker with the field’s valid types', () => {
    fkRow({
      editableColumns: new Set([columnKey({ name: 'MyMod.esp', origin: 'Data' })]),
      focusedCell: { rowKey: 'Name', plugin: columnKey({ name: 'MyMod.esp', origin: 'Data' }) },
    });
    fireEvent.click(required(screen.getAllByText('000019:Fallout4.esm')[1], "the '000019:Fallout4.esm' match at index 1"));
    expect(pickFormKeyBehindAcquireVsCodeApi).toHaveBeenCalledWith('000019:Fallout4.esm', ['race']);
  });

  it('committing a picked FormKey writes the picked value, at the row\'s path, to the column\'s plugin copy', async () => {
    const onEdit = vi.fn();
    pickFormKeyBehindAcquireVsCodeApi.mockResolvedValueOnce('00001A:Fallout4.esm');
    fkRow({
      editableColumns: new Set([columnKey({ name: 'MyMod.esp', origin: 'Data' })]),
      onEdit,
      focusedCell: { rowKey: 'Name', plugin: columnKey({ name: 'MyMod.esp', origin: 'Data' }) },
    });
    fireEvent.click(required(screen.getAllByText('000019:Fallout4.esm')[1], "the '000019:Fallout4.esm' match at index 1"));
    await vi.waitFor(() => expect(onEdit)
      .toHaveBeenCalledWith(columnKey({ name: 'MyMod.esp', origin: 'Data' }), [{ kind: 'member', name: 'Name' }], '00001A:Fallout4.esm'));
  });
});

describe('DiffRow — string cell right-click menu, the extended editor\'s only trigger, driven by the `data-vscode-context` attribute DiskCell carries; no left-click gesture reaches it', () => {
  function stringContext(text: string, index = 0): Record<string, unknown> {
    const textEl = required(screen.getAllByText(text)[index], `the '${text}' match at index ${index}`);
    const td = textEl.closest('td');
    const attr = td?.getAttribute('data-vscode-context');
    expect(attr).toBeTruthy();
    return parseJsonRecord(required(attr, "the cell's data-vscode-context attribute"));
  }

  it('a mutable string cell carries a stringValue context with readOnly: false, its current value, and for a top-level row a wire path of the record\'s own member alone', () => {
    renderRow({
      editableColumns: new Set([columnKey({ name: 'MyMod.esp', origin: 'Data' })]),
    });
    expect(stringContext('disk-value', 1)).toEqual({
      webviewSection: 'cell editableCell stringValue',
      holdsValue: true,
      copyText: 'disk-value',
      formKey: '000001:Fallout4.esm',
      plugin: 'MyMod.esp',
      origin: 'Data',
      recordLabel: 'TestNPC [000001:Fallout4.esm]',
      fieldName: 'Name',
      value: 'disk-value',
      readOnly: false,
      path: [{ kind: 'member', name: 'Name' }],
      preventDefaultContextMenuItems: true,
    });
  });

  it('an immutable string cell still carries the context, with readOnly: true', () => {
    renderRow();
    const ctx = stringContext('disk-value', 0);
    expect(ctx.webviewSection).toBe('cell stringValue');
    expect(ctx.readOnly).toBe(true);
  });

  it('a nested string cell carries its whole wire path, so its save does not land on the root, and is titled by its own label', () => {
    const path: PathSegment[] = [{ kind: 'member', name: 'Sub' }];
    renderRow({
      editableColumns: new Set([columnKey({ name: 'MyMod.esp', origin: 'Data' })]),
      context: { path, rootField: 'Struct', depth: path.length },
    });
    const ctx = stringContext('disk-value', 1);
    expect(ctx.path).toEqual([{ kind: 'member', name: 'Struct' }, { kind: 'member', name: 'Sub' }]);
    expect(ctx.fieldName).toBe('Name');
  });

  it('double click opens the inline editor in place, never a tab, calling no callback', () => {
    renderRow({ editableColumns: new Set([columnKey({ name: 'MyMod.esp', origin: 'Data' })]) });
    fireEvent.doubleClick(required(screen.getAllByText('disk-value')[1], "the 'disk-value' match at index 1"));
    expect(screen.getByDisplayValue('disk-value')).toBeInTheDocument();
  });
});

describe('DiffRow — array parent/element right-click context, a nested array\'s element being more than one hop from its subtree root, which the subtree root plus a bare scalar index could never express', () => {
  function vscodeContextFor(text: string, index = 0): Record<string, unknown> {
    const textEl = required(screen.getAllByText(text)[index], `the '${text}' match at index ${index}`);
    const td = textEl.closest('td');
    const attr = td?.getAttribute('data-vscode-context');
    expect(attr).toBeTruthy();
    return parseJsonRecord(required(attr, "the cell's data-vscode-context attribute"));
  }

  const intArrayMeta = fieldMeta({
    name: 'Items', type: 'array', isArray: true,
    elementType: fieldMeta({ name: '', type: 'int' }),
  });
  const intMetaLeaf = fieldMeta({ name: '', type: 'int' });

  function arrayDiff(partial: Partial<FieldDiff> = {}): FieldDiff {
    return diffNode({
      fieldName: 'Items',
      values: { 'Fallout4.esm': [1, 2], 'MyMod.esp': [1, 2] },
      winnerColumn: 'Fallout4.esm',
      children: CHILDREN_THAT_OFFER_THE_EXPAND_TOGGLE,
      ...partial,
    });
  }

  it('a top-level array-parent row\'s context carries the one member hop of its own field', () => {
    renderRow({
      diff: arrayDiff(),
      meta: intArrayMeta,
      editableColumns: new Set([columnKey({ name: 'MyMod.esp', origin: 'Data' })]),
      context: { path: [], rootField: 'Items', depth: 0 },
      isExpanded: false,
    });
    const ctx = vscodeContextFor('[2]', 1);
    expect(ctx.webviewSection).toBe('cell arrayParent editableCell');
    expect(ctx.path).toEqual([{ kind: 'member', name: 'Items' }]);
    expect(ctx.index).toBeUndefined();
    expect(ctx.fieldName).toBeUndefined();
  });

  it('a nested array-parent row\'s context carries the row\'s own path from the subtree root, as its "Add" must address the array itself and "the root field is the array" is false here', () => {
    const path: PathSegment[] = [{ kind: 'member', name: 'Items' }];
    renderRow({
      diff: arrayDiff(),
      meta: intArrayMeta,
      editableColumns: new Set([columnKey({ name: 'MyMod.esp', origin: 'Data' })]),
      context: { path, rootField: 'Container', depth: path.length },
      isExpanded: false,
    });
    const ctx = vscodeContextFor('[2]', 1);
    expect(ctx.path).toEqual([{ kind: 'member', name: 'Container' }, ...path]);
  });

  it('a top-level array-element row\'s context carries a one-hop index path', () => {
    const path: PathSegment[] = [{ kind: 'index', index: 1 }];
    renderRow({
      diff: diff({ fieldName: '[1]', values: { 'Fallout4.esm': 2, 'MyMod.esp': 2 } }),
      meta: intMetaLeaf,
      editableColumns: new Set([columnKey({ name: 'MyMod.esp', origin: 'Data' })]),
      context: { path, rootField: 'Items', depth: path.length },
    });
    const ctx = vscodeContextFor('2', 1);
    expect(ctx.webviewSection).toBe('cell arrayElement editableCell');
    expect(ctx.path).toEqual([{ kind: 'member', name: 'Items' }, ...path]);
    expect(ctx.index).toBeUndefined();
  });

  it('a nested array-element row\'s context carries every hop of its own path, not only the trailing index', () => {
    const path: PathSegment[] = [{ kind: 'member', name: 'Entries' }, { kind: 'index', index: 0 }];
    renderRow({
      diff: diff({ fieldName: '[0]', values: { 'Fallout4.esm': 5, 'MyMod.esp': 5 } }),
      meta: intMetaLeaf,
      editableColumns: new Set([columnKey({ name: 'MyMod.esp', origin: 'Data' })]),
      context: { path, rootField: 'Container', depth: path.length },
    });
    const ctx = vscodeContextFor('5', 1);
    expect(ctx.path).toEqual([{ kind: 'member', name: 'Container' }, ...path]);
  });
});

describe('DiffRow — label indentation', () => {
  it('indents a row whose path is empty but whose depth is nonzero, `depth` being the ancestor-hop count tracked independently of `path`', () => {
    renderRow({ context: { path: [], rootField: 'Health', depth: 2 } });
    expect(screen.getByText('Name').closest('td')).toHaveStyle({ paddingLeft: '48px' });
  });

  it('does not indent a true top-level row', () => {
    renderRow({ context: { path: [], rootField: 'Name', depth: 0 } });
    expect(screen.getByText('Name').closest('td')).not.toHaveStyle({ paddingLeft: '24px' });
  });

  it.each([[1, '24px'], [2, '48px'], [3, '72px']] as const)('indents a row at depth %i by %s, one further step per level', (depth, padding) => {
    renderRow({ context: { path: [], rootField: 'Name', depth } });
    expect(screen.getByText('Name').closest('td')).toHaveStyle({ paddingLeft: padding });
  });
});

describe('DiffRow — a collapsed container row, per column: `{…}`/`[n]` states that something is present but collapsed, so a column with nothing there (an unset nullable struct, an owner it does not carry) has nothing to collapse', () => {
  const structMeta = fieldMeta({
    name: 'Location', type: 'struct', allowsNull: true,
    fields: [fieldMeta({ name: 'aliasId', type: 'int' })],
  });
  const arrayMeta = fieldMeta({
    name: 'Items', type: 'array', isArray: true,
    elementType: fieldMeta({ name: '', type: 'int' }),
  });

  function renderContainer(values: Record<string, unknown>, meta: FieldMetadata = structMeta) {
    return renderRow({
      diff: diff({ fieldName: meta.name, values, children: CHILDREN_THAT_OFFER_THE_EXPAND_TOGGLE }),
      meta,
      context: { path: [], rootField: meta.name, depth: 0 },
      isExpanded: false,
    });
  }

  function cellText(columnIndex: number): string | null {
    const row = required(screen.getByText('Location').closest('tr'), "the 'Location' cell's tr ancestor");
    return required(row.querySelectorAll('td')[columnIndex + 1], `the 'Location' row's cell ${columnIndex + 1}`).textContent;
  }

  it('shows the placeholder only in the column that has a nullable struct', () => {
    renderContainer({ 'Fallout4.esm': { aliasId: 5 }, 'MyMod.esp': null });
    expect(cellText(0)).toBe('{…}');
    expect(cellText(1)).toBe('');
  });

  it('shows the placeholder in every column for a non-nullable struct one column omits, as it has no unset so the omitting column holds its default', () => {
    renderContainer(
      { 'Fallout4.esm': { aliasId: 5 }, 'MyMod.esp': null },
      fieldMeta({ ...structMeta, allowsNull: false }));
    expect(cellText(0)).toBe('{…}');
    expect(cellText(1)).toBe('{…}');
  });

  it('shows the placeholder in every column when both plugins have the element', () => {
    renderContainer({ 'Fallout4.esm': { aliasId: 5 }, 'MyMod.esp': { aliasId: 7 } });
    expect(cellText(0)).toBe('{…}');
    expect(cellText(1)).toBe('{…}');
  });

  it('shows the element count in every column whose owner is there, an absent array as [0] because the document omits an empty list', () => {
    renderRow({
      diff: diff({ fieldName: 'Items', values: { 'Fallout4.esm': [1, 2, 3], 'MyMod.esp': null }, children: CHILDREN_THAT_OFFER_THE_EXPAND_TOGGLE }),
      meta: arrayMeta,
      context: { path: [], rootField: 'Items', depth: 0 },
      isExpanded: false,
    });
    const itemsRow = required(screen.getByText('Items').closest('tr'), "the 'Items' cell's tr ancestor");
    const cells = itemsRow.querySelectorAll('td');
    expect(required(cells[1], "the 'Items' row's second cell").textContent).toBe('[3]');
    expect(required(cells[2], "the 'Items' row's third cell").textContent).toBe('[0]');
  });

  it('shows nothing for an array whose owner the column does not carry', () => {
    renderRow({
      diff: diff({ fieldName: 'Items', values: { 'Fallout4.esm': [1, 2, 3], 'MyMod.esp': null }, children: CHILDREN_THAT_OFFER_THE_EXPAND_TOGGLE }),
      meta: arrayMeta,
      context: { path: [{ kind: 'member', name: 'Items' }], rootField: 'Owner', depth: 1 },
      isExpanded: false,
      ownerPresent: column => column === columnKey({ name: 'Fallout4.esm', origin: 'Data' }),
    });
    const itemsRow = required(screen.getByText('Items').closest('tr'), "the 'Items' cell's tr ancestor");
    const cells = itemsRow.querySelectorAll('td');
    expect(required(cells[1], "the 'Items' row's second cell").textContent).toBe('[3]');
    expect(required(cells[2], "the 'Items' row's third cell").textContent).toBe('');
  });

  it('keeps the placeholder in every column for a container no plugin carries a value for, there being nothing there for a column to lack', () => {
    renderContainer({});
    expect(cellText(0)).toBe('{…}');
    expect(cellText(1)).toBe('{…}');
  });
});

describe('DiffRow — an enum whose values are wire tokens, Mutagen class names, so the cell speaks its label everywhere, including Ctrl+C, which copies the one string the cell displays', () => {
  const kindMeta = fieldMeta({
    name: 'MutagenObjectType', type: 'enum',
    enumMembers: [{ value: 'QuestReferenceAlias', label: 'Reference' },
      { value: 'QuestLocationAlias', label: 'Location' }],
    displayLabel: 'Kind',
  });
  const kindDiff = diff({
    fieldName: 'MutagenObjectType',
    values: { 'Fallout4.esm': 'QuestReferenceAlias', 'MyMod.esp': 'QuestReferenceAlias' },
  });

  function renderKindRow() {
    return renderRow({
      diff: kindDiff, meta: kindMeta, rowKey: 'MutagenObjectType',
      context: { path: [], rootField: 'MutagenObjectType', depth: 0 },
    });
  }

  it('titles the row from the schema rather than from the wire name', () => {
    renderKindRow();
    expect(screen.getByText('Kind')).toBeInTheDocument();
    expect(screen.queryByText('MutagenObjectType')).not.toBeInTheDocument();
  });

  it('carries the text it copies, what the cell reads and not the class name behind it, for copy value', () => {
    renderKindRow();

    const cell = required(required(screen.getAllByText('Reference')[0], "the 'Reference' match at index 0").closest('td'), 'its td ancestor');

    expect(parseJsonRecord(required(cell.getAttribute('data-vscode-context'), 'its context')).copyText).toBe('Reference');
  });
});

describe('DiffRow — a plain cell\'s right-click menu suppresses VS Code\'s own Cut, Copy and Paste items and offers copy value where the cell has text to copy', () => {
  function cellContext(text: string, index: number): Record<string, unknown> {
    const td = required(screen.getAllByText(text)[index]?.closest('td'), 'the cell');
    return parseJsonRecord(required(td.getAttribute('data-vscode-context'), "the cell's data-vscode-context attribute"));
  }

  it('suppresses the default items and carries the text copy value copies, on a cell nothing else is offered on', () => {
    renderRow({ meta: intMeta, diff: diff({ values: { 'Fallout4.esm': 7, 'MyMod.esp': 7 } }) });
    expect(cellContext('7', 0)).toEqual({ webviewSection: 'cell', copyText: '7', preventDefaultContextMenuItems: true });
  });
});
