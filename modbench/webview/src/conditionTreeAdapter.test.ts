import { describe, it, expect } from 'vitest';
import { buildConditionRows } from './conditionTreeAdapter';
import type { ConditionDiff, FormKeyResolution, ParsedCondition } from './types';

function condition(partial: Partial<ParsedCondition> = {}): ParsedCondition {
  return {
    function: 'GetIsID', operator: 'EqualTo', or: false,
    runOnTarget: 'Subject', runOnReference: null, useGlobal: false,
    comparisonFloat: 0, comparisonGlobal: null, parameters: [],
    ...partial,
  };
}

function conditionDiff(partial: Partial<ConditionDiff> = {}): ConditionDiff {
  return {
    index: 0,
    perPlugin: { 'Fallout4.esm': condition(), 'MyMod.esp': condition() },
    winnerColumn: 'Fallout4.esm',
    cellStates: {},
    fieldCellStates: {},
    ...partial,
  };
}

describe('buildConditionRows — group shape', () => {
  it('produces one array-typed FieldDiff per condition-owning field', () => {
    const { diffs, metaMap } = buildConditionRows({ groups: [{ fieldPath: 'Conditions', conditions: [conditionDiff()] }] });
    expect(diffs).toHaveLength(1);
    expect(diffs[0].fieldName).toBe('Conditions');
    expect(metaMap.Conditions.type).toBe('array');
  });

  it('the group\'s own wirePath is its own fieldPath (the whole-list restage target)', () => {
    const { diffs } = buildConditionRows({ groups: [{ fieldPath: 'Conditions', conditions: [conditionDiff()] }] });
    expect(diffs[0].wirePath).toBe('Conditions');
  });

  it('returns no rows for a null/absent ConditionCompare', () => {
    expect(buildConditionRows(null)).toEqual({ diffs: [], metaMap: {} });
    expect(buildConditionRows(undefined)).toEqual({ diffs: [], metaMap: {} });
  });

  it('a second condition-owning field on the same record gets its own independent group row', () => {
    const { diffs } = buildConditionRows({
      groups: [
        { fieldPath: 'DialogConditions', conditions: [conditionDiff()] },
        { fieldPath: 'UnusedConditions', conditions: [conditionDiff()] },
      ],
    });
    expect(diffs.map(d => d.fieldName)).toEqual(['DialogConditions', 'UnusedConditions']);
  });
});

describe('buildConditionRows — sparse per-plugin alignment', () => {
  it('a plugin missing a condition leaves a hole at that canonical index', () => {
    const conditions = [
      conditionDiff({ index: 0, perPlugin: { 'Fallout4.esm': condition({ function: 'A' }), 'MyMod.esp': condition({ function: 'A' }) } }),
      conditionDiff({ index: 1, perPlugin: { 'Fallout4.esm': condition({ function: 'B' }), 'MyMod.esp': null } }),
    ];
    const { diffs } = buildConditionRows({ groups: [{ fieldPath: 'Conditions', conditions }] });
    const values = diffs[0].values as Record<string, (ParsedCondition | undefined)[]>;
    expect(values['Fallout4.esm']).toHaveLength(2);
    expect(values['MyMod.esp'][1]).toBeUndefined();
  });

  it('commitOverride compacts a sparse array (drops holes) before staging', () => {
    const { diffs } = buildConditionRows({ groups: [{ fieldPath: 'Conditions', conditions: [conditionDiff()] }] });
    const sparse = [condition({ function: 'A' }), undefined, condition({ function: 'C' })];
    const result = diffs[0].commitOverride!(undefined, [], sparse);
    expect(result).toEqual([condition({ function: 'A' }), condition({ function: 'C' })]);
  });
});

describe('buildConditionRows — condition (array element) shape', () => {
  const { diffs } = buildConditionRows({ groups: [{ fieldPath: 'Conditions', conditions: [conditionDiff()] }] });
  const conditionRow = diffs[0].children?.[0];

  it('is a struct-typed row, labeled by its own canonical bracket index', () => {
    expect(conditionRow?.fieldName).toBe('[0]');
  });

  it('has no wirePath of its own (participates in the group\'s whole-list restage, not an independent one)', () => {
    expect(conditionRow?.wirePath).toBeUndefined();
  });

  it('carries the whole ParsedCondition as its own value (for copy/drag), not a placeholder', () => {
    expect(conditionRow?.values['Fallout4.esm']).toEqual(condition());
  });
});

