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
    expect(within(operatorRow).getByText('GreaterThan')).toBeInTheDocument();
    fireEvent.click(within(operatorRow).getByTitle('Revert group'));
    expect(onRevert).toHaveBeenCalledWith('chg-1');
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
