import '@testing-library/jest-dom';
import React from 'react';
import { render, screen, fireEvent, within, waitFor } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';

import { ConditionSection } from './ConditionSection';
import { defaultCondition } from './conditionOps';
import type { Column } from './recordUtils';
import type { CompareOverride, ConditionCompare, ConditionDiff, ParsedCondition, PendingChange } from './types';
import type { RecordSessionClient } from './RecordSessionClient';

function override(plugin: string): CompareOverride {
  return {
    formKey: `000800:${plugin}`,
    plugin,
    loadOrderIndex: 0,
    isWinner: false,
    editorId: null,
    fields: [],
    conflictThis: 'Master',
  };
}

function condition(partial: Partial<ParsedCondition> = {}): ParsedCondition {
  return {
    function: 'GetStageDone',
    operator: 'EqualTo',
    or: false,
    runOnTarget: 'Subject',
    runOnReference: null,
    useGlobal: false,
    comparisonFloat: 1,
    comparisonGlobal: null,
    parameters: [],
    ...partial,
  };
}

function compare(conditions: ConditionDiff[]): ConditionCompare {
  return { groups: [{ fieldPath: 'Conditions', conditions }] };
}

function multiCompare(groups: Array<{ fieldPath: string; conditions: ConditionDiff[] }>): ConditionCompare {
  return { groups };
}

function fakeClient(overrides: Partial<RecordSessionClient> = {}): RecordSessionClient {
  return {
    searchRecords: vi.fn().mockResolvedValue([{ formKey: '001234:Q.esp', editorId: 'PickedQuest' }]),
    conditionFunctions: vi.fn().mockResolvedValue(['GetIsID', 'GetDistance']),
    ...overrides,
  } as unknown as RecordSessionClient;
}

interface RenderOpts {
  immutableSet?: Set<string>;
  onEdit?: (plugin: string, path: string, value: unknown) => void;
  client?: RecordSessionClient;
  pendingChangeMap?: Record<string, PendingChange>;
  onRevert?: (changeId: string) => void;
}

function renderSection(conditions: ConditionCompare | null, plugins: string[], opts: RenderOpts = {}) {
  const onOpen = vi.fn();
  const cols: Column[] = plugins.map(p => ({ kind: 'disk', override: override(p) }));
  const utils = render(
    <table><tbody>
      <ConditionSection
        conditions={conditions}
        columns={cols}
        onOpen={onOpen}
        immutableSet={opts.immutableSet ?? new Set()}
        onEdit={opts.onEdit}
        client={opts.client}
        pendingChangeMap={opts.pendingChangeMap}
        onRevert={opts.onRevert}
      />
    </tbody></table>,
  );
  return { ...utils, onOpen };
}

function toggleRow(label: string) {
  fireEvent.click(screen.getByText(label).closest('tr')!.querySelector('button')!);
}