describe('buildConditionRows — condition fields', () => {
  const c = condition({
    function: 'GetStageDone', operator: 'GreaterThan', or: true,
    runOnTarget: 'Reference', runOnReference: '000010:Fallout4.esm',
    useGlobal: true, comparisonGlobal: '000020:Fallout4.esm',
    parameters: [{ category: 'Text', typeName: 'Quest', text: 'MQ101' }],
  });
  const diff = conditionDiff({ perPlugin: { 'Fallout4.esm': c } });
  const { diffs } = buildConditionRows({ groups: [{ fieldPath: 'Conditions', conditions: [diff] }] });
  const fieldByName = (name: string) => diffs[0].children?.[0].children?.find(f => f.fieldName === name);

  it('Function carries its own wirePath and the plain function-name value', () => {
    const f = fieldByName('Function');
    expect(f?.wirePath).toBe('CTDA\\Conditions\\0\\Function');
    expect(f?.values['Fallout4.esm']).toBe('GetStageDone');
  });

  it('Run On carries a composite {target, reference} value', () => {
    expect(fieldByName('Run On')?.values['Fallout4.esm']).toEqual({ target: 'Reference', reference: '000010:Fallout4.esm' });
  });

  it('Comparison carries the bare GLOB FormKey (a string) when UseGlobal is set — no wrapper object', () => {
    expect(fieldByName('Comparison')?.values['Fallout4.esm']).toBe('000020:Fallout4.esm');
  });

  it('Comparison carries the bare float when UseGlobal is unset', () => {
    const c2 = condition({ useGlobal: false, comparisonFloat: 42 });
    const { diffs: d2 } = buildConditionRows({ groups: [{ fieldPath: 'Conditions', conditions: [conditionDiff({ perPlugin: { 'Fallout4.esm': c2 } })] }] });
    const comparisonField = d2[0].children?.[0].children?.find(f => f.fieldName === 'Comparison');
    expect(comparisonField?.values['Fallout4.esm']).toBe(42);
  });

  it('a Parameter field carries its own wirePath addressed by index', () => {
    expect(fieldByName('Parameter 1')?.wirePath).toBe('CTDA\\Conditions\\0\\Parameter\\0');
    expect(fieldByName('Parameter 1')?.values['Fallout4.esm']).toEqual({ category: 'Text', typeName: 'Quest', text: 'MQ101' });
  });

  it('the AND/OR gate has no wirePath and is readOnly', () => {
    const gate = fieldByName('Type');
    expect(gate?.wirePath).toBeUndefined();
    expect(gate?.values['Fallout4.esm']).toBe('OR');
  });

  it('the gate\'s own metadata is readOnly regardless of column mutability', () => {
    const { metaMap } = buildConditionRows({ groups: [{ fieldPath: 'Conditions', conditions: [diff] }] });
    const conditionElementMeta = metaMap.Conditions.elementType!;
    const gateMeta = conditionElementMeta.fields?.find(f => f.name === 'Type');
    expect(gateMeta?.readOnly).toBe(true);
  });

  // Issue #167: buildConditionRows' own `runOnTargets` param is the only source of Run On's
  // dropdown options — no hardcoded FO4 member list left in this adapter either.
  it('threads the runOnTargets argument into the Run On field\'s own enumValues, defaulting to empty', () => {
    const { metaMap: withCatalog } = buildConditionRows(
      { groups: [{ fieldPath: 'Conditions', conditions: [diff] }] }, ['Foo', 'Bar'],
    );
    const runOnMeta = withCatalog.Conditions.elementType!.fields?.find(f => f.name === 'Run On');
    expect(runOnMeta?.enumValues).toEqual(['Foo', 'Bar']);

    const { metaMap: withoutCatalog } = buildConditionRows({ groups: [{ fieldPath: 'Conditions', conditions: [diff] }] });
    const runOnMetaDefault = withoutCatalog.Conditions.elementType!.fields?.find(f => f.name === 'Run On');
    expect(runOnMetaDefault?.enumValues).toEqual([]);
  });

  it('a field\'s cellStates come from the condition\'s own fieldCellStates, keyed per field', () => {
    const diffWithConflict = conditionDiff({
      perPlugin: { 'Fallout4.esm': c, 'MyMod.esp': c },
      fieldCellStates: { function: { 'MyMod.esp': 'ConflictWins' } },
    });
    const { diffs: d3 } = buildConditionRows({ groups: [{ fieldPath: 'Conditions', conditions: [diffWithConflict] }] });
    const functionField = d3[0].children?.[0].children?.find(f => f.fieldName === 'Function');
    expect(functionField?.cellStates).toEqual({ 'MyMod.esp': 'ConflictWins' });
  });

  // #166: FormKey resolution (ADR-0031) for the condition's three FormKey-bearing slots — sourced
  // from the same fieldResolutions bag fieldCellStates already uses, threaded onto each field's own
  // FieldDiff.resolutions so FormKeyCell (via DiffRow's generic resolution pass-through, already
  // wired for every leaf row) can render "EditorID [FormKey]" instead of the bare FormKey.
  it('Run On / Comparison / a Parameter field carry their own resolution from fieldResolutions, keyed per field', () => {
    const resolution: FormKeyResolution = { state: 'ResolvedValidType', recordType: 'quest', editorId: 'SomeQuest' };
    const diffWithResolutions = conditionDiff({
      perPlugin: { 'Fallout4.esm': c },
      fieldResolutions: {
        runOn: { 'Fallout4.esm': resolution },
        comparison: { 'Fallout4.esm': resolution },
        'param:0': { 'Fallout4.esm': resolution },
      },
    });
    const { diffs: d4 } = buildConditionRows({ groups: [{ fieldPath: 'Conditions', conditions: [diffWithResolutions] }] });
    const fieldsByName = (name: string) => d4[0].children?.[0].children?.find(f => f.fieldName === name);

    expect(fieldsByName('Run On')?.resolutions).toEqual({ 'Fallout4.esm': resolution });
    expect(fieldsByName('Comparison')?.resolutions).toEqual({ 'Fallout4.esm': resolution });
    expect(fieldsByName('Parameter 1')?.resolutions).toEqual({ 'Fallout4.esm': resolution });
    // Function has no FormKey slot — never receives a resolution even when the bag is populated.
    expect(fieldsByName('Function')?.resolutions).toBeUndefined();
  });
});

