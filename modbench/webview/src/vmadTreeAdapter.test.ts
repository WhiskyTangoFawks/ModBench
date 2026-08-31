import { describe, it, expect } from 'vitest';
import { buildVmadRows } from './vmadTreeAdapter';
import type { VmadPropertyDiff, VmadScriptDiff } from './types';

const WRAPPER = 'Scripts (VMAD)';

function script(partial: Partial<VmadScriptDiff> = {}): VmadScriptDiff {
  return {
    name: 'ScriptA',
    flags: { 'Fallout4.esm': 'Local', 'MyMod.esp': 'Local' },
    winnerColumn: 'Fallout4.esm',
    cellStates: {},
    properties: [],
    ...partial,
  };
}

function scalarProp(partial: Partial<VmadPropertyDiff> = {}): VmadPropertyDiff {
  return {
    name: 'Health', kind: 'scalar',
    values: { 'Fallout4.esm': 10, 'MyMod.esp': 20 },
    types: { 'Fallout4.esm': 'Int', 'MyMod.esp': 'Int' },
    winnerColumn: 'MyMod.esp',
    cellStates: { 'MyMod.esp': 'Override' },
    ...partial,
  };
}

// Every script lives one level below the always-present "Scripts (VMAD)"
// wrapper row (the stable home for "Add Script" even when a VMAD-capable record currently has no
// scripts at all) — this helper does that one hop so the rest of this file reads as "the script"
// and "the script's own metadata", matching how RecordPanel's recursive builder actually reaches
// them.
function scriptRowFor(scripts: VmadScriptDiff[], name = 'ScriptA') {
  const { diffs, metaMap } = buildVmadRows({ scripts });
  const wrapper = diffs[0];
  const wrapperMeta = metaMap[WRAPPER];
  const diff = wrapper.children?.find(c => c.fieldName === name);
  const meta = wrapperMeta.fields?.find(f => f.name === name);
  return { wrapper, wrapperMeta, diffs, metaMap, diff, meta };
}

describe('buildVmadRows — the "Scripts (VMAD)" wrapper and script shape', () => {
  it('produces exactly one top-level wrapper row, named "Scripts (VMAD)"', () => {
    const { diffs, metaMap } = buildVmadRows({ scripts: [script()] });
    expect(diffs).toHaveLength(1);
    expect(diffs[0].fieldName).toBe(WRAPPER);
    expect(metaMap[WRAPPER].type).toBe('struct');
  });

  it('the wrapper is present (empty) even with zero scripts — the "Add Script" affordance\'s home', () => {
    const { diffs, metaMap } = buildVmadRows({ scripts: [] });
    expect(diffs[0].fieldName).toBe(WRAPPER);
    expect(diffs[0].children).toEqual([]);
    expect(metaMap[WRAPPER].fields).toEqual([]);
  });

  it('returns no rows at all for a null/absent VMAD compare (caller gates hasVmad separately)', () => {
    expect(buildVmadRows(null).diffs[0].children).toEqual([]);
    expect(buildVmadRows(undefined).diffs[0].children).toEqual([]);
  });

  it('a script row has no wirePath of its own (never restaged as a whole value)', () => {
    const { diff } = scriptRowFor([script()]);
    expect(diff?.wirePath).toBeUndefined();
  });

  it("a script row's first child is a read-only Flags field reflecting per-plugin flags", () => {
    const { diff } = scriptRowFor([script()]);
    const flagsChild = diff?.children?.[0];
    expect(flagsChild?.fieldName).toBe('Flags');
    expect(flagsChild?.values).toEqual({ 'Fallout4.esm': 'Local', 'MyMod.esp': 'Local' });
  });

  it('the Flags field metadata is readOnly (editing moves to the right-click menu)', () => {
    const { meta } = scriptRowFor([script()]);
    const flagsMeta = meta?.fields?.find(f => f.name === 'Flags');
    expect(flagsMeta?.readOnly).toBe(true);
    expect(flagsMeta?.enumValues).toContain('Local');
  });

  it('two scripts each get their own row under the same wrapper', () => {
    const { wrapper } = scriptRowFor([script(), script({ name: 'ScriptB' })]);
    expect(wrapper.children?.map(c => c.fieldName)).toEqual(['ScriptA', 'ScriptB']);
  });
});

