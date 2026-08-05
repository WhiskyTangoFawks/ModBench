import { describe, it, expect } from 'vitest';
import { buildVmadRows } from './vmadTreeAdapter';
import type { VmadPropertyDiff, VmadScriptDiff } from './types';

const WRAPPER = 'Scripts (VMAD)';

function script(partial: Partial<VmadScriptDiff> = {}): VmadScriptDiff {
  return {
    name: 'ScriptA',
    flags: { 'Fallout4.esm': 'Local', 'MyMod.esp': 'Local' },
    winnerPlugin: 'Fallout4.esm',
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
    winnerPlugin: 'MyMod.esp',
    cellStates: { 'MyMod.esp': 'Override' },
    ...partial,
  };
}

// Issue #119/#231: every script lives one level below the always-present "Scripts (VMAD)"
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
    winnerPlugin: 'Fallout4.esm',
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
    winnerPlugin: 'Fallout4.esm',
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
    values: {}, types: { 'Fallout4.esm': 'ArrayOfInt' }, winnerPlugin: 'Fallout4.esm', cellStates: {},
    children: [
      { name: '', kind: 'scalar', values: { 'Fallout4.esm': 1, 'MyMod.esp': 1 }, types: { 'Fallout4.esm': 'Int', 'MyMod.esp': 'Int' }, winnerPlugin: 'Fallout4.esm', cellStates: {} },
      { name: '', kind: 'scalar', values: { 'Fallout4.esm': 2, 'MyMod.esp': 9 }, types: { 'Fallout4.esm': 'Int', 'MyMod.esp': 'Int' }, winnerPlugin: 'MyMod.esp', cellStates: { 'MyMod.esp': 'Override' } },
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

describe('buildVmadRows — struct property (raw-node commitOverride)', () => {
  const structProp: VmadPropertyDiff = {
    name: 'Bounds', kind: 'struct',
    values: {}, types: { 'Fallout4.esm': 'Struct' }, winnerPlugin: 'Fallout4.esm', cellStates: {},
    raw: {
      'Fallout4.esm': [
        { name: 'X', type: 'Int', intValue: 5 },
        { name: 'Y', type: 'Int', intValue: 10 },
      ],
    },
    children: [
      { name: 'X', kind: 'scalar', values: { 'Fallout4.esm': 5 }, types: { 'Fallout4.esm': 'Int' }, winnerPlugin: 'Fallout4.esm', cellStates: {} },
      { name: 'Y', kind: 'scalar', values: { 'Fallout4.esm': 10 }, types: { 'Fallout4.esm': 'Int' }, winnerPlugin: 'Fallout4.esm', cellStates: {} },
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

  it("commitOverride sets the target member's intValue in place, preserving its sibling node", () => {
    const current = structProp.raw!['Fallout4.esm'];
    const next = child!.commitOverride!(current, [{ kind: 'member', name: 'X' }], 99) as Array<Record<string, unknown>>;
    expect(next.find(n => n.name === 'X')?.intValue).toBe(99);
    expect(next.find(n => n.name === 'Y')?.intValue).toBe(10);
  });

  it('commitOverride does not mutate the source raw array', () => {
    const current = structProp.raw!['Fallout4.esm'];
    child!.commitOverride!(current, [{ kind: 'member', name: 'X' }], 99);
    expect((current as Array<Record<string, unknown>>).find(n => n.name === 'X')?.intValue).toBe(5);
  });
});

// Issue #231 (review, item 6): the deleted VmadSection.test.tsx proved commitOverride's node-walk
// at two chained `member` hops (a struct member that is itself a struct); the replacement suite
// above only proves one hop. nodeAt/propertyAt (vmadTreeAdapter.ts) are written generically for N
// hops — this pins that the generalization actually holds at depth 2, not merely at depth 1.
describe('buildVmadRows — struct-in-struct property (nested member commitOverride, issue #231 review)', () => {
  const nestedStructProp: VmadPropertyDiff = {
    name: 'Bounds', kind: 'struct',
    values: {}, types: { 'Fallout4.esm': 'Struct' }, winnerPlugin: 'Fallout4.esm', cellStates: {},
    raw: {
      'Fallout4.esm': [
        { name: 'X', type: 'Int', intValue: 5 },
        { name: 'Inner', type: 'Struct', members: [{ name: 'Depth', type: 'Int', intValue: 7 }] },
      ],
    },
    children: [
      { name: 'X', kind: 'scalar', values: { 'Fallout4.esm': 5 }, types: { 'Fallout4.esm': 'Int' }, winnerPlugin: 'Fallout4.esm', cellStates: {} },
      {
        name: 'Inner', kind: 'struct', values: {}, types: {}, winnerPlugin: 'Fallout4.esm', cellStates: {},
        children: [
          { name: 'Depth', kind: 'scalar', values: { 'Fallout4.esm': 7 }, types: { 'Fallout4.esm': 'Int' }, winnerPlugin: 'Fallout4.esm', cellStates: {} },
        ],
      },
    ],
  };
  const { diff: scriptDiff } = scriptRowFor([script({ properties: [nestedStructProp] })]);
  const child = scriptDiff?.children?.find(c => c.fieldName === 'Bounds');

  it("commitOverride at two chained member hops sets the nested struct member's own intValue in place", () => {
    const current = nestedStructProp.raw!['Fallout4.esm'];
    const path = [{ kind: 'member' as const, name: 'Inner' }, { kind: 'member' as const, name: 'Depth' }];
    const next = child!.commitOverride!(current, path, 99) as Array<Record<string, unknown>>;
    const inner = next.find(n => n.name === 'Inner');
    expect((inner!.members as Array<Record<string, unknown>>).find(n => n.name === 'Depth')?.intValue).toBe(99);
  });

  it('preserves the outer struct\'s sibling member (X) untouched by a nested-member commit', () => {
    const current = nestedStructProp.raw!['Fallout4.esm'];
    const path = [{ kind: 'member' as const, name: 'Inner' }, { kind: 'member' as const, name: 'Depth' }];
    const next = child!.commitOverride!(current, path, 99) as Array<Record<string, unknown>>;
    expect(next.find(n => n.name === 'X')?.intValue).toBe(5);
  });

  it('does not mutate the source raw array', () => {
    const current = nestedStructProp.raw!['Fallout4.esm'];
    const path = [{ kind: 'member' as const, name: 'Inner' }, { kind: 'member' as const, name: 'Depth' }];
    child!.commitOverride!(current, path, 99);
    const inner = (current as Array<Record<string, unknown>>).find(n => n.name === 'Inner');
    expect((inner!.members as Array<Record<string, unknown>>).find(n => n.name === 'Depth')?.intValue).toBe(7);
  });
});

describe('buildVmadRows — structList property (ArrayOfStruct)', () => {
  const instanceMembers = (x: number, y: number) => [
    { name: 'X', type: 'Int', intValue: x },
    { name: 'Y', type: 'Int', intValue: y },
  ];
  const structListProp: VmadPropertyDiff = {
    name: 'Points', kind: 'structList',
    values: {}, types: { 'Fallout4.esm': 'ArrayOfStruct' }, winnerPlugin: 'Fallout4.esm', cellStates: {},
    raw: { 'Fallout4.esm': [instanceMembers(1, 2), instanceMembers(3, 4)] },
    children: [
      {
        name: '', kind: 'struct', values: {}, types: {}, winnerPlugin: 'Fallout4.esm', cellStates: {},
        children: [
          { name: 'X', kind: 'scalar', values: { 'Fallout4.esm': 1 }, types: { 'Fallout4.esm': 'Int' }, winnerPlugin: 'Fallout4.esm', cellStates: {} },
          { name: 'Y', kind: 'scalar', values: { 'Fallout4.esm': 2 }, types: { 'Fallout4.esm': 'Int' }, winnerPlugin: 'Fallout4.esm', cellStates: {} },
        ],
      },
      {
        name: '', kind: 'struct', values: {}, types: {}, winnerPlugin: 'Fallout4.esm', cellStates: {},
        children: [
          { name: 'X', kind: 'scalar', values: { 'Fallout4.esm': 3 }, types: { 'Fallout4.esm': 'Int' }, winnerPlugin: 'Fallout4.esm', cellStates: {} },
          { name: 'Y', kind: 'scalar', values: { 'Fallout4.esm': 4 }, types: { 'Fallout4.esm': 'Int' }, winnerPlugin: 'Fallout4.esm', cellStates: {} },
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

  it('commitOverride sets a member inside a specific instance, leaving the other instance untouched', () => {
    const current = structListProp.raw!['Fallout4.esm'];
    const next = child!.commitOverride!(current, [{ kind: 'index', index: 1 }, { kind: 'member', name: 'X' }], 30) as unknown[][];
    expect((next[1].find((n): n is Record<string, unknown> => (n as Record<string, unknown>).name === 'X') as Record<string, unknown>).intValue).toBe(30);
    expect((next[0].find((n): n is Record<string, unknown> => (n as Record<string, unknown>).name === 'X') as Record<string, unknown>).intValue).toBe(1);
  });
});