describe('buildConditionRows — a fresh condition\'s default value matches ParsedCondition\'s wire shape', () => {
  it('elementType.defaultValue is a real ParsedCondition (GetIsID/EqualTo/AND), not a generic per-field-name struct default', () => {
    const { metaMap } = buildConditionRows({ groups: [{ fieldPath: 'Conditions', conditions: [conditionDiff()] }] });
    expect(metaMap.Conditions.elementType?.defaultValue).toEqual(condition());
  });
});

// Issue #231 (review, design call): the collapsed row's own xEdit-style prose summary
// (`wbConditionToStr`) — DiffRow.tsx shows this instead of the generic "{…}" placeholder.
describe('buildConditionRows — collapsedSummary (xEdit-style one-line prose, design call)', () => {
  it('formats RunOn.Function(params) Op Comparison, a Reference target and Global comparison included, no trailing conjunction on the plugin\'s own last condition', () => {
    const c = condition({
      function: 'GetStageDone', operator: 'GreaterThan', or: true,
      runOnTarget: 'Reference', runOnReference: '000010:Fallout4.esm',
      useGlobal: true, comparisonGlobal: '000020:Fallout4.esm',
      parameters: [{ category: 'Text', typeName: 'Quest', text: 'MQ101' }],
    });
    const diff = conditionDiff({ perPlugin: { 'Fallout4.esm': c } });
    const { diffs } = buildConditionRows({ groups: [{ fieldPath: 'Conditions', conditions: [diff] }] });
    expect(diffs[0].children?.[0].collapsedSummary?.['Fallout4.esm'])
      .toBe('(000010:Fallout4.esm).GetStageDone(MQ101) > 000020:Fallout4.esm');
  });

  it('a plain Subject/EqualTo/AND/no-param condition (not the list\'s last) carries the trailing " AND"', () => {
    const conditions = [
      conditionDiff({ index: 0, perPlugin: { 'Fallout4.esm': condition({ function: 'GetIsID' }) } }),
      conditionDiff({ index: 1, perPlugin: { 'Fallout4.esm': condition({ function: 'GetDead' }) } }),
    ];
    const { diffs } = buildConditionRows({ groups: [{ fieldPath: 'Conditions', conditions }] });
    expect(diffs[0].children?.[0].collapsedSummary?.['Fallout4.esm']).toBe('Subject.GetIsID = 0 AND');
    expect(diffs[0].children?.[1].collapsedSummary?.['Fallout4.esm']).toBe('Subject.GetDead = 0');
  });

  it('the OR gate produces a trailing " OR" instead of " AND" on a non-last condition', () => {
    const conditions = [
      conditionDiff({ index: 0, perPlugin: { 'Fallout4.esm': condition({ or: true }) } }),
      conditionDiff({ index: 1, perPlugin: { 'Fallout4.esm': condition() } }),
    ];
    const { diffs } = buildConditionRows({ groups: [{ fieldPath: 'Conditions', conditions }] });
    expect(diffs[0].children?.[0].collapsedSummary?.['Fallout4.esm']).toBe('Subject.GetIsID = 0 OR');
  });

  it('"last condition" is per-plugin — a plugin with fewer conditions gets no trailing conjunction on its own last row, even though another plugin has more', () => {
    const conditions = [
      conditionDiff({ index: 0, perPlugin: { 'Fallout4.esm': condition({ function: 'A' }), 'MyMod.esp': condition({ function: 'A' }) } }),
      conditionDiff({ index: 1, perPlugin: { 'Fallout4.esm': condition({ function: 'B' }), 'MyMod.esp': null } }),
    ];
    const { diffs } = buildConditionRows({ groups: [{ fieldPath: 'Conditions', conditions }] });
    expect(diffs[0].children?.[0].collapsedSummary?.['MyMod.esp']).toBe('Subject.A = 0');
    expect(diffs[0].children?.[0].collapsedSummary?.['Fallout4.esm']).toBe('Subject.A = 0 AND');
  });

  // Issue #165: matches xEdit's own wbConditionToStr — a decoded Number parameter's summary text
  // is its member name alone (e.g. "Male"), never the raw number.
  it('a decoded Number parameter shows its member name, not the raw number', () => {
    const c = condition({
      function: 'GetIsSex',
      parameters: [{ category: 'Number', typeName: 'Sex', number: 0, decodedValue: 'Male' }],
    });
    const diff = conditionDiff({ perPlugin: { 'Fallout4.esm': c } });
    const { diffs } = buildConditionRows({ groups: [{ fieldPath: 'Conditions', conditions: [diff] }] });
    expect(diffs[0].children?.[0].collapsedSummary?.['Fallout4.esm']).toBe('Subject.GetIsSex(Male) = 0');
  });
});