describe('buildVmadRows — scalar property', () => {
  const { diff: scriptDiff, meta: scriptMeta } = scriptRowFor([script({ properties: [scalarProp()] })]);
  const healthChild = scriptDiff?.children?.find(c => c.fieldName === 'Health');
  const healthMeta = scriptMeta?.fields?.find(f => f.name === 'Health');

  it('carries its own wirePath, distinct from the script container', () => {
    expect(healthChild?.wirePath).toBe('VMAD\\ScriptA\\Health');
  });

  it("resolves its scalar type from the winner plugin's VMAD type string", () => {
    expect(healthMeta?.type).toBe('int');
  });

  it('carries the per-plugin values and cellStates straight through', () => {
    expect(healthChild?.values).toEqual({ 'Fallout4.esm': 10, 'MyMod.esp': 20 });
    expect(healthChild?.cellStates).toEqual({ 'MyMod.esp': 'Override' });
  });
});

describe('buildVmadRows — object property', () => {
  const objProp: VmadPropertyDiff = {
    name: 'Target', kind: 'object',
    values: { 'Fallout4.esm': '000010:Fallout4.esm [-1]' },
    types: { 'Fallout4.esm': 'Object' },
    winnerColumn: 'Fallout4.esm',
    cellStates: {},
    resolutions: { 'Fallout4.esm': { state: 'ResolvedValidType', recordType: 'npc_', editorId: 'Someone' } },
  };
  const { diff: scriptDiff, meta: scriptMeta } = scriptRowFor([script({ properties: [objProp] })]);
  const child = scriptDiff?.children?.find(c => c.fieldName === 'Target');
  const meta = scriptMeta?.fields?.find(f => f.name === 'Target');

  it('is typed as the synthesized vmadObject leaf', () => {
    expect(meta?.type).toBe('vmadObject');
  });

  it('carries its resolutions through (ADR-0031 signal)', () => {
    expect(child?.resolutions).toEqual(objProp.resolutions);
  });
});

describe('buildVmadRows — variable property (never editable)', () => {
  const varProp: VmadPropertyDiff = {
    name: 'SomeVar', kind: 'variable',
    values: { 'Fallout4.esm': 'anything' },
    types: { 'Fallout4.esm': 'Int' },
    winnerColumn: 'Fallout4.esm',
    cellStates: {},
  };
  const { diff: scriptDiff, meta: scriptMeta } = scriptRowFor([script({ properties: [varProp] })]);
  const child = scriptDiff?.children?.find(c => c.fieldName === 'SomeVar');
  const meta = scriptMeta?.fields?.find(f => f.name === 'SomeVar');

  it('is readOnly', () => {
    expect(meta?.readOnly).toBe(true);
  });

  it('shows the "(Variable)" display text when present', () => {
    expect(child?.values['Fallout4.esm']).toBe('(Variable)');
  });
});

describe('buildVmadRows — array of scalars (ArrayOfInt)', () => {
  const arrProp: VmadPropertyDiff = {
    name: 'Levels', kind: 'array',
    values: {}, types: { 'Fallout4.esm': 'ArrayOfInt' }, winnerColumn: 'Fallout4.esm', cellStates: {},
    children: [
      { name: '', kind: 'scalar', values: { 'Fallout4.esm': 1, 'MyMod.esp': 1 }, types: { 'Fallout4.esm': 'Int', 'MyMod.esp': 'Int' }, winnerColumn: 'Fallout4.esm', cellStates: {} },
      { name: '', kind: 'scalar', values: { 'Fallout4.esm': 2, 'MyMod.esp': 9 }, types: { 'Fallout4.esm': 'Int', 'MyMod.esp': 'Int' }, winnerColumn: 'MyMod.esp', cellStates: { 'MyMod.esp': 'Override' } },
    ],
  };
  const { diff: scriptDiff, meta: scriptMeta } = scriptRowFor([script({ properties: [arrProp] })]);
  const child = scriptDiff?.children?.find(c => c.fieldName === 'Levels');
  const meta = scriptMeta?.fields?.find(f => f.name === 'Levels');

  it('reconstructs a real per-plugin array (not null) so editing an element preserves its siblings', () => {
    expect(child?.values['Fallout4.esm']).toEqual([1, 2]);
    expect(child?.values['MyMod.esp']).toEqual([1, 9]);
  });

  it('produces positional "[i]" element rows an ordinary unsorted array would recognize', () => {
    expect(child?.children?.map(c => c.fieldName)).toEqual(['[0]', '[1]']);
  });

  it('is metadata-typed as a plain (unsorted) array, so it reuses the generic array-op machinery', () => {
    expect(meta?.type).toBe('array');
    expect(meta?.elementType?.isSortable).not.toBe(true);
    expect(meta?.elementType?.type).toBe('int');
  });
});

