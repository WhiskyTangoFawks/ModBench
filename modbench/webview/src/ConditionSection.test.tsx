import '@testing-library/jest-dom';
import React from 'react';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';

import { ConditionSection } from './ConditionSection';
import type { Column } from './recordUtils';
import type { CompareOverride, ConditionCompare, ConditionDiff, ParsedCondition } from './types';

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

function renderSection(conditions: ConditionCompare | null, plugins: string[]) {
  const onOpen = vi.fn();
  const cols: Column[] = plugins.map(p => ({ kind: 'disk', override: override(p) }));
  const utils = render(
    <table><tbody>
      <ConditionSection conditions={conditions} columns={cols} onOpen={onOpen} />
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
});
