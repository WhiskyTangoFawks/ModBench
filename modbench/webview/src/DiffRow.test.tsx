import '@testing-library/jest-dom';
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, afterEach } from 'vitest';

// Issue #210: FormKeyCell (rendered for formKey-typed fields) now imports the pickFormKey
// bridge, which touches vscode.ts's acquireVsCodeApi() at module load — stubbed here since
// these tests don't exercise the picker itself (see FormKeyCell.test.tsx for that).
vi.mock('./formKeyPickerBridge', () => ({ pickFormKey: vi.fn().mockResolvedValue(null) }));

import { DiffRow } from './DiffRow';
import type { Column } from './recordUtils';
import { pendingCellContext } from './recordUtils';
import type { CompareOverride, FieldDiff, FieldMetadata, FormKeyResolution, PendingChange } from './types';

const strMeta: FieldMetadata = { name: 'Name', type: 'string', isArray: false, validFormKeyTypes: [], enumValues: [] };

function override(plugin: string, partial: Partial<CompareOverride> = {}): CompareOverride {
  return {
    formKey: '000001:Fallout4.esm', plugin, loadOrderIndex: 0, isWinner: false,
    editorId: 'TestNPC', fields: [{ metadata: strMeta, value: 'disk-value' }],
    conflictThis: 'Master',
    ...partial,
  };
}

function diskColumn(o: CompareOverride): Column {
  return { kind: 'disk', override: o };
}
function pendingColumn(plugin: string): Column {
  return { kind: 'pending', plugin };
}

function diff(partial: Partial<FieldDiff> = {}): FieldDiff {
  return {
    fieldName: 'Name',
    values: { 'Fallout4.esm': 'disk-value', 'MyMod.esp': 'disk-value' },
    winnerPlugin: 'Fallout4.esm', winnerValue: 'disk-value',
    cellStates: {},
    ...partial,
  };
}

function baseProps(overrides: Partial<React.ComponentProps<typeof DiffRow>> = {}): React.ComponentProps<typeof DiffRow> {
  const master = override('Fallout4.esm');
  const mod = override('MyMod.esp');
  return {
    diff: diff(),
    conflictAll: 'NoConflict',
    columns: [diskColumn(master), diskColumn(mod)],
    overrideMap: { 'Fallout4.esm': master, 'MyMod.esp': mod },
    fieldMetaMap: { Name: strMeta },
    immutableSet: new Set(['Fallout4.esm']),
    pendingChangeMap: {},
    collapsedColumns: new Set(),
    onOpen: vi.fn(),
    onEdit: vi.fn(),
    onCellDragStart: vi.fn(),
    onCellDrop: vi.fn(),
    context: { kind: 'top-level' },
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

  it('renders a blank cell for a collapsed column', () => {
    renderRow({ collapsedColumns: new Set(['MyMod.esp']) });
    // Only one 'disk-value' now shows — MyMod.esp's column is blanked.
    expect(screen.getAllByText('disk-value').length).toBe(1);
  });
});

describe('DiffRow — editability follows immutableSet', () => {
  it('an immutable column renders read-only text, not an input', () => {
    renderRow();
    // Fallout4.esm is immutable per baseProps — clicking its cell must not produce an input.
    const cells = screen.getAllByText('disk-value');
    fireEvent.click(cells[0]);
    expect(screen.queryByDisplayValue('disk-value')).not.toBeInTheDocument();
  });

  it('a mutable column click activates an editable input', () => {
    renderRow();
    const cells = screen.getAllByText('disk-value');
    fireEvent.click(cells[1]); // MyMod.esp — mutable
    expect(screen.getByDisplayValue('disk-value')).toBeInTheDocument();
  });

  it('editing a mutable cell calls onEdit with plugin/fieldName/value', () => {
    const onEdit = vi.fn();
    renderRow({ onEdit });
    fireEvent.click(screen.getAllByText('disk-value')[1]);
    const input = screen.getByDisplayValue('disk-value');
    fireEvent.change(input, { target: { value: 'new-value' } });
    fireEvent.blur(input);
    expect(onEdit).toHaveBeenCalledWith('MyMod.esp', 'Name', 'new-value');
  });
});