describe('ConditionSection', () => {
  it('renders nothing when there are no condition groups', () => {
    const { container } = renderSection(null, ['A.esp']);
    expect(container.querySelector('td')).toBeNull();
  });

  it('renders an xEdit-style summary row per condition, collapsed', () => {
    const c = condition({
      function: 'GetStageDone',
      parameters: [
        { category: 'Form', typeName: 'Quest', formKey: '001234:Q.esp' },
        { category: 'Number', typeName: 'QuestStage', number: 10 },
      ],
      comparisonFloat: 1,
    });
    renderSection(compare([{ index: 0, perPlugin: { 'A.esp': c }, winnerPlugin: 'A.esp', cellStates: {}, fieldCellStates: {} }]), ['A.esp']);

    expect(screen.getByText('Conditions')).toBeInTheDocument();
    expect(screen.getByText('Subject.GetStageDone(001234:Q.esp, 10) = 1 AND')).toBeInTheDocument();
    // collapsed: no field detail rows yet
    expect(screen.queryByText('Function')).toBeNull();
  });

  it('expands a condition to its typed fields; a record parameter renders its FormKey link', () => {
    const c = condition({
      parameters: [{ category: 'Form', typeName: 'Quest', formKey: '001234:Q.esp' }],
    });
    renderSection(
      compare([{ index: 0, perPlugin: { 'A.esp': c }, winnerPlugin: 'A.esp', cellStates: {}, fieldCellStates: {} }]), ['A.esp']);

    toggleRow('#1');

    expect(screen.getByText('Function')).toBeInTheDocument();
    const paramRow = screen.getByText('Parameter 1').closest('tr')!;
    // FormKeyLink renders the FormKey (navigation activates once resolutions are wired, like VMAD).
    expect(within(paramRow).getByText('001234:Q.esp')).toBeInTheDocument();
    expect(within(paramRow).getByText(/\(Quest\)/)).toBeInTheDocument();
  });

  it("renders a use-global condition's comparison as a GLOB FormKey link", () => {
    const c = condition({ useGlobal: true, comparisonFloat: null, comparisonGlobal: '00abcd:G.esp' });
    renderSection(
      compare([{ index: 0, perPlugin: { 'A.esp': c }, winnerPlugin: 'A.esp', cellStates: {}, fieldCellStates: {} }]), ['A.esp']);

    toggleRow('#1');
    const comparisonRow = screen.getByText('Comparison').closest('tr')!;
    expect(within(comparisonRow).getByText('00abcd:G.esp')).toBeInTheDocument();
  });

  it('applies conflict coloring to a contested per-plugin cell', () => {
    const diff: ConditionDiff = {
      index: 0,
      perPlugin: { 'A.esp': condition({ comparisonFloat: 1 }), 'B.esp': condition({ comparisonFloat: 2 }) },
      winnerPlugin: 'B.esp',
      cellStates: { 'B.esp': 'ConflictWins', 'A.esp': 'ConflictLoses' },
      fieldCellStates: {},
    };
    renderSection(compare([diff]), ['A.esp', 'B.esp']);

    const summaryRow = screen.getByText('Subject.GetStageDone = 2 AND').closest('tr')!;
    const cells = summaryRow.querySelectorAll('td');
    // last data cell (B.esp, the winner) is colored, not transparent
    expect(cells[cells.length - 1].style.backgroundColor).not.toBe('');
  });

  it('colors only the expanded field that differs, not every field (two-axis per field)', () => {
    // Same condition except the comparison value; only the Comparison row should be colored.
    const diff: ConditionDiff = {
      index: 0,
      perPlugin: { 'A.esp': condition({ comparisonFloat: 1 }), 'B.esp': condition({ comparisonFloat: 2 }) },
      winnerPlugin: 'B.esp',
      cellStates: { 'B.esp': 'ConflictWins', 'A.esp': 'ConflictLoses' },
      fieldCellStates: {
        comparison: { 'B.esp': 'ConflictWins', 'A.esp': 'ConflictLoses' },
        // function/operator/etc. omitted → identical, no coloring
      },
    };
    renderSection(compare([diff]), ['A.esp', 'B.esp']);
    toggleRow('#1');

    const bgOf = (label: string) => {
      const cells = screen.getByText(label).closest('tr')!.querySelectorAll('td');
      return cells[cells.length - 1].style.backgroundColor;
    };
    expect(bgOf('Comparison')).not.toBe('');
    expect(bgOf('Function')).toBe('');
  });

  // ---- #152: editable fields ----

  it('editing the Operator field stages onEdit with the CTDA wire path', () => {
    const c = condition({ operator: 'EqualTo' });
    const onEdit = vi.fn();
    renderSection(
      compare([{ index: 0, perPlugin: { 'A.esp': c }, winnerPlugin: 'A.esp', cellStates: {}, fieldCellStates: {} }]),
      ['A.esp'],
      { onEdit, client: fakeClient() },
    );
    toggleRow('#1');

    const operatorRow = within(screen.getByText('Operator').closest('tr')!);
    fireEvent.click(operatorRow.getByText('EqualTo'));
    const select = operatorRow.getByDisplayValue('EqualTo');
    fireEvent.change(select, { target: { value: 'GreaterThan' } });
    fireEvent.blur(select);

    expect(onEdit).toHaveBeenCalledWith('A.esp', 'CTDA\\Conditions\\0\\Operator', 'GreaterThan');
  });

  it('editing a Number-typed parameter stages onEdit at the Parameter\\<n> path', () => {
    const c = condition({
      function: 'GetStageDone',
      parameters: [
        { category: 'Form', typeName: 'Quest', formKey: '001234:Q.esp' },
        { category: 'Number', typeName: 'QuestStage', number: 10 },
      ],
    });
    const onEdit = vi.fn();
    renderSection(
      compare([{ index: 0, perPlugin: { 'A.esp': c }, winnerPlugin: 'A.esp', cellStates: {}, fieldCellStates: {} }]),
      ['A.esp'],
      { onEdit, client: fakeClient() },
    );
    toggleRow('#1');

    const paramRow = within(screen.getByText('Parameter 2').closest('tr')!);
    fireEvent.click(paramRow.getByText('10'));
    const numberInput = paramRow.getByDisplayValue('10');
    fireEvent.change(numberInput, { target: { value: '42' } });
    fireEvent.blur(numberInput);

    expect(onEdit).toHaveBeenCalledWith('A.esp', 'CTDA\\Conditions\\0\\Parameter\\1', 42);
  });

  it('toggling Use Global switches the Comparison input from number to a GLOB FormKey picker', () => {
    const c = condition({ useGlobal: false, comparisonFloat: 3 });
    const onEdit = vi.fn();
    renderSection(
      compare([{ index: 0, perPlugin: { 'A.esp': c }, winnerPlugin: 'A.esp', cellStates: {}, fieldCellStates: {} }]),
      ['A.esp'],
      { onEdit, client: fakeClient() },
    );
    toggleRow('#1');

    // Comparison starts as plain number text (not useGlobal).
    expect(within(screen.getByText('Comparison').closest('tr')!).getByText('3')).toBeInTheDocument();

    const useGlobalRow = within(screen.getByText('Use Global').closest('tr')!);
    fireEvent.click(useGlobalRow.getByText('false'));
    fireEvent.click(useGlobalRow.getByRole('checkbox'));

    expect(onEdit).toHaveBeenCalledWith('A.esp', 'CTDA\\Conditions\\0\\UseGlobal', true);
  });

  it("renders a use-global condition's Comparison field as a FormKey-pickable button, not a number input", () => {
    const c = condition({ useGlobal: true, comparisonFloat: null, comparisonGlobal: '00abcd:G.esp' });
    renderSection(
      compare([{ index: 0, perPlugin: { 'A.esp': c }, winnerPlugin: 'A.esp', cellStates: {}, fieldCellStates: {} }]),
      ['A.esp'],
      { onEdit: vi.fn(), client: fakeClient() },
    );
    toggleRow('#1');

    const comparisonRow = screen.getByText('Comparison').closest('tr')!;
    expect(within(comparisonRow).getByText('00abcd:G.esp')).toBeInTheDocument();
    expect(within(comparisonRow).queryByRole('spinbutton')).toBeNull();
  });

  it('selecting a new function via the function picker stages onEdit with the function name', async () => {
    const c = condition({ function: 'GetIsID' });
    const onEdit = vi.fn();
    renderSection(
      compare([{ index: 0, perPlugin: { 'A.esp': c }, winnerPlugin: 'A.esp', cellStates: {}, fieldCellStates: {} }]),
      ['A.esp'],
      { onEdit, client: fakeClient() },
    );
    toggleRow('#1');

    fireEvent.click(within(screen.getByText('Function').closest('tr')!).getByText('GetIsID'));
    const input = await screen.findByPlaceholderText('Search function…');
    fireEvent.change(input, { target: { value: 'Distance' } });
    await waitFor(() => expect(screen.getByText('GetDistance')).toBeInTheDocument());
    fireEvent.mouseDown(screen.getByText('GetDistance'));

    expect(onEdit).toHaveBeenCalledWith('A.esp', 'CTDA\\Conditions\\0\\Function', 'GetDistance');
  });

  it("a function change's refetched ParsedCondition reshapes the parameter input's type", () => {
    // Before: GetStageDone's first slot is Form-typed (Quest) -> FormKeyCell (a button).
    const before = condition({
      function: 'GetStageDone',
      parameters: [{ category: 'Form', typeName: 'Quest', formKey: '001234:Q.esp' }],
    });
    const { rerender, onOpen } = renderSection(
      compare([{ index: 0, perPlugin: { 'A.esp': before }, winnerPlugin: 'A.esp', cellStates: {}, fieldCellStates: {} }]),
      ['A.esp'],
      { onEdit: vi.fn(), client: fakeClient() },
    );
    toggleRow('#1');
    expect(within(screen.getByText('Parameter 1').closest('tr')!).getByText('001234:Q.esp')).toBeInTheDocument();

    // After a Function edit round-trips: GetGraphVariableFloat's first slot is String-typed ->
    // ScalarCell (a text input), never a stale FormKey button left over from the old shape.
    const after = condition({
      function: 'GetGraphVariableFloat',
      parameters: [{ category: 'Text', typeName: 'String', text: 'bLeftHandedMode' }],
    });
    const cols: Column[] = [{ kind: 'disk', override: override('A.esp') }];
    rerender(
      <table><tbody>
        <ConditionSection
          conditions={compare([{ index: 0, perPlugin: { 'A.esp': after }, winnerPlugin: 'A.esp', cellStates: {}, fieldCellStates: {} }])}
          columns={cols}
          onOpen={onOpen}
          immutableSet={new Set()}
          onEdit={vi.fn()}
          client={fakeClient()}
        />
      </tbody></table>,
    );

    const paramRow = within(screen.getByText('Parameter 1').closest('tr')!);
    expect(paramRow.queryByText('001234:Q.esp')).toBeNull();
    fireEvent.click(paramRow.getByText('bLeftHandedMode'));
    expect(paramRow.getByDisplayValue('bLeftHandedMode')).toBeInTheDocument();
  });

  it('editing a Text-typed (String) parameter stages onEdit at the Parameter\\<n> path', () => {
    const c = condition({
      function: 'GetGraphVariableFloat',
      parameters: [{ category: 'Text', typeName: 'String', text: 'bLeftHandedMode' }],
    });
    const onEdit = vi.fn();
    renderSection(
      compare([{ index: 0, perPlugin: { 'A.esp': c }, winnerPlugin: 'A.esp', cellStates: {}, fieldCellStates: {} }]),
      ['A.esp'],
      { onEdit, client: fakeClient() },
    );
    toggleRow('#1');

    const paramRow = within(screen.getByText('Parameter 1').closest('tr')!);
    fireEvent.click(paramRow.getByText('bLeftHandedMode'));
    const textInput = paramRow.getByDisplayValue('bLeftHandedMode');
    fireEvent.change(textInput, { target: { value: 'bRightHandedMode' } });
    fireEvent.blur(textInput);

    expect(onEdit).toHaveBeenCalledWith('A.esp', 'CTDA\\Conditions\\0\\Parameter\\0', 'bRightHandedMode');
  });

  it("renders no inputs in an immutable plugin's column", () => {
    const c = condition({ operator: 'EqualTo' });
    renderSection(
      compare([{ index: 0, perPlugin: { 'A.esp': c }, winnerPlugin: 'A.esp', cellStates: {}, fieldCellStates: {} }]),
      ['A.esp'],
      { onEdit: vi.fn(), client: fakeClient(), immutableSet: new Set(['A.esp']) },
    );
    toggleRow('#1');

    const operatorRow = screen.getByText('Operator').closest('tr')!;
    expect(within(operatorRow).queryByRole('combobox')).toBeNull();
    // Falls back to the read-only symbol rendering.
    expect(within(operatorRow).getByText('=')).toBeInTheDocument();
  });

  it('without onEdit/client, fields render read-only (no inputs) regardless of immutableSet', () => {
    const c = condition({ operator: 'EqualTo' });
    renderSection(
      compare([{ index: 0, perPlugin: { 'A.esp': c }, winnerPlugin: 'A.esp', cellStates: {}, fieldCellStates: {} }]),
      ['A.esp'],
    );
    toggleRow('#1');

    const operatorRow = screen.getByText('Operator').closest('tr')!;
    expect(within(operatorRow).queryByRole('combobox')).toBeNull();
    expect(within(operatorRow).getByText('=')).toBeInTheDocument();
  });

  it('a pending condition field edit renders in the pending column with a revert control', () => {
    const c = condition({ operator: 'EqualTo' });
    const pendingChange: PendingChange = {
      id: 'chg-1',
      formKey: '000800:A.esp',
      plugin: 'A.esp',
      fieldPath: 'CTDA\\Conditions\\0\\Operator',
      recordType: 'cobj',
      oldValue: 'EqualTo',
      newValue: 'GreaterThan',
      source: 'user',
      description: null,
      timestamp: '2026-01-01T00:00:00Z',
      changeType: 'field_edit',
      groupId: null,
    } as unknown as PendingChange;
    const onRevert = vi.fn();

    const onOpen = vi.fn();
    const cols: Column[] = [{ kind: 'disk', override: override('A.esp') }, { kind: 'pending', plugin: 'A.esp' }];
    render(
      <table><tbody>
        <ConditionSection
          conditions={compare([{ index: 0, perPlugin: { 'A.esp': c }, winnerPlugin: 'A.esp', cellStates: {}, fieldCellStates: {} }])}
          columns={cols}
          onOpen={onOpen}
          immutableSet={new Set()}
          onEdit={vi.fn()}
          client={fakeClient()}
          pendingChangeMap={{ 'A.esp:CTDA\\Conditions\\0\\Operator': pendingChange }}
          onRevert={onRevert}
        />
      </tbody></table>,
    );
    toggleRow('#1');

    const operatorRow = screen.getByText('Operator').closest('tr')!;
    expect(within(operatorRow).getByTitle('Revert group')).toBeInTheDocument();
    fireEvent.click(within(operatorRow).getByTitle('Revert group'));
    expect(onRevert).toHaveBeenCalledWith('chg-1');
    // Issue #203: this Operator pending cell is now click-to-edit, and ↩ sits inside it —
    // clicking ↩ must revert without also activating the select editor (stopPropagation).
    expect(within(operatorRow).queryByRole('combobox')).toBeNull();
  });

  // ── Issue #203: pending condition fields are directly editable ──────────────────
  //
  // Same terms as the disk cell: a Condition field's editor (ScalarCell/FormKeyCell, via
  // field.renderEdit) is itself click-to-activate — fieldCell only decides *whether* to hand the
  // pending cell that editor at all, gated on the column's mutability, exactly like the disk cell.

  function condChange(fieldPath: string, newValue: unknown, id = 'chg-1'): PendingChange {
    return {
      id, formKey: '000800:A.esp', plugin: 'A.esp', fieldPath, recordType: 'cobj',
      oldValue: null, newValue, source: 'user', description: null,
      timestamp: '2026-01-01T00:00:00Z', changeType: 'field_edit', groupId: null,
    } as unknown as PendingChange;
  }

  it('clicking a pending condition field activates its own editable widget, seeded with the staged value', () => {
    const c = condition({ operator: 'EqualTo' });
    const cols: Column[] = [{ kind: 'disk', override: override('A.esp') }, { kind: 'pending', plugin: 'A.esp' }];
    render(
      <table><tbody>
        <ConditionSection
          conditions={compare([{ index: 0, perPlugin: { 'A.esp': c }, winnerPlugin: 'A.esp', cellStates: {}, fieldCellStates: {} }])}
          columns={cols}
          onOpen={vi.fn()}
          immutableSet={new Set()}
          onEdit={vi.fn()}
          client={fakeClient()}
          pendingChangeMap={{ 'A.esp:CTDA\\Conditions\\0\\Operator': condChange('CTDA\\Conditions\\0\\Operator', 'GreaterThan') }}
        />
      </tbody></table>,
    );
    toggleRow('#1');

    const operatorRow = screen.getByText('Operator').closest('tr')!;
    // Read state before any click: disk shows its own value, pending shows the staged one —
    // neither is an input yet (matches the disk cell's own click-to-activate rule).
    expect(within(operatorRow).getByText('EqualTo')).toBeInTheDocument();
    expect(within(operatorRow).getByText('GreaterThan')).toBeInTheDocument();
    expect(within(operatorRow).queryByRole('combobox')).toBeNull();

    fireEvent.click(within(operatorRow).getByText('GreaterThan'));

    const select = within(operatorRow).getByRole('combobox');
    expect((select as HTMLSelectElement).value).toBe('GreaterThan');
  });

  it('committing an edit on a pending condition field calls onEdit with the wire path and new value', () => {
    const c = condition({ operator: 'EqualTo' });
    const onEdit = vi.fn();
    const cols: Column[] = [{ kind: 'disk', override: override('A.esp') }, { kind: 'pending', plugin: 'A.esp' }];
    render(
      <table><tbody>
        <ConditionSection
          conditions={compare([{ index: 0, perPlugin: { 'A.esp': c }, winnerPlugin: 'A.esp', cellStates: {}, fieldCellStates: {} }])}
          columns={cols}
          onOpen={vi.fn()}
          immutableSet={new Set()}
          onEdit={onEdit}
          client={fakeClient()}
          pendingChangeMap={{ 'A.esp:CTDA\\Conditions\\0\\Operator': condChange('CTDA\\Conditions\\0\\Operator', 'GreaterThan') }}
        />
      </tbody></table>,
    );
    toggleRow('#1');

    const operatorRow = screen.getByText('Operator').closest('tr')!;
    fireEvent.click(within(operatorRow).getByText('GreaterThan'));
    const select = within(operatorRow).getByRole('combobox');
    fireEvent.change(select, { target: { value: 'LessThan' } });
    fireEvent.blur(select);

    expect(onEdit).toHaveBeenCalledWith('A.esp', 'CTDA\\Conditions\\0\\Operator', 'LessThan');
  });

  // Required check (not a stylistic nicety): a field's renderEdit can read a *sibling* field to
  // pick its widget — Comparison branches on UseGlobal. If the pending cell overlaid only the
  // field it renders, staging both UseGlobal and Comparison at once would render Comparison's
  // editor against the STALE disk UseGlobal (still false), so the pending cell would show the
  // stale disk float (5) instead of the staged GLOB FormKey.
  it('overlays every staged field on the condition, not just the one being rendered — a pending Comparison cell reflects a staged UseGlobal', () => {
    const c = condition({ useGlobal: false, comparisonFloat: 5, comparisonGlobal: null });
    const cols: Column[] = [{ kind: 'disk', override: override('A.esp') }, { kind: 'pending', plugin: 'A.esp' }];
    render(
      <table><tbody>
        <ConditionSection
          conditions={compare([{ index: 0, perPlugin: { 'A.esp': c }, winnerPlugin: 'A.esp', cellStates: {}, fieldCellStates: {} }])}
          columns={cols}
          onOpen={vi.fn()}
          immutableSet={new Set()}
          onEdit={vi.fn()}
          client={fakeClient()}
          pendingChangeMap={{
            'A.esp:CTDA\\Conditions\\0\\UseGlobal': condChange('CTDA\\Conditions\\0\\UseGlobal', true, 'chg-ug'),
            'A.esp:CTDA\\Conditions\\0\\Comparison': condChange('CTDA\\Conditions\\0\\Comparison', '00abcd:G.esp', 'chg-cmp'),
          }}
        />
      </tbody></table>,
    );
    toggleRow('#1');

    const comparisonRow = screen.getByText('Comparison').closest('tr')!;
    const pendingCell = comparisonRow.querySelectorAll('td')[2]; // field label, disk, pending
    // A FormKeyCell/FormKeyLink renders as a <button> (the "read state" IS the link, no separate
    // activation step) — a stale (non-overlaid) UseGlobal would instead pick ScalarCell(float),
    // whose read state is a plain, non-button span showing the disk value "5". Checking the tag,
    // not just the text, is what actually falsifies the single-field-overlay bug: a bespoke
    // read-only text renderer could otherwise show the right string via either path.
    const glob = within(pendingCell).getByText('00abcd:G.esp');
    expect(glob.tagName).toBe('BUTTON');
    expect(within(pendingCell).queryByText('5')).toBeNull();
  });

  it('right-clicking a pending condition field requests the pending context menu', () => {
    const c = condition({ operator: 'EqualTo' });
    const onPendingContextMenu = vi.fn();
    const cols: Column[] = [{ kind: 'disk', override: override('A.esp') }, { kind: 'pending', plugin: 'A.esp' }];
    render(
      <table><tbody>
        <ConditionSection
          conditions={compare([{ index: 0, perPlugin: { 'A.esp': c }, winnerPlugin: 'A.esp', cellStates: {}, fieldCellStates: {} }])}
          columns={cols}
          onOpen={vi.fn()}
          immutableSet={new Set()}
          onEdit={vi.fn()}
          client={fakeClient()}
          pendingChangeMap={{ 'A.esp:CTDA\\Conditions\\0\\Operator': condChange('CTDA\\Conditions\\0\\Operator', 'GreaterThan') }}
          onPendingContextMenu={onPendingContextMenu}
        />
      </tbody></table>,
    );
    toggleRow('#1');

    const operatorRow = screen.getByText('Operator').closest('tr')!;
    const pendingCell = operatorRow.querySelectorAll('td')[2];
    fireEvent.contextMenu(pendingCell);

    expect(onPendingContextMenu).toHaveBeenCalledWith('chg-1', expect.any(Number), expect.any(Number));
  });

  // ---- #153: add/remove/reorder controls ----

  it('renders an add-condition control per editable plugin column; clicking stages the grown list', () => {
    const c = condition({ operator: 'EqualTo' });
    const onEdit = vi.fn();
    renderSection(
      compare([{ index: 0, perPlugin: { 'A.esp': c }, winnerPlugin: 'A.esp', cellStates: {}, fieldCellStates: {} }]),
      ['A.esp'],
      { onEdit },
    );

    fireEvent.click(screen.getByTitle('Add condition'));

    expect(onEdit).toHaveBeenCalledWith('A.esp', 'Conditions', [c, defaultCondition()]);
  });

  it('does not render an add-condition control on an immutable plugin column', () => {
    renderSection(
      compare([{ index: 0, perPlugin: { 'A.esp': condition() }, winnerPlugin: 'A.esp', cellStates: {}, fieldCellStates: {} }]),
      ['A.esp'],
      { onEdit: vi.fn(), immutableSet: new Set(['A.esp']) },
    );

    expect(screen.queryByTitle('Add condition')).toBeNull();
  });

  it('clicking Remove on a condition stages the list with that condition removed', () => {
    const c0 = condition({ operator: 'EqualTo' });
    const c1 = condition({ operator: 'NotEqualTo' });
    const onEdit = vi.fn();
    renderSection(
      compare([
        { index: 0, perPlugin: { 'A.esp': c0 }, winnerPlugin: 'A.esp', cellStates: {}, fieldCellStates: {} },
        { index: 1, perPlugin: { 'A.esp': c1 }, winnerPlugin: 'A.esp', cellStates: {}, fieldCellStates: {} },
      ]),
      ['A.esp'],
      { onEdit },
    );

    const row = screen.getByText('#1').closest('tr')!;
    fireEvent.click(within(row).getByTitle('Remove condition'));

    expect(onEdit).toHaveBeenCalledWith('A.esp', 'Conditions', [c1]);
  });

  it('clicking Move down swaps the condition with the next one', () => {
    const c0 = condition({ operator: 'EqualTo' });
    const c1 = condition({ operator: 'NotEqualTo' });
    const onEdit = vi.fn();
    renderSection(
      compare([
        { index: 0, perPlugin: { 'A.esp': c0 }, winnerPlugin: 'A.esp', cellStates: {}, fieldCellStates: {} },
        { index: 1, perPlugin: { 'A.esp': c1 }, winnerPlugin: 'A.esp', cellStates: {}, fieldCellStates: {} },
      ]),
      ['A.esp'],
      { onEdit },
    );

    const row = screen.getByText('#1').closest('tr')!;
    fireEvent.click(within(row).getByTitle('Move condition down'));

    expect(onEdit).toHaveBeenCalledWith('A.esp', 'Conditions', [c1, c0]);
  });

  it('does not render move/remove controls on an immutable plugin column', () => {
    renderSection(
      compare([{ index: 0, perPlugin: { 'A.esp': condition() }, winnerPlugin: 'A.esp', cellStates: {}, fieldCellStates: {} }]),
      ['A.esp'],
      { onEdit: vi.fn(), immutableSet: new Set(['A.esp']) },
    );

    const row = screen.getByText('#1').closest('tr')!;
    expect(within(row).queryByTitle('Remove condition')).toBeNull();
    expect(within(row).queryByTitle('Move condition up')).toBeNull();
    expect(within(row).queryByTitle('Move condition down')).toBeNull();
  });

  // ---- #154: multiple condition-carrying fields on one record ----

  it('renders a separately labeled section per condition-owning field, not one shared "Conditions" header', () => {
    const dialog = condition({ function: 'GetIsID' });
    const unused = condition({ function: 'GetDead' });
    renderSection(
      multiCompare([
        { fieldPath: 'DialogConditions', conditions: [{ index: 0, perPlugin: { 'A.esp': dialog }, winnerPlugin: 'A.esp', cellStates: {}, fieldCellStates: {} }] },
        { fieldPath: 'UnusedConditions', conditions: [{ index: 0, perPlugin: { 'A.esp': unused }, winnerPlugin: 'A.esp', cellStates: {}, fieldCellStates: {} }] },
      ]),
      ['A.esp'],
    );

    expect(screen.getByText('DialogConditions')).toBeInTheDocument();
    expect(screen.getByText('UnusedConditions')).toBeInTheDocument();
    // No shared generic header when there's more than one owning field.
    expect(screen.queryByText('Conditions')).toBeNull();
  });

  it('editing/adding/removing in one condition-owning field never touches a sibling field on the same record', () => {
    const dialog = condition({ function: 'GetIsID', operator: 'EqualTo' });
    const unused = condition({ function: 'GetDead', operator: 'NotEqualTo' });
    const onEdit = vi.fn();
    renderSection(
      multiCompare([
        { fieldPath: 'DialogConditions', conditions: [{ index: 0, perPlugin: { 'A.esp': dialog }, winnerPlugin: 'A.esp', cellStates: {}, fieldCellStates: {} }] },
        { fieldPath: 'UnusedConditions', conditions: [{ index: 0, perPlugin: { 'A.esp': unused }, winnerPlugin: 'A.esp', cellStates: {}, fieldCellStates: {} }] },
      ]),
      ['A.esp'],
      { onEdit },
    );

    // Two independent "add" controls, one per field — clicking DialogConditions's must restage
    // only DialogConditions's list, never touching UnusedConditions's.
    const addButtons = screen.getAllByTitle('Add condition');
    expect(addButtons).toHaveLength(2);
    fireEvent.click(addButtons[0]);

    expect(onEdit).toHaveBeenCalledWith('A.esp', 'DialogConditions', [dialog, defaultCondition()]);
    expect(onEdit).not.toHaveBeenCalledWith('A.esp', 'UnusedConditions', expect.anything());
  });

  // ---- #181: nested (per-array-item) condition groups ----

  it('renders a nested group (indexed field path) collapsed by default: header shows, rows do not', () => {
    const c = condition({ function: 'GetIsID' });
    renderSection(
      multiCompare([
        { fieldPath: 'Effects[0].Conditions', conditions: [{ index: 0, perPlugin: { 'A.esp': c }, winnerPlugin: 'A.esp', cellStates: {}, fieldCellStates: {} }] },
      ]),
      ['A.esp'],
    );

    expect(screen.getByText('Effects[0].Conditions')).toBeInTheDocument();
    expect(screen.queryByText('Subject.GetIsID = 1 AND')).toBeNull();
    expect(screen.queryByText('#1')).toBeNull();
  });

  it('clicking a collapsed nested group header reveals its condition rows', () => {
    const c = condition({ function: 'GetIsID' });
    renderSection(
      multiCompare([
        { fieldPath: 'Effects[0].Conditions', conditions: [{ index: 0, perPlugin: { 'A.esp': c }, winnerPlugin: 'A.esp', cellStates: {}, fieldCellStates: {} }] },
      ]),
      ['A.esp'],
    );

    fireEvent.click(screen.getByText('Effects[0].Conditions').closest('tr')!.querySelector('button')!);

    expect(screen.getByText('Subject.GetIsID = 1 AND')).toBeInTheDocument();
  });

  // #184 confirmation, not a production change: a two-level composed field path
  // ("Effects[0].Conditions[0].Conditions", e.g. a Perk effect's own doubly-indexed conditions)
  // still just contains '[', so isNestedGroupPath/the render loop treat it exactly like a one-level
  // nested group — collapsed by default, expandable the same way — with no depth-specific branch.
  it('renders a two-level nested group (doubly-indexed field path) collapsed by default, expandable the same way', () => {
    const c = condition({ function: 'GetIsID' });
    renderSection(
      multiCompare([
        {
          fieldPath: 'Effects[0].Conditions[0].Conditions',
          conditions: [{ index: 0, perPlugin: { 'A.esp': c }, winnerPlugin: 'A.esp', cellStates: {}, fieldCellStates: {} }],
        },
      ]),
      ['A.esp'],
    );

    expect(screen.getByText('Effects[0].Conditions[0].Conditions')).toBeInTheDocument();
    expect(screen.queryByText('Subject.GetIsID = 1 AND')).toBeNull();

    fireEvent.click(screen.getByText('Effects[0].Conditions[0].Conditions').closest('tr')!.querySelector('button')!);

    expect(screen.getByText('Subject.GetIsID = 1 AND')).toBeInTheDocument();
  });

  // #182: scalar sub-field editing at a nested (indexed) path is live — the reverse of #181's
  // display-only rendering. #183 extends the same group to structural ops (add/move/remove),
  // which stage the whole nested list at its own composed field path — the nested analogue of
  // #153's flat add/remove/reorder controls.
  it('renders scalar field edit controls for a nested group, and structural (add/move/remove) controls', () => {
    const c = condition({ function: 'GetIsID', operator: 'EqualTo' });
    const onEdit = vi.fn();
    renderSection(
      multiCompare([
        { fieldPath: 'Effects[0].Conditions', conditions: [{ index: 0, perPlugin: { 'A.esp': c }, winnerPlugin: 'A.esp', cellStates: {}, fieldCellStates: {} }] },
      ]),
      ['A.esp'],
      { onEdit, client: fakeClient() },
    );

    // Expand the nested group, then expand the condition row to its field details.
    fireEvent.click(screen.getByText('Effects[0].Conditions').closest('tr')!.querySelector('button')!);
    toggleRow('#1');

    // #183: structural controls now render for a nested group too.
    expect(screen.getByTitle('Add condition')).toBeInTheDocument();
    fireEvent.click(screen.getByTitle('Remove condition'));
    expect(onEdit).toHaveBeenCalledWith('A.esp', 'Effects[0].Conditions', []);

    // But the Operator field is also a live editor, and committing it stages onEdit with the
    // composed indexed wire path — the same CTDA\<FieldPath>\<Index>\<SubField> shape a flat
    // group uses, just with the enclosing array's index folded into the FieldPath segment.
    const operatorRow = within(screen.getByText('Operator').closest('tr')!);
    fireEvent.click(operatorRow.getByText('EqualTo'));
    const select = operatorRow.getByDisplayValue('EqualTo');
    fireEvent.change(select, { target: { value: 'GreaterThan' } });
    fireEvent.blur(select);

    expect(onEdit).toHaveBeenCalledWith('A.esp', 'CTDA\\Effects[0].Conditions\\0\\Operator', 'GreaterThan');
  });

  // #183: the add-condition row also renders for a nested group now (previously gated off
  // unconditionally — #181's "no add-condition control for a nested group").
  it('renders an add-condition control for a nested group; clicking stages the grown list at the composed path', () => {
    const c = condition({ operator: 'EqualTo' });
    const onEdit = vi.fn();
    renderSection(
      multiCompare([
        { fieldPath: 'Effects[0].Conditions', conditions: [{ index: 0, perPlugin: { 'A.esp': c }, winnerPlugin: 'A.esp', cellStates: {}, fieldCellStates: {} }] },
      ]),
      ['A.esp'],
      { onEdit },
    );

    fireEvent.click(screen.getByText('Effects[0].Conditions').closest('tr')!.querySelector('button')!);
    fireEvent.click(screen.getByTitle('Add condition'));

    expect(onEdit).toHaveBeenCalledWith('A.esp', 'Effects[0].Conditions', [c, defaultCondition()]);
  });

  // #183: same immutable-column gate every other structural/scalar edit control already respects.
  it('does not render structural (add/move/remove) controls for a nested group on an immutable plugin column', () => {
    renderSection(
      multiCompare([
        { fieldPath: 'Effects[0].Conditions', conditions: [{ index: 0, perPlugin: { 'A.esp': condition() }, winnerPlugin: 'A.esp', cellStates: {}, fieldCellStates: {} }] },
      ]),
      ['A.esp'],
      { onEdit: vi.fn(), immutableSet: new Set(['A.esp']) },
    );

    fireEvent.click(screen.getByText('Effects[0].Conditions').closest('tr')!.querySelector('button')!);

    expect(screen.queryByTitle('Add condition')).toBeNull();
    expect(screen.queryByTitle('Move condition up')).toBeNull();
    expect(screen.queryByTitle('Move condition down')).toBeNull();
    expect(screen.queryByTitle('Remove condition')).toBeNull();
  });

  // #183 AC3 (frontend side): two nested groups sharing the same enclosing array (Effects[0] and
  // Effects[1]) must stage independently — an add/remove/move on one's group must never restage
  // the other's, since each group's own field path already carries its own index.
  it('add/remove/move on one nested group never restages a sibling nested group on the same enclosing array', () => {
    const c0 = condition({ function: 'GetIsID' });
    const c1 = condition({ function: 'GetDead' });
    const onEdit = vi.fn();
    renderSection(
      multiCompare([
        { fieldPath: 'Effects[0].Conditions', conditions: [{ index: 0, perPlugin: { 'A.esp': c0 }, winnerPlugin: 'A.esp', cellStates: {}, fieldCellStates: {} }] },
        { fieldPath: 'Effects[1].Conditions', conditions: [{ index: 0, perPlugin: { 'A.esp': c1 }, winnerPlugin: 'A.esp', cellStates: {}, fieldCellStates: {} }] },
      ]),
      ['A.esp'],
      { onEdit },
    );

    fireEvent.click(screen.getByText('Effects[0].Conditions').closest('tr')!.querySelector('button')!);
    fireEvent.click(screen.getByText('Effects[1].Conditions').closest('tr')!.querySelector('button')!);

    const addButtons = screen.getAllByTitle('Add condition');
    expect(addButtons).toHaveLength(2);
    fireEvent.click(addButtons[0]);

    expect(onEdit).toHaveBeenCalledWith('A.esp', 'Effects[0].Conditions', [c0, defaultCondition()]);
    expect(onEdit).not.toHaveBeenCalledWith('A.esp', 'Effects[1].Conditions', expect.anything());
  });

  it('a flat top-level group (unindexed field path) still renders its condition rows open by default, unaffected by group collapse', () => {
    const c = condition({ function: 'GetIsID' });
    renderSection(
      multiCompare([
        { fieldPath: 'Conditions', conditions: [{ index: 0, perPlugin: { 'A.esp': c }, winnerPlugin: 'A.esp', cellStates: {}, fieldCellStates: {} }] },
      ]),
      ['A.esp'],
    );

    expect(screen.getByText('Subject.GetIsID = 1 AND')).toBeInTheDocument();
    // No group-level collapse affordance on a flat group's header.
    expect(screen.getByText('Conditions').closest('tr')!.querySelector('button')).toBeNull();
  });

  it('without onEdit, no add/remove/move controls render', () => {
    renderSection(
      compare([{ index: 0, perPlugin: { 'A.esp': condition() }, winnerPlugin: 'A.esp', cellStates: {}, fieldCellStates: {} }]),
      ['A.esp'],
    );

    expect(screen.queryByTitle('Add condition')).toBeNull();
    const row = screen.getByText('#1').closest('tr')!;
    expect(within(row).queryByTitle('Remove condition')).toBeNull();
  });
});