// Issue #114: every synthesized FieldDiff node this adapter builds must populate its own
// bottom-up conflictAll — DiffRow reads it directly, with no fallback computation of its own.
describe('buildConditionRows — per-node conflictAll (issue #114)', () => {
  it('a field leaf carries its own reduced conflictAll', () => {
    const diff = conditionDiff({ fieldCellStates: { operator: { 'MyMod.esp': 'Override' } } });
    const { diffs } = buildConditionRows({ groups: [{ fieldPath: 'Conditions', conditions: [diff] }] });
    const conditionRow = diffs[0].children?.[0];
    const operatorField = conditionRow?.children?.find(c => c.fieldName === 'Operator');
    const functionField = conditionRow?.children?.find(c => c.fieldName === 'Function');
    expect(operatorField?.conflictAll).toBe('Override');
    expect(functionField?.conflictAll).toBe('NoConflict');
  });

  // Bottom-up: the condition's own cellStates is empty here, but one of its own fields differs —
  // the condition row must still aggregate to the worse of its children, not stay NoConflict.
  it("a condition row aggregates from its field children even when its own whole-condition cellStates doesn't capture it", () => {
    const diff = conditionDiff({ cellStates: {}, fieldCellStates: { function: { 'MyMod.esp': 'ConflictWins' } } });
    const { diffs } = buildConditionRows({ groups: [{ fieldPath: 'Conditions', conditions: [diff] }] });
    expect(diffs[0].children?.[0].conflictAll).toBe('Conflict');
  });

  it('the group (array) row aggregates across its condition elements — one differing, one agreeing', () => {
    const conflicting = conditionDiff({ index: 0, fieldCellStates: { operator: { 'MyMod.esp': 'Override' } } });
    const agreeing = conditionDiff({ index: 1, fieldCellStates: {} });
    const { diffs } = buildConditionRows({ groups: [{ fieldPath: 'Conditions', conditions: [conflicting, agreeing] }] });
    const [conflictingRow, agreeingRow] = diffs[0].children ?? [];
    expect(conflictingRow?.conflictAll).toBe('Override');
    expect(agreeingRow?.conflictAll).toBe('NoConflict');
    // The group row itself aggregates to the worse of its two condition elements.
    expect(diffs[0].conflictAll).toBe('Override');
  });
});
