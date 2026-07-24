import { describe, it, expect } from 'vitest';
import { applyConditionListOp, currentConditionList, defaultCondition } from './conditionOps';
import type { ConditionDiff, ParsedCondition, PendingChange } from './types';

function condition(overrides: Partial<ParsedCondition> = {}): ParsedCondition {
  return {
    function: 'GetIsID',
    operator: 'EqualTo',
    or: false,
    runOnTarget: 'Subject',
    runOnReference: null,
    useGlobal: false,
    comparisonFloat: 1,
    comparisonGlobal: null,
    parameters: [],
    ...overrides,
  };
}

function diff(index: number, perPlugin: Record<string, ParsedCondition | null>): ConditionDiff {
  return {
    index,
    perPlugin,
    winnerPlugin: Object.keys(perPlugin)[0],
    cellStates: {},
    fieldCellStates: {},
  };
}

function change(fieldPath: string, newValue: unknown): PendingChange {
  return {
    id: 'x', formKey: '000000:A.esm', plugin: 'A.esm', fieldPath, recordType: 'cobj',
    oldValue: null, newValue, source: 'user', description: null, changedAt: '',
  };
}

describe('defaultCondition', () => {
  it('produces a sensible zero-parameter default', () => {
    const d = defaultCondition();
    expect(d.function).toBeTruthy();
    expect(d.operator).toBe('EqualTo');
    expect(d.comparisonFloat).toBe(0);
    expect(d.parameters).toEqual([]);
  });
});

describe('applyConditionListOp', () => {
  it('add_condition appends a default condition', () => {
    const list = [condition()];
    const next = applyConditionListOp(list, { op: 'add_condition' });
    expect(next).toHaveLength(2);
    expect(next[1]).toEqual(defaultCondition());
    // original untouched
    expect(list).toHaveLength(1);
  });

  it('remove_condition removes the condition at index', () => {
    const list = [condition({ operator: 'EqualTo' }), condition({ operator: 'NotEqualTo' })];
    const next = applyConditionListOp(list, { op: 'remove_condition', index: 0 });
    expect(next).toHaveLength(1);
    expect(next[0].operator).toBe('NotEqualTo');
  });

  it('remove_condition out of range is a no-op', () => {
    const list = [condition()];
    const next = applyConditionListOp(list, { op: 'remove_condition', index: 5 });
    expect(next).toEqual(list);
  });

  it('move_condition down swaps with the next element', () => {
    const list = [condition({ operator: 'EqualTo' }), condition({ operator: 'NotEqualTo' })];
    const next = applyConditionListOp(list, { op: 'move_condition', index: 0, direction: 'down' });
    expect(next.map(c => c.operator)).toEqual(['NotEqualTo', 'EqualTo']);
  });

  it('move_condition up swaps with the previous element', () => {
    const list = [condition({ operator: 'EqualTo' }), condition({ operator: 'NotEqualTo' })];
    const next = applyConditionListOp(list, { op: 'move_condition', index: 1, direction: 'up' });
    expect(next.map(c => c.operator)).toEqual(['NotEqualTo', 'EqualTo']);
  });

  it('move_condition at the boundary is a no-op', () => {
    const list = [condition({ operator: 'EqualTo' }), condition({ operator: 'NotEqualTo' })];
    const next = applyConditionListOp(list, { op: 'move_condition', index: 0, direction: 'up' });
    expect(next).toEqual(list);
  });
});

describe('currentConditionList', () => {
  it('returns the plugin\'s committed conditions in index order, skipping rows it lacks', () => {
    const conditions = [
      diff(0, { 'A.esm': condition({ operator: 'EqualTo' }) }),
      diff(1, { 'A.esm': null }),
      diff(2, { 'A.esm': condition({ operator: 'NotEqualTo' }) }),
    ];
    const list = currentConditionList(conditions, 'Conditions', 'A.esm');
    expect(list.map(c => c.operator)).toEqual(['EqualTo', 'NotEqualTo']);
  });

  it('overlays an outstanding per-field pending edit onto the matching condition', () => {
    const conditions = [diff(0, { 'A.esm': condition({ operator: 'EqualTo' }) })];
    const pendingChangeMap = {
      'A.esm:CTDA\\Conditions\\0\\Operator': change('CTDA\\Conditions\\0\\Operator', 'GreaterThan'),
    };
    const list = currentConditionList(conditions, 'Conditions', 'A.esm', pendingChangeMap);
    expect(list[0].operator).toBe('GreaterThan');
  });

  it('overlays a pending parameter edit onto the matching parameter slot', () => {
    const conditions = [diff(0, {
      'A.esm': condition({ parameters: [{ category: 'Number', typeName: 'QuestStage', number: 1 }] }),
    })];
    const pendingChangeMap = {
      'A.esm:CTDA\\Conditions\\0\\Parameter\\0': change('CTDA\\Conditions\\0\\Parameter\\0', 42),
    };
    const list = currentConditionList(conditions, 'Conditions', 'A.esm', pendingChangeMap);
    expect(list[0].parameters[0].number).toBe(42);
  });

  it('does not mutate an unrelated plugin\'s pending edits into this one\'s list', () => {
    const conditions = [diff(0, { 'A.esm': condition({ operator: 'EqualTo' }) })];
    const pendingChangeMap = {
      'B.esm:CTDA\\Conditions\\0\\Operator': change('CTDA\\Conditions\\0\\Operator', 'GreaterThan'),
    };
    const list = currentConditionList(conditions, 'Conditions', 'A.esm', pendingChangeMap);
    expect(list[0].operator).toBe('EqualTo');
  });
});
