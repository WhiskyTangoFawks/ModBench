import '@testing-library/jest-dom';
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';

// Issue #210: FormKeyCell (rendered for formKey-typed fields) now imports the pickFormKey
// bridge, which touches vscode.ts's acquireVsCodeApi() at module load — stubbed here since
// these tests don't exercise the picker itself (see FormKeyCell.test.tsx for that).
// Issue #224: copyToClipboard is DiffRow's own import now (Ctrl+C's clipboard write) — mocked
// here too so the #224 describe block below can assert on it directly.
const copyToClipboard = vi.fn();
vi.mock('./nativeBridge', () => ({
  pickFormKey: vi.fn().mockResolvedValue(null),
  copyToClipboard: (...args: unknown[]) => copyToClipboard(...args),
}));

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
    formKey: '000001:Fallout4.esm',
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
    // Issue #222: rowKey matches diff().fieldName below — the same identity RecordPanel derives
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

  it('renders a blank cell for a collapsed column', () => {
    renderRow({ collapsedColumns: new Set(['MyMod.esp']) });
    // Only one 'disk-value' now shows — MyMod.esp's column is blanked.
    expect(screen.getAllByText('disk-value').length).toBe(1);
  });
});

describe('DiffRow — editability follows immutableSet', () => {
  // Issue #201 / ADR-0033: this test's mechanism is superseded, its intent is not. An immutable
  // column used to produce no input at all — that absence *was* the gap, since it left the value
  // with no way out of the cell. It now activates a surface like any other cell; what makes the
  // column immutable is `readOnly` and that nothing stages, not the lack of an input.
  it('an immutable column activates a read-only surface, never an editable one', () => {
    const onEdit = vi.fn();
    renderRow({ onEdit });
    // Fallout4.esm is immutable per baseProps.
    fireEvent.click(screen.getAllByText('disk-value')[0]);

    const surface = screen.getByDisplayValue('disk-value');
    expect(surface).toHaveAttribute('readonly');
    fireEvent.change(surface, { target: { value: 'new-value' } });
    fireEvent.blur(surface);
    expect(onEdit).not.toHaveBeenCalled();
  });

  // Issue #223 / ADR-0034: a mutable column no longer opens on a bare click — only a *second*
  // click on the already-focused cell does, so this test pre-seeds `focusedCell` to simulate the
  // cell already carrying focus (the state a first click would have produced).
  it('a click on the already-focused mutable column activates an editable input', () => {
    renderRow({ focusedCell: { rowKey: 'Name', plugin: 'MyMod.esp' } });
    const cells = screen.getAllByText('disk-value');
    fireEvent.click(cells[1]); // MyMod.esp — mutable, already focused
    expect(screen.getByDisplayValue('disk-value')).toBeInTheDocument();
  });

  // Issue #223 AC1: a first click on an unfocused cell only focuses it — the editor stays shut.
  it('a click on an unfocused mutable column only focuses it, opening nothing', () => {
    renderRow({ focusedCell: null });
    fireEvent.click(screen.getAllByText('disk-value')[1]); // MyMod.esp — mutable, not focused
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  });

  it('editing a mutable cell calls onEdit with plugin/fieldName/value', () => {
    const onEdit = vi.fn();
    renderRow({ onEdit, focusedCell: { rowKey: 'Name', plugin: 'MyMod.esp' } });
    fireEvent.click(screen.getAllByText('disk-value')[1]);
    const input = screen.getByDisplayValue('disk-value');
    fireEvent.change(input, { target: { value: 'new-value' } });
    fireEvent.blur(input);
    expect(onEdit).toHaveBeenCalledWith('MyMod.esp', 'Name', 'new-value');
  });
});

// Issue #223 / ADR-0034: F2 opens the focused cell's editor by dispatching a click at whichever
// element the currently-rendered leaf marked `data-open-trigger` — DiskCell's own mechanism, so
// it's exercised here rather than at the leaf seam (the leaf tests already cover the trigger
// element/gate itself).
describe('DiffRow — F2 opens the focused cell (#223)', () => {
  it('F2 on the focused mutable disk cell opens its editor', () => {
    renderRow({ focusedCell: { rowKey: 'Name', plugin: 'MyMod.esp' } });
    const cell = screen.getAllByText('disk-value')[1].closest('td')!;
    fireEvent.keyDown(cell, { key: 'F2' });
    expect(screen.getByDisplayValue('disk-value')).toBeInTheDocument();
  });

  // Untouched by this ticket — F2 never opened anything on an immutable cell before #223, and
  // the immutable branch carries no `data-open-trigger`, so it still doesn't.
  it('F2 on the focused immutable disk cell opens nothing', () => {
    renderRow({ focusedCell: { rowKey: 'Name', plugin: 'Fallout4.esm' } });
    const cell = screen.getAllByText('disk-value')[0].closest('td')!;
    fireEvent.keyDown(cell, { key: 'F2' });
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  });

  it('F2 does nothing when the cell is not the focused one', () => {
    renderRow({ focusedCell: null });
    const cell = screen.getAllByText('disk-value')[1].closest('td')!;
    fireEvent.keyDown(cell, { key: 'F2' });
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  });
});