// When plugins disagree on how many elements a VMAD array has, the backend still
// reports every plugin at every union-aligned position (null past that plugin's own real length —
// VmadConflictClassifier.IndexedChildren, always trailing, never a genuine mid-list gap). The
// per-plugin array reconstructed here must reflect *that plugin's own real length*, not the
// union's — otherwise a Remove/Move on the shorter plugin's row restages an array still carrying
// those trailing nulls (VmadCodec.RebuildList's `el.GetInt32()`/`GetBoolean()`/`GetSingle()` throw
// on a JSON null element at save time for Bool/Int/Float arrays). Mirrors the same trailing-null
// shape conditionTreeAdapter's own conditionsSparseByPlugin already handles correctly.
describe('buildVmadRows — array of scalars, plugins with different real lengths (issue #168)', () => {
  const arrProp: VmadPropertyDiff = {
    name: 'Levels', kind: 'array',
    values: {}, types: { 'Fallout4.esm': 'ArrayOfInt' }, winnerColumn: 'Fallout4.esm', cellStates: {},
    children: [
      { name: '', kind: 'scalar', values: { 'Fallout4.esm': 1, 'MyMod.esp': 1 }, types: { 'Fallout4.esm': 'Int', 'MyMod.esp': 'Int' }, winnerColumn: 'Fallout4.esm', cellStates: {} },
      { name: '', kind: 'scalar', values: { 'Fallout4.esm': 2, 'MyMod.esp': null }, types: { 'Fallout4.esm': 'Int' }, winnerColumn: 'Fallout4.esm', cellStates: {} },
      { name: '', kind: 'scalar', values: { 'Fallout4.esm': 3, 'MyMod.esp': null }, types: { 'Fallout4.esm': 'Int' }, winnerColumn: 'Fallout4.esm', cellStates: {} },
    ],
  };
  const { diff: scriptDiff } = scriptRowFor([script({ properties: [arrProp] })]);
  const child = scriptDiff?.children?.find(c => c.fieldName === 'Levels');

  it("reconstructs each plugin's own real (trimmed) array length, not the union's", () => {
    expect(child?.values['Fallout4.esm']).toEqual([1, 2, 3]);
    expect(child?.values['MyMod.esp']).toEqual([1]);
  });
});

describe('buildVmadRows — struct property (raw-node commitOverride)', () => {
  const structProp: VmadPropertyDiff = {
    name: 'Bounds', kind: 'struct',
    values: {}, types: { 'Fallout4.esm': 'Struct' }, winnerColumn: 'Fallout4.esm', cellStates: {},
    raw: {
      'Fallout4.esm': [
        { name: 'X', type: 'Int', intValue: 5 },
        { name: 'Y', type: 'Int', intValue: 10 },
      ],
    },
    children: [
      { name: 'X', kind: 'scalar', values: { 'Fallout4.esm': 5 }, types: { 'Fallout4.esm': 'Int' }, winnerColumn: 'Fallout4.esm', cellStates: {} },
      { name: 'Y', kind: 'scalar', values: { 'Fallout4.esm': 10 }, types: { 'Fallout4.esm': 'Int' }, winnerColumn: 'Fallout4.esm', cellStates: {} },
    ],
  };
  const { diff: scriptDiff, meta: scriptMeta } = scriptRowFor([script({ properties: [structProp] })]);
  const child = scriptDiff?.children?.find(c => c.fieldName === 'Bounds');
  const meta = scriptMeta?.fields?.find(f => f.name === 'Bounds');

  it('is typed as a struct with member metadata for X and Y', () => {
    expect(meta?.type).toBe('struct');
    expect(meta?.fields?.map(f => f.name)).toEqual(['X', 'Y']);
  });

  it('carries the raw per-plugin node array as its disk value', () => {
    expect(child?.values['Fallout4.esm']).toEqual(structProp.raw!['Fallout4.esm']);
  });
});