describe('DiffRow — drag affordance on leaf cells', () => {
  it('dragging a disk cell calls onCellDragStart with the field name, its value, and the source plugin', () => {
    const onCellDragStart = vi.fn();
    renderRow({ onCellDragStart });
    const cell = screen.getAllByText('disk-value')[0].closest('td')!;
    fireEvent.dragStart(cell);
    // Issue #206: the source plugin must be carried too — handleCellDrop has no other way to
    // detect a self-drop (same cell dragged back onto itself).
    expect(onCellDragStart).toHaveBeenCalledWith('Name', 'disk-value', 'Fallout4.esm');
  });

  it('dropping on a cell calls onCellDrop with the field name and target plugin', () => {
    const onCellDrop = vi.fn();
    renderRow({ onCellDrop });
    const cell = screen.getAllByText('disk-value')[1].closest('td')!;
    fireEvent.drop(cell);
    expect(onCellDrop).toHaveBeenCalledWith('Name', 'MyMod.esp', expect.any(Function));
  });
});

// Issue #204 / ADR-0033: a struct/array field's collapsed summary row is a drag source too —
// there is no cell kind that silently opts out of the copy gesture.
describe('DiffRow — drag affordance on compound (hasChildren) cells', () => {
  const arrMeta: FieldMetadata = { name: 'Items', type: 'array', isArray: true, validFormKeyTypes: [], enumValues: [] };

  function renderCompoundRow(overrides: Partial<React.ComponentProps<typeof DiffRow>> = {}) {
    return renderRow({
      hasChildren: true,
      diff: diff({ fieldName: 'Items', values: { 'Fallout4.esm': ['a', 'b'], 'MyMod.esp': ['a', 'b'] } }),
      fieldMetaMap: { Items: arrMeta },
      ...overrides,
    });
  }

  it('dragging a collapsed struct/array summary calls onCellDragStart with the field name, its value, and the source plugin', () => {
    const onCellDragStart = vi.fn();
    renderCompoundRow({ onCellDragStart });
    const cell = screen.getAllByText('[2]')[0].closest('td')!;
    fireEvent.dragStart(cell);
    // Issue #206: same source-plugin requirement as the leaf-cell case above.
    expect(onCellDragStart).toHaveBeenCalledWith('Items', ['a', 'b'], 'Fallout4.esm');
  });

  it('dropping on a collapsed struct/array summary calls onCellDrop with the field name and target plugin', () => {
    const onCellDrop = vi.fn();
    renderCompoundRow({ onCellDrop });
    const cell = screen.getAllByText('[2]')[1].closest('td')!;
    fireEvent.drop(cell);
    expect(onCellDrop).toHaveBeenCalledWith('Items', 'MyMod.esp', expect.any(Function));
  });
});

