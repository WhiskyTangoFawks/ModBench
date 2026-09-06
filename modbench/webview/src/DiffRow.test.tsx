import '@testing-library/jest-dom';
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, afterEach } from 'vitest';

// FormKeyCell's pickFormKey import touches vscode.ts's acquireVsCodeApi() at module load.
const copyToClipboard = vi.fn();
const pickFormKey = vi.fn().mockResolvedValue(null);
vi.mock('./nativeBridge', () => ({
  copyToClipboard: (...args: unknown[]) => copyToClipboard(...args),
  pickFormKey: (...args: unknown[]) => pickFormKey(...args),
}));

import { DiffRow } from './DiffRow';
import type { Column, PathSegment } from './recordUtils';
import type { CompareOverride, FieldDiff, FieldMetadata, FormKeyResolution } from './types';
import { columnKey } from './types';
import { DIMMED_OPACITY } from './gridStyles';
import { diffNode, fieldMeta } from './test/fixtures';

const strMeta = fieldMeta({ name: 'Name', type: 'string' });
const intMeta = fieldMeta({ name: 'Level', type: 'int' });
// A row offers its expand toggle when its own diff node carries children.
const CHILDREN: FieldDiff[] = [diffNode({ fieldName: 'child' })];

function override(plugin: string, partial: Partial<CompareOverride> = {}): CompareOverride {
  return {
    formKey: '000001:Fallout4.esm', plugin, loadOrderIndex: 0, isWinner: false,
    editorId: 'TestNPC', fields: [{ metadata: strMeta, value: 'disk-value' }],
    conflictThis: 'Master', origin: 'Data',
    recordType: 'npc_', isPartialForm: false, isPartialFormable: false,
    ...partial,
  };
}

function diskColumn(o: CompareOverride): Column {
  return { key: columnKey(o.plugin, o.origin), override: o };
}
function diff(partial: Partial<FieldDiff> = {}): FieldDiff {
  return diffNode({
    fieldName: 'Name',
    values: { 'Fallout4.esm': 'disk-value', 'MyMod.esp': 'disk-value' },
    winnerColumn: 'Fallout4.esm',
    ...partial,
  });
}

function baseProps(overrides: Partial<React.ComponentProps<typeof DiffRow>> = {}): React.ComponentProps<typeof DiffRow> {
  const master = override('Fallout4.esm');
  const mod = override('MyMod.esp');
  // Derived from whichever `diff` this call uses, so a test overriding only `diff` still gets a
  // consistent default `context`.
  const effectiveDiff = overrides.diff ?? diff();
  return {
    diff: effectiveDiff,
    meta: strMeta,
    columns: [diskColumn(master), diskColumn(mod)],
    // ADR-0035/ADR-0036: dimming is the panel's one answer; immutability alone is not part of it.
    dimmedColumns: new Set(),
    collapsedColumns: new Set(),
    // Empty by default — editability is opt-in per fixture, never something a test inherits
    // without saying so.
    editableColumns: new Set(),
    onOpen: vi.fn(),
    recordLabel: 'TestNPC [000001:Fallout4.esm]',
    context: { path: [], rootField: effectiveDiff.fieldName, depth: 0 },
    rowKey: 'Name',
    focusedCell: null,
    onFocusCell: vi.fn(),
    ...overrides,
  };
}

