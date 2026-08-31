import '@testing-library/jest-dom';
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, afterEach } from 'vitest';

// FormKeyCell (rendered for formKey-typed fields) imports the pickFormKey
// bridge, which touches vscode.ts's acquireVsCodeApi() at module load — stubbed here since
// these tests don't exercise the picker itself (see FormKeyCell.test.tsx for that).
// copyToClipboard is DiffRow's own import (Ctrl+C's clipboard write) — mocked
// here too so tests can assert on it directly.
const copyToClipboard = vi.fn();
const pickFormKey = vi.fn().mockResolvedValue(null);
vi.mock('./nativeBridge', () => ({
  copyToClipboard: (...args: unknown[]) => copyToClipboard(...args),
  // FormKeyCell's own picker bridge — stubbed here so the wiring test below can assert
  // DiffRow reaches it with the right editable/onCommit contract without a real extension host
  // (FormKeyCell.test.tsx/nativeBridge.test.ts own the picker's own behavior).
  pickFormKey: (...args: unknown[]) => pickFormKey(...args),
}));

import { DiffRow } from './DiffRow';
import type { Column, PathSegment } from './recordUtils';
import type { CompareOverride, FieldDiff, FieldMetadata, FormKeyResolution } from './types';
import { columnKey } from './types';
import { DIMMED_OPACITY } from './gridStyles';

const strMeta: FieldMetadata = { name: 'Name', type: 'string', isArray: false, validFormKeyTypes: [], enumValues: [] };
const intMeta: FieldMetadata = { name: 'Level', type: 'int', isArray: false, validFormKeyTypes: [], enumValues: [] };

function override(plugin: string, partial: Partial<CompareOverride> = {}): CompareOverride {
  return {
    formKey: '000001:Fallout4.esm', plugin, loadOrderIndex: 0, isWinner: false,
    editorId: 'TestNPC', fields: [{ metadata: strMeta, value: 'disk-value' }],
    conflictThis: 'Master', origin: 'Data',
    ...partial,
  };
}

function diskColumn(o: CompareOverride): Column {
  return { kind: 'disk', key: columnKey(o.plugin, o.origin), override: o };
}
function diff(partial: Partial<FieldDiff> = {}): FieldDiff {
  return {
    fieldName: 'Name',
    values: { 'Fallout4.esm': 'disk-value', 'MyMod.esp': 'disk-value' },
    winnerColumn: 'Fallout4.esm', winnerValue: 'disk-value',
    cellStates: {},
    ...partial,
  };
}