describe('DiffRow — pending companion column', () => {
  const change: PendingChange = {
    id: 'c1', formKey: '000001:Fallout4.esm', plugin: 'MyMod.esp', fieldPath: 'Name',
    recordType: 'Npc', oldValue: 'disk-value', newValue: 'pending-value',
    source: 'agent', description: null, changedAt: '2026-06-20T12:00:00Z',
  };

  function pendingProps(overrides: Partial<React.ComponentProps<typeof DiffRow>> = {}) {
    const master = override('Fallout4.esm');
    const mod = override('MyMod.esp', { pendingFields: { Name: 'pending-value' } });
    return baseProps({
      columns: [diskColumn(master), diskColumn(mod), pendingColumn('MyMod.esp')],
      overrideMap: { 'Fallout4.esm': master, 'MyMod.esp': mod },
      pendingChangeMap: { 'MyMod.esp:Name': change },
      ...overrides,
    });
  }

  // Issue #207 / ADR-0033: revert lives only on the right-click menu's Revert Group — no
  // standalone icon on the pending cell now that it exists there.
  it('renders the pending value with no inline revert control', () => {
    render(<table><tbody>{React.createElement(DiffRow, pendingProps())}</tbody></table>);
    expect(screen.getByText('pending-value')).toBeInTheDocument();
    expect(screen.queryByTitle('Revert group')).not.toBeInTheDocument();
  });

  // Issue #203: plain click on a pending value now edits it directly, on the same terms as a
  // disk cell — reveal moved to the right-click menu (#208: now VS Code's native context menu).
  // This replaces the #140 "plain click reveals" test above, which pinned exactly the behavior
  // #203 reverses.
  it('plain click on the pending cell activates an editable input, not a reveal', () => {
    render(<table><tbody>{React.createElement(DiffRow, pendingProps())}</tbody></table>);
    fireEvent.click(screen.getByText('pending-value'));
    expect(screen.getByDisplayValue('pending-value')).toBeInTheDocument();
  });

  it('committing an edit on the pending cell calls onEdit with plugin/fieldName/value, the same shape a disk-cell edit uses', () => {
    const onEdit = vi.fn();
    render(<table><tbody>{React.createElement(DiffRow, pendingProps({ onEdit }))}</tbody></table>);
    fireEvent.click(screen.getByText('pending-value'));
    const input = screen.getByDisplayValue('pending-value');
    fireEvent.change(input, { target: { value: 'edited-again' } });
    fireEvent.blur(input);
    expect(onEdit).toHaveBeenCalledWith('MyMod.esp', 'Name', 'edited-again');
  });

  // Issue #203 AC: "the disk cell for that same field remains editable too (no lock)" — editing
  // the pending cell must not disable the disk cell for the same row/plugin.
  it('the disk cell for the same field stays editable while the pending cell is also editable', () => {
    render(<table><tbody>{React.createElement(DiffRow, pendingProps())}</tbody></table>);
    // Both plugin columns render 'disk-value' (see override() default fixture); MyMod.esp's disk
    // cell is the second occurrence, same as the "editability follows immutableSet" tests above.
    const diskCells = screen.getAllByText('disk-value');
    fireEvent.click(diskCells[1]);
    expect(screen.getByDisplayValue('disk-value')).toBeInTheDocument();
  });

  // Issue #208: the pending cell's right-click menu is now VS Code's own `webview/context`
  // contribution, gated by `data-vscode-context` rather than a hand-drawn menu wired through a
  // callback prop — so this asserts the attribute VS Code's preload script reads (merged with
  // the invoked command's `webviewId`), not a synthetic contextmenu dispatch.
  it('the pending cell carries a data-vscode-context attribute gating the native menu on this change id', () => {
    render(<table><tbody>{React.createElement(DiffRow, pendingProps())}</tbody></table>);
    const cell = screen.getByText('pending-value').closest('td')!;
    expect(cell.getAttribute('data-vscode-context')).toBe(pendingCellContext('c1'));
    expect(JSON.parse(cell.getAttribute('data-vscode-context')!)).toEqual({
      webviewSection: 'pendingCell', changeId: 'c1', preventDefaultContextMenuItems: true,
    });
  });

  // Issue #159: the pending column renders a FormKey field's staged value through the same
  // FormKeyLink as disk columns, sourced from the change's own `resolutions['']` (root path,
  // matching PendingChangeResolver's convention for a scalar formKey field) — not the old
  // PENDING_RESOLVES stand-in.
  describe('pending FormKey cell', () => {
    const fkMeta: FieldMetadata = { name: 'Reference', type: 'formKey', isArray: false, validFormKeyTypes: [], enumValues: [] };
    const fkChange: PendingChange = {
      id: 'c3', formKey: '000001:Fallout4.esm', plugin: 'MyMod.esp', fieldPath: 'Reference',
      recordType: 'Npc', oldValue: '000010:Fallout4.esm', newValue: '000020:Fallout4.esm',
      source: 'agent', description: null, changedAt: '2026-06-20T12:00:00Z',
    };

    function fkPendingProps(resolutions: Record<string, FormKeyResolution> | undefined) {
      const master = override('Fallout4.esm', { fields: [{ metadata: fkMeta, value: '000010:Fallout4.esm' }] });
      const mod = override('MyMod.esp', {
        fields: [{ metadata: fkMeta, value: '000010:Fallout4.esm' }],
        pendingFields: { Reference: '000020:Fallout4.esm' },
      });
      return baseProps({
        diff: diff({ fieldName: 'Reference', values: { 'Fallout4.esm': '000010:Fallout4.esm', 'MyMod.esp': '000010:Fallout4.esm' } }),
        fieldMetaMap: { Reference: fkMeta },
        columns: [diskColumn(master), diskColumn(mod), pendingColumn('MyMod.esp')],
        overrideMap: { 'Fallout4.esm': master, 'MyMod.esp': mod },
        pendingChangeMap: { 'MyMod.esp:Reference': { ...fkChange, resolutions } },
      });
    }

    it('renders the resolved EditorID as the pending cell label', () => {
      render(<table><tbody>{React.createElement(DiffRow, fkPendingProps({
        '': { state: 'ResolvedValidType', recordType: 'npc_', editorId: 'SomeOtherNpc' },
      }))}</tbody></table>);
      expect(screen.getByText('SomeOtherNpc')).toBeInTheDocument();
      expect(screen.queryByText('000020:Fallout4.esm')).not.toBeInTheDocument();
    });

    it('falls back to the raw FormKey when unresolved', () => {
      render(<table><tbody>{React.createElement(DiffRow, fkPendingProps({
        '': { state: 'Unresolved', recordType: null, editorId: null },
      }))}</tbody></table>);
      expect(screen.getByText('000020:Fallout4.esm')).toBeInTheDocument();
    });

    it('falls back to the raw FormKey when the change carries no resolutions at all', () => {
      render(<table><tbody>{React.createElement(DiffRow, fkPendingProps(undefined))}</tbody></table>);
      expect(screen.getByText('000020:Fallout4.esm')).toBeInTheDocument();
    });
  });

  // Issue #159: nested rows (struct member / array element / struct member of an array element)
  // look up their resolution at the sub-path PendingChangeResolver used for that leaf within the
  // top-level change's NewValue — not at the root ("") path.
  describe('pending FormKey cell — nested contexts', () => {
    function nestedChange(fieldPath: string, resolutions: Record<string, FormKeyResolution>): PendingChange {
      return {
        id: 'c4', formKey: '000001:Fallout4.esm', plugin: 'MyMod.esp', fieldPath,
        recordType: 'Npc', oldValue: null, newValue: null,
        source: 'agent', description: null, changedAt: '2026-06-20T12:00:00Z',
        resolutions,
      };
    }

    it('a struct-child pending FormKey cell resolves via the member-name path', () => {
      const fkMeta: FieldMetadata = { name: 'Target', type: 'formKey', isArray: false, validFormKeyTypes: [], enumValues: [] };
      const mod = override('MyMod.esp', { pendingFields: { LinkedRef: { Target: '000030:Fallout4.esm' } } });
      render(<table><tbody>{React.createElement(DiffRow, baseProps({
        diff: diff({ fieldName: 'Target', values: { 'MyMod.esp': '000010:Fallout4.esm' } }),
        columns: [diskColumn(mod), pendingColumn('MyMod.esp')],
        overrideMap: { 'MyMod.esp': mod },
        pendingChangeMap: { 'MyMod.esp:LinkedRef': nestedChange('LinkedRef', {
          Target: { state: 'ResolvedValidType', recordType: 'npc_', editorId: 'StructTarget' },
        }) },
        context: { kind: 'struct-child', overrideMeta: fkMeta, parentFieldName: 'LinkedRef' },
      }))}</tbody></table>);
      expect(screen.getByText('StructTarget')).toBeInTheDocument();
    });

    it('a positional array-element pending FormKey cell resolves via its "[idx]" path', () => {
      const fkMeta: FieldMetadata = { name: '', type: 'formKey', isArray: false, validFormKeyTypes: [], enumValues: [] };
      const mod = override('MyMod.esp', { pendingFields: { Items: ['000030:Fallout4.esm'] } });
      render(<table><tbody>{React.createElement(DiffRow, baseProps({
        diff: diff({ fieldName: '[0]', values: { 'MyMod.esp': '000010:Fallout4.esm' } }),
        columns: [diskColumn(mod), pendingColumn('MyMod.esp')],
        overrideMap: { 'MyMod.esp': mod },
        pendingChangeMap: { 'MyMod.esp:Items': nestedChange('Items', {
          '[0]': { state: 'ResolvedValidType', recordType: 'npc_', editorId: 'PositionalTarget' },
        }) },
        context: { kind: 'array-element', overrideMeta: fkMeta, parentFieldName: 'Items' },
      }))}</tbody></table>);
      expect(screen.getByText('PositionalTarget')).toBeInTheDocument();
    });

    it('a sortable (pure FormLink) array-element pending FormKey cell resolves by its position in the pending array', () => {
      const fkMeta: FieldMetadata = { name: '', type: 'formKey', isArray: false, validFormKeyTypes: [], enumValues: [], isSortable: true };
      const mod = override('MyMod.esp', { pendingFields: { Items: ['000010:Fallout4.esm', '000099:Fallout4.esm'] } });
      render(<table><tbody>{React.createElement(DiffRow, baseProps({
        diff: diff({ fieldName: '000099:Fallout4.esm', values: { 'MyMod.esp': '000088:Fallout4.esm' } }),
        columns: [diskColumn(mod), pendingColumn('MyMod.esp')],
        overrideMap: { 'MyMod.esp': mod },
        pendingChangeMap: { 'MyMod.esp:Items': nestedChange('Items', {
          '[1]': { state: 'ResolvedValidType', recordType: 'kywd', editorId: 'SortedTarget' },
        }) },
        context: { kind: 'array-element', overrideMeta: fkMeta, parentFieldName: 'Items' },
      }))}</tbody></table>);
      expect(screen.getByText('SortedTarget')).toBeInTheDocument();
    });

    it('a grandchild pending FormKey cell resolves via its "[idx].member" path', () => {
      const fkMeta: FieldMetadata = { name: 'Target', type: 'formKey', isArray: false, validFormKeyTypes: [], enumValues: [] };
      const mod = override('MyMod.esp', { pendingFields: { Items: [{}, {}, { Target: '000077:Fallout4.esm' }] } });
      render(<table><tbody>{React.createElement(DiffRow, baseProps({
        diff: diff({ fieldName: 'Target', values: { 'MyMod.esp': '000010:Fallout4.esm' } }),
        columns: [diskColumn(mod), pendingColumn('MyMod.esp')],
        overrideMap: { 'MyMod.esp': mod },
        pendingChangeMap: { 'MyMod.esp:Items': nestedChange('Items', {
          '[2].Target': { state: 'ResolvedValidType', recordType: 'npc_', editorId: 'GrandchildTarget' },
        }) },
        context: { kind: 'grandchild', overrideMeta: fkMeta, parentFieldName: 'Items', parentFieldIndex: 2 },
      }))}</tbody></table>);
      expect(screen.getByText('GrandchildTarget')).toBeInTheDocument();
    });
  });

  it('renders nothing in the pending column when there is no pending value', () => {
    const master = override('Fallout4.esm');
    const mod = override('MyMod.esp'); // no pendingFields
    const { container } = render(<table><tbody>{React.createElement(DiffRow, baseProps({
      columns: [diskColumn(master), diskColumn(mod), pendingColumn('MyMod.esp')],
      overrideMap: { 'Fallout4.esm': master, 'MyMod.esp': mod },
    }))}</tbody></table>);
    const pendingCell = container.querySelectorAll('td')[3];
    expect(pendingCell.textContent).toBe('');
  });
});