function renderRow(props: Partial<React.ComponentProps<typeof DiffRow>> = {}) {
  return render(<table><tbody>{React.createElement(DiffRow, baseProps(props))}</tbody></table>);
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
    renderRow({ diff: diff({ children: CHILDREN }), isExpanded: false, onToggle });
    const btn = screen.getByText('▶');
    fireEvent.click(btn);
    expect(onToggle).toHaveBeenCalled();
  });

  it('shows ▼ when expanded', () => {
    renderRow({ diff: diff({ children: CHILDREN }), isExpanded: true });
    expect(screen.getByText('▼')).toBeInTheDocument();
  });

  // ADR-0041: with no editable columns wired, no cell opens an editor on any gesture.
  it('a value cell opens no editor on click, second click or double click', () => {
    renderRow({ meta: intMeta, diff: diff({ values: { 'Fallout4.esm': 5, 'MyMod.esp': 5 } }) });
    const cell = screen.getAllByText('5')[1]; // MyMod.esp
    fireEvent.click(cell);
    fireEvent.click(cell);
    fireEvent.doubleClick(cell);
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(screen.queryByDisplayValue('5')).not.toBeInTheDocument();
  });

  it('double click on an immutable disk cell opens nothing', () => {
    renderRow({ focusedCell: null, meta: intMeta, diff: diff({ values: { 'Fallout4.esm': 5, 'MyMod.esp': 5 } }) });
    fireEvent.doubleClick(screen.getAllByText('5')[0]); // Fallout4.esm — immutable
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  });

  it('double click on the label column toggles expand/collapse without breaking the existing button', () => {
    const onToggle = vi.fn();
    renderRow({ diff: diff({ children: CHILDREN }), isExpanded: false, onToggle });
    const labelCell = screen.getByText('▶').closest('td')!;
    fireEvent.doubleClick(labelCell);
    expect(onToggle).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByText('▶'));
    expect(onToggle).toHaveBeenCalledTimes(2);
  });

  it('double click on the label column does nothing for a leaf row with no children', () => {
    renderRow();
    const labelCell = screen.getByText('Name').closest('td')!;
    expect(() => fireEvent.doubleClick(labelCell)).not.toThrow();
  });
});

// The panel decides which columns are dimmed and hands down one set; the row applies it to every
// cell of that column and asks nothing else.
describe('DiffRow — dimmed columns', () => {
  it('dims a cell whose column the panel named dimmed', () => {
    renderRow({ dimmedColumns: new Set([columnKey('MyMod.esp', null)]) });
    const cell = screen.getAllByText('disk-value')[1].closest('td')!;
    expect(cell).toHaveStyle({ opacity: String(DIMMED_OPACITY) });
  });

  it('does not dim a column outside that set', () => {
    renderRow();
    const cell = screen.getAllByText('disk-value')[1].closest('td')!;
    expect(cell).not.toHaveStyle({ opacity: String(DIMMED_OPACITY) });
  });
});

describe('DiffRow — drag affordance on leaf cells', () => {

  // ADR-0034: no `grab` on any value cell — the grid rests on the
  // default arrow, and drag is simply unadvertised (as in xEdit) rather than shown by the cursor.
  it('shows no grab cursor at rest on a leaf cell', () => {
    renderRow();
    const cell = screen.getAllByText('disk-value')[0].closest('td')!;
    expect(cell.style.cursor).not.toBe('grab');
  });
});


// ADR-0034: focus identity lives above DiffRow, which reports the clicked row and plugin and
// reflects back the `focusedCell` it was given.
describe('DiffRow — cell focus', () => {
  it('clicking a value cell reports its row and plugin to onFocusCell', () => {
    const onFocusCell = vi.fn();
    renderRow({ onFocusCell });
    fireEvent.click(screen.getAllByText('disk-value')[1]);
    expect(onFocusCell).toHaveBeenCalledWith('Name', 'MyMod.esp');
  });

  it('a disk cell matching focusedCell is tabbable and carries real DOM focus', () => {
    renderRow({ focusedCell: { rowKey: 'Name', plugin: columnKey('MyMod.esp', null) } });
    const cell = screen.getAllByText('disk-value')[1].closest('td')!;
    expect(cell).toHaveAttribute('tabindex', '0');
    expect(cell).toHaveFocus();
  });

  it('a cell not matching focusedCell does not carry DOM focus', () => {
    renderRow({ focusedCell: { rowKey: 'Name', plugin: columnKey('MyMod.esp', null) } });
    const cell = screen.getAllByText('disk-value')[0].closest('td')!; // Fallout4.esm, not the match
    expect(cell).not.toHaveFocus();
  });

  it('the row containing the focused cell is highlighted', () => {
    renderRow({ focusedCell: { rowKey: 'Name', plugin: columnKey('MyMod.esp', null) } });
    const row = screen.getAllByText('disk-value')[1].closest('tr')!;
    expect(row.style.boxShadow).toContain('var(--vscode-focusBorder');
  });

  it('a row with no focused cell in it is not highlighted', () => {
    renderRow({ focusedCell: null });
    const row = screen.getAllByText('disk-value')[0].closest('tr')!;
    expect(row.style.boxShadow).toBe('');
  });

  it('the focused cell itself is visibly distinguished from the rest of its row', () => {
    renderRow({ focusedCell: { rowKey: 'Name', plugin: columnKey('MyMod.esp', null) } });
    const focusedTd = screen.getAllByText('disk-value')[1].closest('td')!;
    const otherTd = screen.getAllByText('disk-value')[0].closest('td')!;
    expect(focusedTd.style.boxShadow).toContain('var(--vscode-focusBorder');
    // Different from the row's own highlight, not merely present — the cell's own ring must
    // stand out from the row ring around it, not be indistinguishable from it.
    const row = focusedTd.closest('tr')!;
    expect(focusedTd.style.boxShadow).not.toBe(row.style.boxShadow);
    expect(otherTd.style.boxShadow).toBe('');
  });

  it('no cell carries DOM focus when focusedCell is null', () => {
    renderRow({ focusedCell: null });
    expect(document.body).toHaveFocus();
  });

  // ADR-0036: two columns sharing a filename but differing in origin must focus independently.
  // A bare-string FocusedCell.plugin would read both as focused.
  it('focusing one of two same-filename, different-origin columns does not focus the other (AC5)', () => {
    const colA = override('Shared.esp', { origin: 'ModA' });
    const colB = override('Shared.esp', { origin: 'ModB' });
    renderRow({
      columns: [diskColumn(colA), diskColumn(colB)],
      diff: diff({ values: { [columnKey('Shared.esp', 'ModA')]: 'disk-value', [columnKey('Shared.esp', 'ModB')]: 'disk-value' } }),
      focusedCell: { rowKey: 'Name', plugin: columnKey('Shared.esp', 'ModA') },
    });
    const cells = screen.getAllByText('disk-value');
    const [cellA, cellB] = [cells[0].closest('td')!, cells[1].closest('td')!];

    expect(cellA).toHaveFocus();
    expect(cellB).not.toHaveFocus();
  });
});