// Issue #223 / ADR-0034: a double click on a value cell opens its editor unconditionally,
// independent of the click-focus gate above.
describe('DiffRow — double click opens a value cell (#223)', () => {
  it('double click on a mutable disk cell opens its editor even when not previously focused', () => {
    renderRow({ focusedCell: null });
    fireEvent.doubleClick(screen.getAllByText('disk-value')[1]); // MyMod.esp — mutable
    expect(screen.getByDisplayValue('disk-value')).toBeInTheDocument();
  });

  // Untouched by this ticket — see the F2 case above for the same rationale.
  it('double click on an immutable disk cell opens nothing', () => {
    renderRow({ focusedCell: null });
    fireEvent.doubleClick(screen.getAllByText('disk-value')[0]); // Fallout4.esm — immutable
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

  // Issue #201, revised by #222 / ADR-0034: the cursor contract (`grab` at rest, caret once
  // active) is gone — the grid rests on the default arrow everywhere, so there is no cursor state
  // left to "stand down." What survives is the drag suppression itself: DiskCell's existing focus
  // watcher still stands `draggable` down while a real <input> (the read-only surface, here) is
  // active inside the cell, and hands it back on blur — unrelated to which cursor is showing.
  it('stands the drag down while an immutable cell has its read-only surface active', () => {
    renderRow();
    const cell = screen.getAllByText('disk-value')[0].closest('td')!;
    expect(cell).toHaveAttribute('draggable', 'true');

    fireEvent.click(screen.getAllByText('disk-value')[0]);
    const surface = screen.getByDisplayValue('disk-value');
    expect(cell).toHaveAttribute('draggable', 'false');

    fireEvent.blur(surface);
    expect(cell).toHaveAttribute('draggable', 'true');
  });

  // Issue #222 / ADR-0034: `grab` is removed from every value cell — the grid rests on the
  // default arrow, and drag is simply unadvertised (as in xEdit) rather than shown by the cursor.
  it('shows no grab cursor at rest on a leaf cell', () => {
    renderRow();
    const cell = screen.getAllByText('disk-value')[0].closest('td')!;
    expect(cell.style.cursor).not.toBe('grab');
  });
});

// Issue #224 / ADR-0034: Ctrl+C copies the focused cell's model value — a real keydown dispatched
// on the cell's own DOM node (not a mocked call), confirming the AC1 premise that the webview
// receives Ctrl+C via the cell's own DOM focus (#222), with no dependency on text selection or
// VS Code forwarding anything.
describe('DiffRow — Ctrl+C copies the focused cell (#224)', () => {
  beforeEach(() => { copyToClipboard.mockClear(); });

  it('Ctrl+C on a focused mutable disk cell copies its model value', () => {
    renderRow({ focusedCell: { rowKey: 'Name', plugin: 'MyMod.esp' } });
    const cell = screen.getAllByText('disk-value')[1].closest('td')!;
    fireEvent.keyDown(cell, { key: 'c', ctrlKey: true });
    expect(copyToClipboard).toHaveBeenCalledWith('disk-value');
  });

  // AC3: works on an immutable column too, without the read-only surface ever being opened —
  // the replacement copy path #201's "click activates a read-only surface" doesn't cover until
  // this cell is clicked.
  it('Ctrl+C on a focused, unopened immutable disk cell also copies (AC3)', () => {
    renderRow({ focusedCell: { rowKey: 'Name', plugin: 'Fallout4.esm' } });
    const cell = screen.getAllByText('disk-value')[0].closest('td')!;
    fireEvent.keyDown(cell, { key: 'c', ctrlKey: true });
    expect(copyToClipboard).toHaveBeenCalledWith('disk-value');
  });

  // Per the issue's "Decided" section: Ctrl+C must reach the webview only when there is no
  // focused form control — DiskCell gates its own handler on `!editing` for exactly this reason.
  // Once a form control inside the cell has real focus (an open editor here), the browser's own
  // "copy the current selection" must win instead — proven by actually opening the editor and
  // dispatching the keydown on the resulting <input>, not by asserting the gate exists.
  it('Ctrl+C is suppressed while the cell has an open editor — native selection copy applies instead', () => {
    renderRow({ focusedCell: { rowKey: 'Name', plugin: 'MyMod.esp' } });
    fireEvent.click(screen.getAllByText('disk-value')[1]); // second click on the focused cell opens it
    const input = screen.getByDisplayValue('disk-value');
    fireEvent.keyDown(input, { key: 'c', ctrlKey: true });
    expect(copyToClipboard).not.toHaveBeenCalled();
  });

  // AC5: a struct/array summary row copies its whole value as JSON, not the "{…}"/"[3]"
  // placeholder its collapsed cell renders.
  it('Ctrl+C on a collapsed array summary row copies the whole value as JSON, not "[3]"', () => {
    const arrayMeta: FieldMetadata = {
      name: 'Factions', type: 'array', isArray: true, validFormKeyTypes: [], enumValues: [],
      elementType: { name: 'Factions', type: 'int', isArray: false, validFormKeyTypes: [], enumValues: [] },
    };
    renderRow({
      diff: diff({ fieldName: 'Factions', values: { 'Fallout4.esm': [1, 2, 3], 'MyMod.esp': [1, 2, 3] } }),
      fieldMetaMap: { Factions: arrayMeta },
      rowKey: 'Factions',
      hasChildren: true,
      isExpanded: false,
      focusedCell: { rowKey: 'Factions', plugin: 'MyMod.esp' },
    });
    const cell = screen.getAllByText('[3]')[1].closest('td')!; // MyMod.esp — the focused column
    fireEvent.keyDown(cell, { key: 'c', ctrlKey: true });
    expect(copyToClipboard).toHaveBeenCalledWith('[1,2,3]');
  });
});

// Issue #222 / ADR-0034: click focuses a cell — the row highlights, one cell carries real DOM
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
    renderRow({ focusedCell: { rowKey: 'Name', plugin: 'MyMod.esp' } });
    const cell = screen.getAllByText('disk-value')[1].closest('td')!;
    expect(cell).toHaveAttribute('tabindex', '0');
    expect(cell).toHaveFocus();
  });

  it('a cell not matching focusedCell does not carry DOM focus', () => {
    renderRow({ focusedCell: { rowKey: 'Name', plugin: 'MyMod.esp' } });
    const cell = screen.getAllByText('disk-value')[0].closest('td')!; // Fallout4.esm, not the match
    expect(cell).not.toHaveFocus();
  });

  it('the row containing the focused cell is highlighted', () => {
    renderRow({ focusedCell: { rowKey: 'Name', plugin: 'MyMod.esp' } });
    const row = screen.getAllByText('disk-value')[1].closest('tr')!;
    expect(row.style.boxShadow).toContain('var(--vscode-focusBorder');
  });

  it('a row with no focused cell in it is not highlighted', () => {
    renderRow({ focusedCell: null });
    const row = screen.getAllByText('disk-value')[0].closest('tr')!;
    expect(row.style.boxShadow).toBe('');
  });

  it('the focused cell itself is visibly distinguished from the rest of its row', () => {
    renderRow({ focusedCell: { rowKey: 'Name', plugin: 'MyMod.esp' } });
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

  // Issue #201, revised by #222 / ADR-0034 — `[2]` and `{…}` are placeholders, not values: a
  // surface here would hand over the literal string `[2]`, which is worse than nothing because it
  // looks like a successful copy. They stay pure drag sources (no cursor advertises it any more,
  // per #222), and the leaves are reachable by expanding the row.
  it('a collapsed summary activates no surface and stays a drag source', () => {
    renderCompoundRow();
    const cell = screen.getAllByText('[2]')[0].closest('td')!;
    fireEvent.click(screen.getAllByText('[2]')[0]);

    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(cell).toHaveAttribute('draggable', 'true');
    expect(cell.style.cursor).not.toBe('grab');
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
    // Issue #223: pre-seeded as already focused — see the top-level "already-focused mutable
    // column" test above for why a bare click no longer suffices.
    render(<table><tbody>{React.createElement(DiffRow, pendingProps({
      focusedCell: { rowKey: 'Name', plugin: 'MyMod.esp' },
    }))}</tbody></table>);
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

    // Issue #218: the pending cell's label is the same composite the disk cells use — the staged
    // value is a reference like any other, so it reads back in the format it was chosen in.
    it('renders the resolved EditorID [FormKey] composite as the pending cell label', () => {
      render(<table><tbody>{React.createElement(DiffRow, fkPendingProps({
        '': { state: 'ResolvedValidType', recordType: 'npc_', editorId: 'SomeOtherNpc' },
      }))}</tbody></table>);
      expect(screen.getByText('SomeOtherNpc [000020:Fallout4.esm]')).toBeInTheDocument();
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
      expect(screen.getByText('StructTarget [000030:Fallout4.esm]')).toBeInTheDocument();
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
      expect(screen.getByText('PositionalTarget [000030:Fallout4.esm]')).toBeInTheDocument();
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
      expect(screen.getByText('SortedTarget [000099:Fallout4.esm]')).toBeInTheDocument();
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
      expect(screen.getByText('GrandchildTarget [000077:Fallout4.esm]')).toBeInTheDocument();
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

// Issue #227 / ADR-0034: array structure ops (Add/Remove/Move Up/Move Down) move off #142's
// inline ▲▼✕/＋ buttons onto xEdit's right-click menu + keyboard accelerators. This block covers
// the two seams DiffRow itself owns: the data-vscode-context attribute the native
// `webview/context` menu gates on, and the Insert/Delete/Ctrl+↑/Ctrl+↓ keydown handling that
// mirrors #224's Ctrl+C precedent (a real keydown dispatched on the cell's own DOM node, not a
// mocked call). The broadcast handler that receives the menu's commands lives in RecordPanel
// (tested there, in ArrayDiffRows.test.tsx); the pure mutations live in recordUtils.test.ts.
describe('DiffRow — array-parent row (Add, #227)', () => {
  const arrayMeta: FieldMetadata = {
    name: 'Items', type: 'array', isArray: true, validFormKeyTypes: [], enumValues: [],
    elementType: { name: '', type: 'string', isArray: false, validFormKeyTypes: [], enumValues: [] },
  };

  function arrayParentProps(overrides: Partial<React.ComponentProps<typeof DiffRow>> = {}) {
    const master = override('Fallout4.esm', { fields: [{ metadata: arrayMeta, value: ['a', 'b'] }] });
    const mod = override('MyMod.esp', { fields: [{ metadata: arrayMeta, value: ['a', 'b', 'c'] }] });
    return baseProps({
      diff: diff({ fieldName: 'Items', values: { 'Fallout4.esm': ['a', 'b'], 'MyMod.esp': ['a', 'b', 'c'] } }),
      fieldMetaMap: { Items: arrayMeta },
      columns: [diskColumn(master), diskColumn(mod)],
      overrideMap: { 'Fallout4.esm': master, 'MyMod.esp': mod },
      context: { kind: 'top-level' },
      rowKey: 'Items',
      hasChildren: true,
      isExpanded: false,
      onArrayAdd: vi.fn(),
      ...overrides,
    });
  }

  it('the mutable column carries the arrayParent data-vscode-context', () => {
    const { container } = render(<table><tbody>{React.createElement(DiffRow, arrayParentProps())}</tbody></table>);
    const mutableCell = container.querySelectorAll('td')[2]; // 0 = label, 1 = Fallout4.esm, 2 = MyMod.esp
    expect(JSON.parse(mutableCell.getAttribute('data-vscode-context')!)).toEqual({
      webviewSection: 'arrayParent', formKey: '000001:Fallout4.esm', plugin: 'MyMod.esp', fieldName: 'Items',
      preventDefaultContextMenuItems: true,
    });
  });

  it('the immutable column carries no data-vscode-context', () => {
    const { container } = render(<table><tbody>{React.createElement(DiffRow, arrayParentProps())}</tbody></table>);
    const immutableCell = container.querySelectorAll('td')[1];
    expect(immutableCell.getAttribute('data-vscode-context')).toBeNull();
  });

  it('is present regardless of expand state — collapsed rows still carry it', () => {
    const { container } = render(<table><tbody>{React.createElement(DiffRow, arrayParentProps({ isExpanded: false }))}</tbody></table>);
    const mutableCell = container.querySelectorAll('td')[2];
    expect(mutableCell.getAttribute('data-vscode-context')).not.toBeNull();
  });

  it('Insert on the mutable column calls onArrayAdd for that plugin', () => {
    const onArrayAdd = vi.fn();
    const { container } = render(<table><tbody>{React.createElement(DiffRow, arrayParentProps({ onArrayAdd }))}</tbody></table>);
    const mutableCell = container.querySelectorAll('td')[2];
    fireEvent.keyDown(mutableCell, { key: 'Insert' });
    expect(onArrayAdd).toHaveBeenCalledWith('MyMod.esp');
  });

  it('Insert on the immutable column does nothing (no onArrayAdd call, no attribute)', () => {
    const onArrayAdd = vi.fn();
    const { container } = render(<table><tbody>{React.createElement(DiffRow, arrayParentProps({ onArrayAdd }))}</tbody></table>);
    const immutableCell = container.querySelectorAll('td')[1];
    fireEvent.keyDown(immutableCell, { key: 'Insert' });
    expect(onArrayAdd).not.toHaveBeenCalled();
  });

  // AC: "Sorted arrays offer none of these, in the menu or from the keyboard" — RecordPanel
  // enforces this by simply never handing down onArrayAdd for a sortable array; DiffRow does no
  // sortedness branching of its own, so the absent-prop case is the whole contract.
  it('a sorted array (no onArrayAdd prop) carries no data-vscode-context and Insert does nothing', () => {
    const { container } = render(<table><tbody>{React.createElement(DiffRow, arrayParentProps({ onArrayAdd: undefined }))}</tbody></table>);
    const mutableCell = container.querySelectorAll('td')[2];
    expect(mutableCell.getAttribute('data-vscode-context')).toBeNull();
    fireEvent.keyDown(mutableCell, { key: 'Insert' }); // must not throw
  });
});

describe('DiffRow — array-element row (Remove/Move Up/Move Down, #227)', () => {
  const elemMeta: FieldMetadata = { name: '', type: 'string', isArray: false, validFormKeyTypes: [], enumValues: [], isSortable: false };

  function arrayElementProps(overrides: Partial<React.ComponentProps<typeof DiffRow>> = {}) {
    const master = override('Fallout4.esm', { fields: [{ metadata: elemMeta, value: 'a' }] });
    const mod = override('MyMod.esp', { fields: [{ metadata: elemMeta, value: 'y' }] });
    const onArrayEdit = vi.fn();
    return baseProps({
      diff: diff({ fieldName: '[1]', values: { 'Fallout4.esm': 'a', 'MyMod.esp': 'y' } }),
      fieldMetaMap: { Items: elemMeta },
      columns: [diskColumn(master), diskColumn(mod)],
      overrideMap: { 'Fallout4.esm': master, 'MyMod.esp': mod },
      context: { kind: 'array-element', overrideMeta: elemMeta, parentFieldName: 'Items' },
      rowKey: 'Items.[1]',
      arrayEdit: { currentArray: plugin => (plugin === 'MyMod.esp' ? ['x', 'y', 'z'] : ['a']), index: 1, onArrayEdit },
      ...overrides,
    });
  }

  it('the mutable column carries the arrayElement data-vscode-context', () => {
    const { container } = render(<table><tbody>{React.createElement(DiffRow, arrayElementProps())}</tbody></table>);
    const mutableCell = container.querySelectorAll('td')[2];
    expect(JSON.parse(mutableCell.getAttribute('data-vscode-context')!)).toEqual({
      webviewSection: 'arrayElement', formKey: '000001:Fallout4.esm', plugin: 'MyMod.esp',
      fieldName: 'Items', index: 1, canMoveUp: true, canMoveDown: true, preventDefaultContextMenuItems: true,
    });
  });

  it('the immutable column carries no data-vscode-context', () => {
    const { container } = render(<table><tbody>{React.createElement(DiffRow, arrayElementProps())}</tbody></table>);
    const immutableCell = container.querySelectorAll('td')[1];
    expect(immutableCell.getAttribute('data-vscode-context')).toBeNull();
  });

  it('Delete on the mutable column restages the whole array with that element dropped', () => {
    const onArrayEdit = vi.fn();
    const { container } = render(<table><tbody>{React.createElement(DiffRow, arrayElementProps({
      arrayEdit: { currentArray: () => ['x', 'y', 'z'], index: 1, onArrayEdit },
    }))}</tbody></table>);
    const mutableCell = container.querySelectorAll('td')[2];
    fireEvent.keyDown(mutableCell, { key: 'Delete' });
    expect(onArrayEdit).toHaveBeenCalledWith('MyMod.esp', ['x', 'z']);
  });

  it('Ctrl+↑ on the mutable column swaps the element up and restages the whole array', () => {
    const onArrayEdit = vi.fn();
    const { container } = render(<table><tbody>{React.createElement(DiffRow, arrayElementProps({
      arrayEdit: { currentArray: () => ['x', 'y', 'z'], index: 1, onArrayEdit },
    }))}</tbody></table>);
    const mutableCell = container.querySelectorAll('td')[2];
    fireEvent.keyDown(mutableCell, { key: 'ArrowUp', ctrlKey: true });
    expect(onArrayEdit).toHaveBeenCalledWith('MyMod.esp', ['y', 'x', 'z']);
  });

  it('Ctrl+↓ on the mutable column swaps the element down and restages the whole array', () => {
    const onArrayEdit = vi.fn();
    const { container } = render(<table><tbody>{React.createElement(DiffRow, arrayElementProps({
      arrayEdit: { currentArray: () => ['x', 'y', 'z'], index: 1, onArrayEdit },
    }))}</tbody></table>);
    const mutableCell = container.querySelectorAll('td')[2];
    fireEvent.keyDown(mutableCell, { key: 'ArrowDown', ctrlKey: true });
    expect(onArrayEdit).toHaveBeenCalledWith('MyMod.esp', ['x', 'z', 'y']);
  });

  it('Ctrl+↑ on the first element does nothing (absent, not disabled)', () => {
    const onArrayEdit = vi.fn();
    const { container } = render(<table><tbody>{React.createElement(DiffRow, arrayElementProps({
      arrayEdit: { currentArray: () => ['x', 'y', 'z'], index: 0, onArrayEdit },
    }))}</tbody></table>);
    const mutableCell = container.querySelectorAll('td')[2];
    fireEvent.keyDown(mutableCell, { key: 'ArrowUp', ctrlKey: true });
    expect(onArrayEdit).not.toHaveBeenCalled();
    // The right-click menu's when-clause gate must agree with the keyboard's no-op above —
    // canMoveUp false is what makes package.json omit the Move Up item at this boundary.
    expect(JSON.parse(mutableCell.getAttribute('data-vscode-context')!).canMoveUp).toBe(false);
  });

  it('Ctrl+↓ on the last element does nothing (absent, not disabled)', () => {
    const onArrayEdit = vi.fn();
    const { container } = render(<table><tbody>{React.createElement(DiffRow, arrayElementProps({
      arrayEdit: { currentArray: () => ['x', 'y', 'z'], index: 2, onArrayEdit },
    }))}</tbody></table>);
    const mutableCell = container.querySelectorAll('td')[2];
    fireEvent.keyDown(mutableCell, { key: 'ArrowDown', ctrlKey: true });
    expect(onArrayEdit).not.toHaveBeenCalled();
    expect(JSON.parse(mutableCell.getAttribute('data-vscode-context')!).canMoveDown).toBe(false);
  });

  it('Delete on the immutable column does nothing', () => {
    const onArrayEdit = vi.fn();
    const { container } = render(<table><tbody>{React.createElement(DiffRow, arrayElementProps({ arrayEdit: { currentArray: () => ['a'], index: 0, onArrayEdit } }))}</tbody></table>);
    const immutableCell = container.querySelectorAll('td')[1];
    fireEvent.keyDown(immutableCell, { key: 'Delete' });
    expect(onArrayEdit).not.toHaveBeenCalled();
  });

  // AC: sorted arrays offer none of these, in the menu or from the keyboard — RecordPanel never
  // hands down arrayEdit for a sortable element; DiffRow's contract is simply "no prop, no op."
  it('a sorted array element (no arrayEdit prop) carries no data-vscode-context and keys do nothing', () => {
    const { container } = render(<table><tbody>{React.createElement(DiffRow, arrayElementProps({ arrayEdit: undefined }))}</tbody></table>);
    const mutableCell = container.querySelectorAll('td')[2];
    expect(mutableCell.getAttribute('data-vscode-context')).toBeNull();
    fireEvent.keyDown(mutableCell, { key: 'Delete' });
    fireEvent.keyDown(mutableCell, { key: 'ArrowUp', ctrlKey: true });
    fireEvent.keyDown(mutableCell, { key: 'ArrowDown', ctrlKey: true }); // must not throw
  });
});