describe('DiffRow — non-top-level contexts', () => {
  it('array-element / struct-child / grandchild rows indent (array-element example)', () => {
    const master = override('Fallout4.esm');
    const mod = override('MyMod.esp', { pendingFields: { Items: ['x', 'y'] } });
    const elementMeta: FieldMetadata = { name: '', type: 'string', isArray: false, validFormKeyTypes: [], enumValues: [] };
    const change: PendingChange = {
      id: 'c2', formKey: '000001:Fallout4.esm', plugin: 'MyMod.esp', fieldPath: 'Items',
      recordType: 'Npc', oldValue: ['x'], newValue: ['x', 'y'], source: 'agent', description: null,
      changedAt: '2026-06-20T12:00:00Z',
    };
    render(<table><tbody>{React.createElement(DiffRow, baseProps({
      diff: diff({ fieldName: '[1]', values: { 'Fallout4.esm': 'x', 'MyMod.esp': 'x' } }),
      columns: [diskColumn(master), diskColumn(mod), pendingColumn('MyMod.esp')],
      overrideMap: { 'Fallout4.esm': master, 'MyMod.esp': mod },
      pendingChangeMap: { 'MyMod.esp:Items': change },
      context: { kind: 'array-element', overrideMeta: elementMeta, parentFieldName: 'Items' },
    }))}</tbody></table>);
    const fieldCell = screen.getByText('[1]').closest('td')!;
    expect(fieldCell.style.paddingLeft).toBe('24px');
  });

  it('returns null when the row context has no resolvable field metadata', () => {
    const { container } = render(<table><tbody>{React.createElement(DiffRow, baseProps({
      fieldMetaMap: {}, // 'Name' not present -> top-level meta lookup misses
    }))}</tbody></table>);
    expect(container.querySelector('tr')).not.toBeInTheDocument();
  });
});