// ADR-0031: the affordance keys off the leaf's own `diff.resolutions` entry, not the parent
// field's aggregate `checkError` — a dangling sibling must not hide a live link beside it.
describe('DiffRow — FormKey leaf resolution is independent of the parent field aggregate', () => {
  const fkMeta = fieldMeta({ name: '', type: 'formKey' });
  const validType: FormKeyResolution = { state: 'ResolvedValidType', recordType: 'kywd', editorId: 'SomeKeyword' };
  const wrongType: FormKeyResolution = { state: 'ResolvedWrongType', recordType: 'npc_', editorId: 'SomeNpc' };
  const unresolved: FormKeyResolution = { state: 'Unresolved', recordType: null, editorId: null };

  // The parent field carries a checkError because a different sibling element is dangling.
  function leafProps(
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

  afterEach(() => { fireEvent.keyUp(window, { key: 'Control' }); });

  it('an array-element resolved-valid-type leaf still shows the affordance despite the parent field checkError', () => {
    renderRow(leafProps('array-element', validType));
    const link = screen.getByText('SomeKeyword [000019:Fallout4.esm]');
    fireEvent.keyDown(window, { key: 'Control', ctrlKey: true });
    fireEvent.mouseEnter(link);
    expect(link.style.textDecoration).toBe('underline');
  });

  it('an array-element resolved-wrong-type leaf still shows the affordance despite the parent field checkError', () => {
    renderRow(leafProps('array-element', wrongType, '00001A:Fallout4.esm'));
    const link = screen.getByText('SomeNpc [00001A:Fallout4.esm]');
    fireEvent.keyDown(window, { key: 'Control', ctrlKey: true });
    fireEvent.mouseEnter(link);
    expect(link.style.textDecoration).toBe('underline');
  });

  it('a struct-child resolved-valid-type leaf still shows the affordance despite the parent field checkError', () => {
    renderRow(leafProps('struct-child', validType));
    const link = screen.getByText('SomeKeyword [000019:Fallout4.esm]');
    fireEvent.keyDown(window, { key: 'Control', ctrlKey: true });
    fireEvent.mouseEnter(link);
    expect(link.style.textDecoration).toBe('underline');
  });

  it('an array-element unresolved leaf shows no affordance (plain FormKey text)', () => {
    renderRow(leafProps('array-element', unresolved, 'FFFFFF:Dangling.esm'));
    const link = screen.getByText('FFFFFF:Dangling.esm');
    fireEvent.keyDown(window, { key: 'Control', ctrlKey: true });
    fireEvent.mouseEnter(link);
    expect(link.style.textDecoration).toBe('none');
  });

  it('a struct-child unresolved leaf shows no affordance (plain FormKey text)', () => {
    renderRow(leafProps('struct-child', unresolved, 'FFFFFF:Dangling.esm'));
    const link = screen.getByText('FFFFFF:Dangling.esm');
    fireEvent.keyDown(window, { key: 'Control', ctrlKey: true });
    fireEvent.mouseEnter(link);
    expect(link.style.textDecoration).toBe('none');
  });

  it('a struct-child resolved-wrong-type leaf still shows the affordance despite the parent field checkError', () => {
    renderRow(leafProps('struct-child', wrongType, '00001A:Fallout4.esm'));
    const link = screen.getByText('SomeNpc [00001A:Fallout4.esm]');
    fireEvent.keyDown(window, { key: 'Control', ctrlKey: true });
    fireEvent.mouseEnter(link);
    expect(link.style.textDecoration).toBe('underline');
  });
});

// Every other fixture here carries one field, where `fields[0]` would be right by accident; the
// decoy ahead of Location is what forbids that reading.
describe('DiffRow — the check error is the row\'s own root field\'s', () => {
  const locationMeta = fieldMeta({ name: 'Location', type: 'struct', fields: [fieldMeta({ name: 'aliasId', type: 'int' })] });

  it('shows the warning from the row\'s own root field, not from the first field in the column', () => {
    const master = override('Fallout4.esm', {
      fields: [
        { metadata: fieldMeta({ name: 'Level', type: 'int' }), value: 4, checkError: 'decoy: a different field is dangling' },
        { metadata: locationMeta, value: {}, checkError: 'Location: its reference is dangling' },
      ],
    });
    renderRow({
      diff: diff({ fieldName: 'Location', values: { 'Fallout4.esm': {} } }),
      meta: locationMeta,
      columns: [diskColumn(master)],
      context: { path: [], rootField: 'Location', depth: 0 },
    });
    expect(screen.getByTitle('Location: its reference is dangling')).toBeInTheDocument();
    expect(screen.queryByTitle('decoy: a different field is dangling')).not.toBeInTheDocument();
  });
});

describe('DiffRow — flags cell wiring', () => {
  const flagMeta = fieldMeta({
    name: 'Flags', type: 'flags',
    enumMembers: [{ value: 'A', bitValue: '1' }, { value: 'B', bitValue: '2' }],
  });

  function flagsRow(overrides: Partial<React.ComponentProps<typeof DiffRow>> = {}) {
    return renderRow({
      meta: flagMeta,
      diff: diff({ values: { 'Fallout4.esm': ['A'], 'MyMod.esp': ['A'] } }),
      ...overrides,
    });
  }

  // A flags row starts collapsed, so the expanded-state cases pass isExpanded explicitly.
  it('an expanded flags cell in a non-editable column renders its checkboxes disabled', () => {
    flagsRow({ isExpanded: true, focusedCell: { rowKey: 'Name', plugin: columnKey('MyMod.esp', null) } });
    const boxes = screen.getAllByRole('checkbox');
    expect(boxes).toHaveLength(4); // both columns, 2 flags each
    for (const box of boxes) expect(box).toBeDisabled();
  });

  it('an expanded flags cell in an editable column renders enabled checkboxes', () => {
    flagsRow({
      isExpanded: true,
      editableColumns: new Set([columnKey('MyMod.esp', null)]),
      onEditCell: vi.fn(),
    });
    const boxes = screen.getAllByRole('checkbox');
    expect(boxes).toHaveLength(4);
    expect(boxes[2]).toBeEnabled();  // MyMod.esp's A
    expect(boxes[0]).toBeDisabled(); // Fallout4.esm's A — immutable column stays inert
  });

  // Flags rows get the collapse toggle despite having no child rows — the "children" are the
  // checkbox lines inside the cell.
  it('a flags row starts collapsed: chevron closed, compact summary, no checkboxes', () => {
    const onToggle = vi.fn();
    flagsRow({ onToggle });
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    expect(screen.getAllByText('A')).toHaveLength(2); // value 1 → summary "A" in both columns
    const btn = screen.getByRole('button', { name: '▶' });
    fireEvent.click(btn);
    expect(onToggle).toHaveBeenCalled();
  });

  // Where the value goes is the row builder's to decide, not something a row states with it.
  it('toggling a checkbox calls onEditCell with the column and the names now set', () => {
    const onEditCell = vi.fn();
    flagsRow({
      isExpanded: true,
      editableColumns: new Set([columnKey('MyMod.esp', null)]),
      onEditCell,
    });
    fireEvent.click(screen.getAllByRole('checkbox')[3]); // MyMod.esp's B
    expect(onEditCell).toHaveBeenCalledWith(columnKey('MyMod.esp', null), ['A', 'B']);
  });
});

describe('DiffRow — formKey cell wiring', () => {
  const fkMeta = fieldMeta({ name: 'Race', type: 'formKey', validFormKeyTypes: ['race'] });

  function fkRow(overrides: Partial<React.ComponentProps<typeof DiffRow>> = {}) {
    return renderRow({
      meta: fkMeta,
      diff: diff({ values: { 'Fallout4.esm': '000019:Fallout4.esm', 'MyMod.esp': '000019:Fallout4.esm' } }),
      ...overrides,
    });
  }

  afterEach(() => { pickFormKey.mockClear(); });

  it('a formKey cell in a non-editable column does not open the picker when clicked', () => {
    fkRow({ focusedCell: { rowKey: 'Name', plugin: columnKey('MyMod.esp', null) } });
    fireEvent.click(screen.getAllByText('000019:Fallout4.esm')[1]);
    expect(pickFormKey).not.toHaveBeenCalled();
  });

  it('a formKey cell in an editable, focused column opens the picker with the field’s valid types', () => {
    fkRow({
      editableColumns: new Set([columnKey('MyMod.esp', null)]),
      onEditCell: vi.fn(),
      focusedCell: { rowKey: 'Name', plugin: columnKey('MyMod.esp', null) },
    });
    fireEvent.click(screen.getAllByText('000019:Fallout4.esm')[1]);
    expect(pickFormKey).toHaveBeenCalledWith('000019:Fallout4.esm', ['race']);
  });

  it('committing a picked FormKey calls onEditCell with the column and the picked value', async () => {
    const onEditCell = vi.fn();
    pickFormKey.mockResolvedValueOnce('00001A:Fallout4.esm');
    fkRow({
      editableColumns: new Set([columnKey('MyMod.esp', null)]),
      onEditCell,
      focusedCell: { rowKey: 'Name', plugin: columnKey('MyMod.esp', null) },
    });
    fireEvent.click(screen.getAllByText('000019:Fallout4.esm')[1]);
    await vi.waitFor(() => expect(onEditCell)
      .toHaveBeenCalledWith(columnKey('MyMod.esp', null), '00001A:Fallout4.esm'));
  });
});

// ADR-0039: the extended editor's only trigger is the string cell's right-click menu, driven by
// the `data-vscode-context` attribute DiskCell carries; no left-click gesture reaches it.
describe('DiffRow — string cell right-click menu (ADR-0039)', () => {
  function stringContext(text: string, index = 0): Record<string, unknown> {
    const td = screen.getAllByText(text)[index].closest('td');
    const attr = td?.getAttribute('data-vscode-context');
    expect(attr).toBeTruthy();
    return JSON.parse(attr!) as Record<string, unknown>;
  }

  it('a mutable string cell carries a stringValue context with readOnly: false and its current value', () => {
    renderRow({
      editableColumns: new Set([columnKey('MyMod.esp', null)]),
      onEditCell: vi.fn(),
    });
    expect(stringContext('disk-value', 1)).toEqual({
      webviewSection: 'stringValue',
      formKey: '000001:Fallout4.esm',
      plugin: 'MyMod.esp',
      origin: 'Data',
      recordLabel: 'TestNPC [000001:Fallout4.esm]',
      fieldName: 'Name',
      value: 'disk-value',
      readOnly: false,
      // A top-level row's wire path is the record's own member, and nothing else.
      path: [{ kind: 'member', name: 'Name' }],
      preventDefaultContextMenuItems: true,
    });
  });

  it('an immutable string cell (no onEditCell wired at all) still carries the context, with readOnly: true', () => {
    renderRow();
    const ctx = stringContext('disk-value', 0);
    expect(ctx.webviewSection).toBe('stringValue');
    expect(ctx.readOnly).toBe(true);
  });

  // Without every hop, a nested leaf's context reads identically to a top-level field's, and its
  // save would land on the root.
  it('a nested string cell carries its whole wire path, and is titled by its own label', () => {
    const path: PathSegment[] = [{ kind: 'member', name: 'Sub' }];
    renderRow({
      editableColumns: new Set([columnKey('MyMod.esp', null)]),
      onEditCell: vi.fn(),
      context: { path, rootField: 'Struct', depth: path.length },
    });
    const ctx = stringContext('disk-value', 1);
    expect(ctx.path).toEqual([{ kind: 'member', name: 'Struct' }, { kind: 'member', name: 'Sub' }]);
    // The tab is named for the leaf the menu was opened on, not for the member it sits under.
    expect(ctx.fieldName).toBe('Name');
  });

  it('double click opens the inline editor in place, never a tab, calling no callback', () => {
    renderRow({ editableColumns: new Set([columnKey('MyMod.esp', null)]), onEditCell: vi.fn() });
    fireEvent.doubleClick(screen.getAllByText('disk-value')[1]);
    expect(screen.getByDisplayValue('disk-value')).toBeInTheDocument();
  });
});

// A nested array's element is more than one hop from its subtree root, which the subtree root
// plus a bare scalar index could never express.
describe('DiffRow — array parent/element right-click context', () => {
  function vscodeContextFor(text: string, index = 0): Record<string, unknown> {
    const td = screen.getAllByText(text)[index].closest('td');
    const attr = td?.getAttribute('data-vscode-context');
    expect(attr).toBeTruthy();
    return JSON.parse(attr!) as Record<string, unknown>;
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
      children: CHILDREN,
      ...partial,
    });
  }

  it('a top-level array-parent row\'s context carries the one member hop of its own field', () => {
    renderRow({
      diff: arrayDiff(),
      meta: intArrayMeta,
      editableColumns: new Set([columnKey('MyMod.esp', null)]),
      onArrayOp: vi.fn(),
      context: { path: [], rootField: 'Items', depth: 0 },
      isExpanded: false,
    });
    const ctx = vscodeContextFor('[2]', 1);
    expect(ctx.webviewSection).toBe('arrayParent');
    expect(ctx.path).toEqual([{ kind: 'member', name: 'Items' }]);
    expect(ctx.index).toBeUndefined();
    expect(ctx.fieldName).toBeUndefined();
  });

  // A nested array's "Add" must address the array itself: "the root field is the array" is
  // false here.
  it('a nested array-parent row\'s context carries the row\'s own path from the subtree root', () => {
    const path: PathSegment[] = [{ kind: 'member', name: 'Items' }];
    renderRow({
      diff: arrayDiff(),
      meta: intArrayMeta,
      editableColumns: new Set([columnKey('MyMod.esp', null)]),
      onArrayOp: vi.fn(),
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
      editableColumns: new Set([columnKey('MyMod.esp', null)]),
      onArrayOp: vi.fn(),
      context: { path, rootField: 'Items', depth: path.length },
    });
    const ctx = vscodeContextFor('2', 1);
    expect(ctx.webviewSection).toBe('arrayElement');
    expect(ctx.path).toEqual([{ kind: 'member', name: 'Items' }, ...path]);
    expect(ctx.index).toBeUndefined();
  });

  // A payload carrying only the trailing index truncates every hop before it.
  it('a nested array-element row\'s context carries every hop of its own path', () => {
    const path: PathSegment[] = [{ kind: 'member', name: 'Entries' }, { kind: 'index', index: 0 }];
    renderRow({
      diff: diff({ fieldName: '[0]', values: { 'Fallout4.esm': 5, 'MyMod.esp': 5 } }),
      meta: intMetaLeaf,
      editableColumns: new Set([columnKey('MyMod.esp', null)]),
      onArrayOp: vi.fn(),
      context: { path, rootField: 'Container', depth: path.length },
    });
    const ctx = vscodeContextFor('5', 1);
    expect(ctx.path).toEqual([{ kind: 'member', name: 'Container' }, ...path]);
  });
});