function baseProps(overrides: Partial<React.ComponentProps<typeof DiffRow>> = {}): React.ComponentProps<typeof DiffRow> {
  const master = override('Fallout4.esm');
  const mod = override('MyMod.esp');
  // A top-level row's own rootField is always its diff's own fieldName by
  // construction (RecordPanel sets it that way) — derived from whichever `diff` this call ends up
  // using (an override or the default) so a test overriding only `diff` still gets a consistent
  // default `context` without also having to override it.
  const effectiveDiff = overrides.diff ?? diff();
  return {
    diff: effectiveDiff,
    columns: [diskColumn(master), diskColumn(mod)],
    overrideMap: { [columnKey('Fallout4.esm', null)]: master, [columnKey('MyMod.esp', null)]: mod },
    fieldMetaMap: { Name: strMeta },
    // ADR-0035: defaults empty — Fallout4.esm is immutable per this fixture (a stand-in
    // for a vanilla master) but must not dim on that basis alone; only a column genuinely absent
    // from the load order does (see the dedicated describe block below).
    notInLoadOrderSet: new Set(),
    collapsedColumns: new Set(),
    // Empty by default — editability is opt-in per fixture, never something a test inherits
    // without saying so.
    editableColumns: new Set(),
    onOpen: vi.fn(),
    context: { path: [], rootField: effectiveDiff.fieldName },
    // rowKey matches diff().fieldName below — the same identity RecordPanel derives
    // for its own `key=` at each nesting level (top-level/array-element/struct-child/grandchild).
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
    renderRow({ hasChildren: true, isExpanded: false, onToggle });
    const btn = screen.getByText('▶');
    fireEvent.click(btn);
    expect(onToggle).toHaveBeenCalled();
  });

  it('shows ▼ when expanded', () => {
    renderRow({ hasChildren: true, isExpanded: true });
    expect(screen.getByText('▼')).toBeInTheDocument();
  });

  // ADR-0041: with no editable columns wired, no cell opens an editor on any gesture.
  it('a value cell opens no editor on click, second click or double click', () => {
    renderRow({ fieldMetaMap: { Name: intMeta }, diff: diff({ values: { 'Fallout4.esm': 5, 'MyMod.esp': 5 } }) });
    const cell = screen.getAllByText('5')[1]; // MyMod.esp
    fireEvent.click(cell);
    fireEvent.click(cell);
    fireEvent.doubleClick(cell);
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(screen.queryByDisplayValue('5')).not.toBeInTheDocument();
  });

  // There is no `onDoubleClick` on the immutable branch — an immutable cell opens nothing.
  it('double click on an immutable disk cell opens nothing', () => {
    renderRow({ focusedCell: null, fieldMetaMap: { Name: intMeta }, diff: diff({ values: { 'Fallout4.esm': 5, 'MyMod.esp': 5 } }) });
    fireEvent.doubleClick(screen.getAllByText('5')[0]); // Fallout4.esm — immutable
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  });

  it('double click on the label column toggles expand/collapse without breaking the existing button', () => {
    const onToggle = vi.fn();
    renderRow({ hasChildren: true, isExpanded: false, onToggle });
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

// A Partial Form column dims the same way notInLoadOrderSet already does — read straight off
// the column's own override.isPartialForm (already riding on the Column the row is handed), not a
// separately-threaded Set, since the fact already lives on data DiffRow already has.
describe('DiffRow — Partial Form column dimming (#491)', () => {
  it('dims a cell whose column override is a Partial Form record', () => {
    const master = override('Fallout4.esm');
    const partial = override('MyMod.esp', { isPartialForm: true });
    renderRow({
      columns: [diskColumn(master), diskColumn(partial)],
      overrideMap: { [columnKey('Fallout4.esm', null)]: master, [columnKey('MyMod.esp', null)]: partial },
    });
    const cell = screen.getAllByText('disk-value')[1].closest('td')!;
    expect(cell).toHaveStyle({ opacity: String(DIMMED_OPACITY) });
  });

  it('does not dim an ordinary (non-Partial-Form) column', () => {
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


// ADR-0034: click focuses a cell — the row highlights, one cell carries real DOM
// focus. Focus identity lives above DiffRow (RecordPanel); DiffRow just reports which row/plugin
// was clicked and reflects back whether its own cells match the `focusedCell` it was given.
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

  // ADR-0036: the genuinely red case — two columns sharing a filename ('Shared.esp') but
  // differing in origin must focus independently. With a bare-string FocusedCell.plugin
  // (both columns' own `.plugin` field is literally "Shared.esp" — display never changes),
  // isCellFocused's `focusedCell.plugin === plugin` comparison couldn't tell them apart: focusing
  // ModA's cell would also read ModB's cell (same row) as focused.
  it('focusing one of two same-filename, different-origin columns does not focus the other (AC5)', () => {
    const colA = override('Shared.esp', { origin: 'ModA' });
    const colB = override('Shared.esp', { origin: 'ModB' });
    renderRow({
      columns: [diskColumn(colA), diskColumn(colB)],
      overrideMap: { [columnKey('Shared.esp', 'ModA')]: colA, [columnKey('Shared.esp', 'ModB')]: colB },
      diff: diff({ values: { [columnKey('Shared.esp', 'ModA')]: 'disk-value', [columnKey('Shared.esp', 'ModB')]: 'disk-value' } }),
      focusedCell: { rowKey: 'Name', plugin: columnKey('Shared.esp', 'ModA') },
    });
    const cells = screen.getAllByText('disk-value');
    const [cellA, cellB] = [cells[0].closest('td')!, cells[1].closest('td')!];

    expect(cellA).toHaveFocus();
    expect(cellB).not.toHaveFocus();
  });
});

describe('DiffRow — non-top-level contexts', () => {

  it('returns null when the row context has no resolvable field metadata', () => {
    const { container } = render(<table><tbody>{React.createElement(DiffRow, baseProps({
      fieldMetaMap: {}, // 'Name' not present -> top-level meta lookup misses
    }))}</tbody></table>);
    expect(container.querySelector('tr')).not.toBeInTheDocument();
  });
});

// ADR-0031 regression coverage: the affordance must key off the leaf's own
// `diff.resolutions` entry, not the parent field's aggregate `checkError` (looked up via
// `overrideMap`) — a dangling sibling in the same struct/array must not hide
// a live link on the leaf next to it.
describe('DiffRow — FormKey leaf resolution is independent of the parent field aggregate', () => {
  const fkMeta: FieldMetadata = { name: '', type: 'formKey', isArray: false, validFormKeyTypes: [], enumValues: [] };
  const validType: FormKeyResolution = { state: 'ResolvedValidType', recordType: 'kywd', editorId: 'SomeKeyword' };
  const wrongType: FormKeyResolution = { state: 'ResolvedWrongType', recordType: 'npc_', editorId: 'SomeNpc' };
  const unresolved: FormKeyResolution = { state: 'Unresolved', recordType: null, editorId: null };

  // The parent field carries a checkError (e.g. because a
  // *different* sibling element/member is dangling) — reading it via overrideMap
  // regardless of which leaf row is rendering is the aggregate bug this pins.
  function leafProps(
    kind: 'array-element' | 'struct-child',
    resolution: FormKeyResolution,
    value = '000019:Fallout4.esm',
  ) {
    const parentFieldName = kind === 'array-element' ? 'Keywords' : 'LinkedRef';
    const parentType = kind === 'array-element' ? 'array' : 'struct';
    const master = override('Fallout4.esm', {
      fields: [{ metadata: { name: parentFieldName, type: parentType, isArray: kind === 'array-element', validFormKeyTypes: [], enumValues: [] }, value: kind === 'array-element' ? [] : {}, checkError: 'aggregate: one sibling is dangling' }],
    });
    const path: PathSegment[] = kind === 'array-element'
      ? [{ kind: 'index', index: 1 }]
      : [{ kind: 'member', name: 'Reference' }];
    return baseProps({
      diff: diff({ fieldName: kind === 'array-element' ? '[1]' : 'Reference', values: { 'Fallout4.esm': value }, resolutions: { 'Fallout4.esm': resolution } }),
      columns: [diskColumn(master)],
      overrideMap: { [columnKey('Fallout4.esm', null)]: master },
      fieldMetaMap: { [parentFieldName]: fkMeta },
      context: { path, overrideMeta: fkMeta, rootField: parentFieldName },
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

// The flags branch gets the same editable/onCommit wiring the scalar branch already has —
// presence in editableColumns plus a supplied onEditCell is what makes a bitmask cell writable.
describe('DiffRow — flags cell wiring (#426)', () => {
  const flagMeta: FieldMetadata = {
    name: 'Flags', type: 'enum', isArray: false, validFormKeyTypes: [],
    enumValues: ['A', 'B'], enumBitValues: ['1', '2'], isBitmask: true,
  };

  function flagsRow(overrides: Partial<React.ComponentProps<typeof DiffRow>> = {}) {
    return renderRow({
      fieldMetaMap: { Name: flagMeta },
      diff: diff({ values: { 'Fallout4.esm': 1, 'MyMod.esp': 1 } }),
      ...overrides,
    });
  }

  it('a flags cell in a non-editable column renders text, not checkboxes, even when clicked', () => {
    flagsRow({ focusedCell: { rowKey: 'Name', plugin: columnKey('MyMod.esp', null) } });
    fireEvent.click(screen.getAllByText('A')[1]);
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
  });

  it('a flags cell in an editable, focused column opens its checkbox multi-select on click', () => {
    const onEditCell = vi.fn();
    flagsRow({
      editableColumns: new Set([columnKey('MyMod.esp', null)]),
      onEditCell,
      focusedCell: { rowKey: 'Name', plugin: columnKey('MyMod.esp', null) },
    });
    fireEvent.click(screen.getAllByText('A')[1]);
    expect(screen.getAllByRole('checkbox')).toHaveLength(2);
  });

  // The column and the value, and no field path — where the value goes is the row builder's
  // to decide (RecordPanel binds this per row), not something a row states alongside its value.
  it('toggling a checkbox calls onEditCell with the column and the new bitmask', () => {
    const onEditCell = vi.fn();
    flagsRow({
      editableColumns: new Set([columnKey('MyMod.esp', null)]),
      onEditCell,
      focusedCell: { rowKey: 'Name', plugin: columnKey('MyMod.esp', null) },
    });
    fireEvent.click(screen.getAllByText('A')[1]);
    fireEvent.click(screen.getAllByRole('checkbox')[1]); // check B (bit 2): 1 ^ 2 = 3
    expect(onEditCell).toHaveBeenCalledWith(columnKey('MyMod.esp', null), '3');
  });
});

// The formKey branch gets the same editable/onCommit wiring, plus its own picker bridge.
describe('DiffRow — formKey cell wiring (#426)', () => {
  const fkMeta: FieldMetadata = { name: 'Race', type: 'formKey', isArray: false, validFormKeyTypes: ['race'], enumValues: [] };

  function fkRow(overrides: Partial<React.ComponentProps<typeof DiffRow>> = {}) {
    return renderRow({
      fieldMetaMap: { Name: fkMeta },
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

// ADR-0039: no left-click gesture reaches the extended editor — its only trigger
// is the string cell's own right-click menu, a native `webview/context` contribution driven by
// the `data-vscode-context` attribute DiskCell carries (recordUtils.ts's stringValueContext).
// Rival this guards against: a double click calling onOpenExtendedEditor
// directly, with an immutable cell (no onEditCell wired) getting no vscodeContext at all —
// right-click on an immutable string cell would then offer nothing.
describe('DiffRow — string cell right-click menu (#258 / ADR-0039)', () => {
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
      fieldName: 'Name',
      value: 'disk-value',
      readOnly: false,
      // A top-level row's own path is always empty, and its rootField is always its diff's
      // own fieldName (baseProps' own default context, above) — see the nested-path test below for
      // a row inside a struct/array.
      path: [],
      rootField: 'Name',
      preventDefaultContextMenuItems: true,
    });
  });

  it('an immutable string cell (no onEditCell wired at all) still carries the context, with readOnly: true', () => {
    renderRow();
    const ctx = stringContext('disk-value', 0);
    expect(ctx.webviewSection).toBe('stringValue');
    expect(ctx.readOnly).toBe(true);
  });

  // A string leaf nested inside a struct/array must carry its own path within the field
  // (not just the subtree root's) — without this, the right-click context looks identical to a
  // top-level field's and RecordPanel's commit has nothing to reconstruct with.
  it('a nested string cell carries the row\'s own path and the subtree root\'s wire path, not just the root', () => {
    const path: PathSegment[] = [{ kind: 'member', name: 'Sub' }];
    renderRow({
      editableColumns: new Set([columnKey('MyMod.esp', null)]),
      onEditCell: vi.fn(),
      context: { path, rootField: 'Struct' },
    });
    const ctx = stringContext('disk-value', 1);
    expect(ctx.path).toEqual(path);
    expect(ctx.rootField).toBe('Struct');
    // fieldName keeps its own existing role (the extended-editor tab's own display path) — same
    // value as rootField at this call site.
    expect(ctx.fieldName).toBe('Struct');
  });

  it('double click opens the inline editor, never a tab — DiffRow no longer has any callback to call', () => {
    renderRow({ editableColumns: new Set([columnKey('MyMod.esp', null)]), onEditCell: vi.fn() });
    fireEvent.doubleClick(screen.getAllByText('disk-value')[1]);
    expect(screen.getByDisplayValue('disk-value')).toBeInTheDocument();
  });
});

// The array context-menu payload must carry the row's own full path/rootField, not just the
// subtree root plus a bare scalar index — a nested array's element is more than one hop from its
// subtree root, which a scalar-index shape could never express. Mirrors the string-cell
// block above (a top-level case, then a nested case pinning the full-path behavior).
describe('DiffRow — array parent/element right-click context (#535)', () => {
  function vscodeContextFor(text: string, index = 0): Record<string, unknown> {
    const td = screen.getAllByText(text)[index].closest('td');
    const attr = td?.getAttribute('data-vscode-context');
    expect(attr).toBeTruthy();
    return JSON.parse(attr!) as Record<string, unknown>;
  }

  const intArrayMeta: FieldMetadata = {
    name: 'Items', type: 'array', isArray: true, validFormKeyTypes: [], enumValues: [],
    elementType: { name: '', type: 'int', isArray: false, validFormKeyTypes: [], enumValues: [] },
  };
  const intMetaLeaf: FieldMetadata = { name: '', type: 'int', isArray: false, validFormKeyTypes: [], enumValues: [] };

  function arrayDiff(partial: Partial<FieldDiff> = {}): FieldDiff {
    return {
      fieldName: 'Items',
      values: { 'Fallout4.esm': [1, 2], 'MyMod.esp': [1, 2] },
      winnerColumn: 'Fallout4.esm', winnerValue: [1, 2],
      cellStates: {},
      ...partial,
    };
  }

  it('a top-level array-parent row\'s context carries an empty path and its own field as rootField', () => {
    renderRow({
      diff: arrayDiff(),
      fieldMetaMap: { Items: intArrayMeta },
      editableColumns: new Set([columnKey('MyMod.esp', null)]),
      onEditCell: vi.fn(),
      context: { path: [], rootField: 'Items' },
      hasChildren: true, isExpanded: false,
    });
    const ctx = vscodeContextFor('[2]', 1);
    expect(ctx.webviewSection).toBe('arrayParent');
    expect(ctx.path).toEqual([]);
    expect(ctx.rootField).toBe('Items');
    expect(ctx.index).toBeUndefined();
    expect(ctx.fieldName).toBeUndefined();
  });

  // A nested array's own "Add" context must address the array itself (the
  // row's own path from the subtree root), not just carry the subtree root's field name —
  // "the root field is the array" is false here.
  it('a nested array-parent row\'s context carries the row\'s own path from the subtree root', () => {
    const path: PathSegment[] = [{ kind: 'member', name: 'Items' }];
    renderRow({
      diff: arrayDiff(),
      editableColumns: new Set([columnKey('MyMod.esp', null)]),
      onEditCell: vi.fn(),
      context: { path, rootField: 'Container', overrideMeta: intArrayMeta },
      hasChildren: true, isExpanded: false,
    });
    const ctx = vscodeContextFor('[2]', 1);
    expect(ctx.path).toEqual(path);
    expect(ctx.rootField).toBe('Container');
  });

  it('a top-level array-element row\'s context carries a one-hop index path', () => {
    const path: PathSegment[] = [{ kind: 'index', index: 1 }];
    renderRow({
      diff: diff({ fieldName: '[1]', values: { 'Fallout4.esm': 2, 'MyMod.esp': 2 } }),
      editableColumns: new Set([columnKey('MyMod.esp', null)]),
      onEditCell: vi.fn(),
      context: { path, rootField: 'Items', overrideMeta: intMetaLeaf },
    });
    const ctx = vscodeContextFor('2', 1);
    expect(ctx.webviewSection).toBe('arrayElement');
    expect(ctx.path).toEqual(path);
    expect(ctx.rootField).toBe('Items');
    expect(ctx.index).toBeUndefined();
  });

  // A nested array's own element ops must address the element's real
  // (multi-hop) path — a payload carrying only the trailing index truncates every
  // hop before it.
  it('a nested array-element row\'s context carries every hop of its own path', () => {
    const path: PathSegment[] = [{ kind: 'member', name: 'Entries' }, { kind: 'index', index: 0 }];
    renderRow({
      diff: diff({ fieldName: '[0]', values: { 'Fallout4.esm': 5, 'MyMod.esp': 5 } }),
      editableColumns: new Set([columnKey('MyMod.esp', null)]),
      onEditCell: vi.fn(),
      context: { path, rootField: 'Container', overrideMeta: intMetaLeaf },
    });
    const ctx = vscodeContextFor('5', 1);
    expect(ctx.path).toEqual(path);
    expect(ctx.rootField).toBe('Container');
  });
});