// Issue #157 / ADR-0031 regression coverage: the affordance must key off the leaf's own
// `diff.resolutions` entry, not the parent field's aggregate `checkError` (looked up via
// `overrideMap`/`pendingLookupField`) — a dangling sibling in the same struct/array must not hide
// a live link on the leaf next to it.
describe('DiffRow — FormKey leaf resolution is independent of the parent field aggregate', () => {
  const fkMeta: FieldMetadata = { name: '', type: 'formKey', isArray: false, validFormKeyTypes: [], enumValues: [] };
  const validType: FormKeyResolution = { state: 'ResolvedValidType', recordType: 'kywd', editorId: 'SomeKeyword' };
  const wrongType: FormKeyResolution = { state: 'ResolvedWrongType', recordType: 'npc_', editorId: 'SomeNpc' };
  const unresolved: FormKeyResolution = { state: 'Unresolved', recordType: null, editorId: null };

  // Simulates today's aggregate bug: the parent field carries a checkError (e.g. because a
  // *different* sibling element/member is dangling), which the old code read via overrideMap +
  // pendingLookupField regardless of which leaf row was rendering.
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
    return baseProps({
      diff: diff({ fieldName: kind === 'array-element' ? '[1]' : 'Reference', values: { 'Fallout4.esm': value }, resolutions: { 'Fallout4.esm': resolution } }),
      columns: [diskColumn(master)],
      overrideMap: { 'Fallout4.esm': master },
      fieldMetaMap: { [parentFieldName]: fkMeta },
      immutableSet: new Set(),
      context: { kind, overrideMeta: fkMeta, parentFieldName },
    });
  }

  afterEach(() => { fireEvent.keyUp(window, { key: 'Control' }); });

  it('an array-element resolved-valid-type leaf still shows the affordance despite the parent field checkError', () => {
    renderRow(leafProps('array-element', validType));
    const link = screen.getByText('SomeKeyword');
    fireEvent.keyDown(window, { key: 'Control', ctrlKey: true });
    fireEvent.mouseEnter(link);
    expect(link.style.textDecoration).toBe('underline');
  });

  it('an array-element resolved-wrong-type leaf still shows the affordance despite the parent field checkError', () => {
    renderRow(leafProps('array-element', wrongType, '00001A:Fallout4.esm'));
    const link = screen.getByText('SomeNpc');
    fireEvent.keyDown(window, { key: 'Control', ctrlKey: true });
    fireEvent.mouseEnter(link);
    expect(link.style.textDecoration).toBe('underline');
  });

  it('a struct-child resolved-valid-type leaf still shows the affordance despite the parent field checkError', () => {
    renderRow(leafProps('struct-child', validType));
    const link = screen.getByText('SomeKeyword');
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
    const link = screen.getByText('SomeNpc');
    fireEvent.keyDown(window, { key: 'Control', ctrlKey: true });
    fireEvent.mouseEnter(link);
    expect(link.style.textDecoration).toBe('underline');
  });
});