describe('DiffRow — label indentation', () => {
  // `depth` is the ancestor-hop count, tracked independently of `path`: a row whose `path` is
  // empty is not necessarily top-level, so only `depth` tells the two apart.
  it('indents a row whose path is empty but whose depth is nonzero', () => {
    renderRow({ context: { path: [], rootField: 'Health', depth: 2 } });
    expect(screen.getByText('Name').closest('td')).toHaveStyle({ paddingLeft: '48px' });
  });

  it('does not indent a true top-level row', () => {
    renderRow({ context: { path: [], rootField: 'Name', depth: 0 } });
    expect(screen.getByText('Name').closest('td')).not.toHaveStyle({ paddingLeft: '24px' });
  });

  it('indents each level by one further step', () => {
    for (const [depth, padding] of [[1, '24px'], [2, '48px'], [3, '72px']] as const) {
      const { unmount } = renderRow({ context: { path: [], rootField: 'Name', depth } });
      expect(screen.getByText('Name').closest('td')).toHaveStyle({ paddingLeft: padding });
      unmount();
    }
  });
});

// `{…}`/`[n]` states that something is present but collapsed. A column whose plugin has no
// element there has nothing to collapse, so its cell stays empty.
describe('DiffRow — a collapsed container row, per column', () => {
  const structMeta = fieldMeta({
    name: 'Location', type: 'struct',
    fields: [fieldMeta({ name: 'aliasId', type: 'int' })],
  });
  const arrayMeta = fieldMeta({
    name: 'Items', type: 'array', isArray: true,
    elementType: fieldMeta({ name: '', type: 'int' }),
  });

  function renderContainer(values: Record<string, unknown>, meta: FieldMetadata = structMeta) {
    return renderRow({
      diff: diff({ fieldName: meta.name, values, children: CHILDREN }),
      meta,
      context: { path: [], rootField: meta.name, depth: 0 },
      isExpanded: false,
    });
  }

  function cellText(columnIndex: number): string {
    return screen.getByText('Location').closest('tr')!.querySelectorAll('td')[columnIndex + 1].textContent;
  }

  it('shows the placeholder only in the column that has the element', () => {
    renderContainer({ 'Fallout4.esm': { aliasId: 5 }, 'MyMod.esp': null });
    expect(cellText(0)).toBe('{…}');
    expect(cellText(1)).toBe('');
  });

  it('shows the placeholder in every column when both plugins have the element', () => {
    renderContainer({ 'Fallout4.esm': { aliasId: 5 }, 'MyMod.esp': { aliasId: 7 } });
    expect(cellText(0)).toBe('{…}');
    expect(cellText(1)).toBe('{…}');
  });

  // The document omits an empty list, so a column with no array there has an empty one.
  it('shows the element count in every column whose owner is there, an absent array as [0]', () => {
    renderRow({
      diff: diff({ fieldName: 'Items', values: { 'Fallout4.esm': [1, 2, 3], 'MyMod.esp': null }, children: CHILDREN }),
      meta: arrayMeta,
      context: { path: [], rootField: 'Items', depth: 0 },
      isExpanded: false,
    });
    const cells = screen.getByText('Items').closest('tr')!.querySelectorAll('td');
    expect(cells[1].textContent).toBe('[3]');
    expect(cells[2].textContent).toBe('[0]');
  });

  it('shows nothing for an array whose owner the column does not carry', () => {
    renderRow({
      diff: diff({ fieldName: 'Items', values: { 'Fallout4.esm': [1, 2, 3], 'MyMod.esp': null }, children: CHILDREN }),
      meta: arrayMeta,
      context: { path: [{ kind: 'member', name: 'Items' }], rootField: 'Owner', depth: 1 },
      isExpanded: false,
      ownerPresent: column => column === columnKey('Fallout4.esm', null),
    });
    const cells = screen.getByText('Items').closest('tr')!.querySelectorAll('td');
    expect(cells[1].textContent).toBe('[3]');
    expect(cells[2].textContent).toBe('');
  });

  // A structural container no plugin carries a value for is present in every column. There is
  // nothing there for a column to lack, so every column keeps its placeholder.
  it('keeps the placeholder in every column for a container no plugin carries a value for', () => {
    renderContainer({});
    expect(cellText(0)).toBe('{…}');
    expect(cellText(1)).toBe('{…}');
  });
});

// A labelled enum's values are Mutagen class names, so the cell speaks its label everywhere —
// including Ctrl+C, which ADR-0034 binds to the one string the cell displays.
describe('DiffRow — an enum whose values are wire tokens', () => {
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

  it('copies what the cell reads, not the class name behind it', () => {
    renderKindRow();
    copyToClipboard.mockClear();

    fireEvent.keyDown(screen.getAllByText('Reference')[0].closest('td')!, { key: 'c', ctrlKey: true });

    expect(copyToClipboard).toHaveBeenCalledWith('Reference');
  });
});