describe('buildVmadRows — structList property (ArrayOfStruct)', () => {
  const instanceMembers = (x: number, y: number) => [
    { name: 'X', type: 'Int', intValue: x },
    { name: 'Y', type: 'Int', intValue: y },
  ];
  const structListProp: VmadPropertyDiff = {
    name: 'Points', kind: 'structList',
    values: {}, types: { 'Fallout4.esm': 'ArrayOfStruct' }, winnerColumn: 'Fallout4.esm', cellStates: {},
    raw: { 'Fallout4.esm': [instanceMembers(1, 2), instanceMembers(3, 4)] },
    children: [
      {
        name: '', kind: 'struct', values: {}, types: {}, winnerColumn: 'Fallout4.esm', cellStates: {},
        children: [
          { name: 'X', kind: 'scalar', values: { 'Fallout4.esm': 1 }, types: { 'Fallout4.esm': 'Int' }, winnerColumn: 'Fallout4.esm', cellStates: {} },
          { name: 'Y', kind: 'scalar', values: { 'Fallout4.esm': 2 }, types: { 'Fallout4.esm': 'Int' }, winnerColumn: 'Fallout4.esm', cellStates: {} },
        ],
      },
      {
        name: '', kind: 'struct', values: {}, types: {}, winnerColumn: 'Fallout4.esm', cellStates: {},
        children: [
          { name: 'X', kind: 'scalar', values: { 'Fallout4.esm': 3 }, types: { 'Fallout4.esm': 'Int' }, winnerColumn: 'Fallout4.esm', cellStates: {} },
          { name: 'Y', kind: 'scalar', values: { 'Fallout4.esm': 4 }, types: { 'Fallout4.esm': 'Int' }, winnerColumn: 'Fallout4.esm', cellStates: {} },
        ],
      },
    ],
  };
  const { diff: scriptDiff, meta: scriptMeta } = scriptRowFor([script({ properties: [structListProp] })]);
  const child = scriptDiff?.children?.find(c => c.fieldName === 'Points');
  const meta = scriptMeta?.fields?.find(f => f.name === 'Points');

  it('is typed as an array of struct instances (reuses the generic array element machinery for Remove/Move)', () => {
    expect(meta?.type).toBe('array');
    expect(meta?.elementType?.type).toBe('struct');
    expect(child?.children?.map(c => c.fieldName)).toEqual(['[0]', '[1]']);
  });
});

// Every synthesized FieldDiff node this adapter builds must populate its own
// bottom-up conflictAll — the compare grid's per-row renderer reads it directly, with no fallback
// computation of its own, so a node the adapter forgot would silently paint no background.
describe('buildVmadRows — per-node conflictAll (issue #114)', () => {
  it('a leaf property carries its own reduced conflictAll', () => {
    const conflicting = scalarProp({ name: 'Health', cellStates: { 'MyMod.esp': 'Override' } });
    const agreeing = scalarProp({ name: 'Speed', cellStates: {} });
    const { diff } = scriptRowFor([script({ properties: [conflicting, agreeing] })]);
    const healthChild = diff?.children?.find(c => c.fieldName === 'Health');
    const speedChild = diff?.children?.find(c => c.fieldName === 'Speed');
    expect(healthChild?.conflictAll).toBe('Override');
    expect(speedChild?.conflictAll).toBe('NoConflict');
  });

  it('a script row aggregates the worst conflictAll found among its own properties (bottom-up)', () => {
    const conflicting = scalarProp({ name: 'Health', cellStates: { 'MyMod.esp': 'ConflictWins' } });
    const agreeing = scalarProp({ name: 'Speed', cellStates: {} });
    const { diff } = scriptRowFor([script({ properties: [conflicting, agreeing], cellStates: {} })]);
    expect(diff?.conflictAll).toBe('Conflict');
  });

  it('the top-level "Scripts (VMAD)" wrapper aggregates across every script — one conflicting script among agreeing ones', () => {
    const conflictingScript = script({
      name: 'ScriptA', cellStates: {},
      properties: [scalarProp({ name: 'Health', cellStates: { 'MyMod.esp': 'Override' } })],
    });
    const agreeingScript = script({
      name: 'ScriptB', cellStates: {},
      properties: [scalarProp({ name: 'Speed', cellStates: {} })],
    });
    const { wrapper } = scriptRowFor([conflictingScript, agreeingScript]);
    expect(wrapper.conflictAll).toBe('Override');
  });

  it('an array property shows element-level isolation — a conflicting element does not contaminate its agreeing sibling', () => {
    const arrProp: VmadPropertyDiff = {
      name: 'Levels', kind: 'array',
      values: {}, types: { 'Fallout4.esm': 'ArrayOfInt' }, winnerColumn: 'Fallout4.esm', cellStates: {},
      children: [
        { name: '', kind: 'scalar', values: { 'Fallout4.esm': 1, 'MyMod.esp': 1 }, types: { 'Fallout4.esm': 'Int', 'MyMod.esp': 'Int' }, winnerColumn: 'Fallout4.esm', cellStates: {} },
        { name: '', kind: 'scalar', values: { 'Fallout4.esm': 2, 'MyMod.esp': 9 }, types: { 'Fallout4.esm': 'Int', 'MyMod.esp': 'Int' }, winnerColumn: 'MyMod.esp', cellStates: { 'MyMod.esp': 'Override' } },
      ],
    };
    const { diff: scriptDiff } = scriptRowFor([script({ properties: [arrProp] })]);
    const arrayChild = scriptDiff?.children?.find(c => c.fieldName === 'Levels');
    const [element0, element1] = arrayChild?.children ?? [];
    expect(element0?.conflictAll).toBe('NoConflict');
    expect(element1?.conflictAll).toBe('Override');
    // The array's own row aggregates to the worse of its two elements.
    expect(arrayChild?.conflictAll).toBe('Override');
  });
});
