import '@testing-library/jest-dom';
import { describe, it, expect } from 'vitest';
import {
  buildColumns,
  readOnlyReason,
  collidingFilenames,
  parseElementIndex,
  pendingIfChanged,
  moveArrayElement,
  removeArrayElement,
  appendArrayElement,
  arrayElementContext,
  arrayParentContext,
  vmadScriptsContext,
  vmadScriptContext,
  vmadPropertyContext,
  combineVscodeContexts,
  getAtPath,
  setAtPath,
  pendingValueAtPath,
  defaultElementValue,
  reduceConflictAll,
  aggregateConflictAll,
  type PathSegment,
} from './recordUtils';
import type { FieldMetadata, CompareOverride } from './types';
import { columnKey } from './types';

function makeOverride(plugin: string, extra: Partial<CompareOverride> = {}): CompareOverride {
  return {
    formKey: '000001:Test.esp',
    plugin,
    loadOrderIndex: 0,
    isWinner: false,
    editorId: null,
    fields: [],
    conflictThis: 'OnlyOne',
    origin: 'Data',
    ...extra,
  };
}

describe('buildColumns', () => {
  it('produces one disk column per override when there are no pending changes', () => {
    const cols = buildColumns([makeOverride('Fallout4.esm'), makeOverride('MyMod.esp')]);
    expect(cols).toHaveLength(2);
    expect(cols.every(c => c.kind === 'disk')).toBe(true);
  });

  it('adds a pending column after a mutable override that has pending fields', () => {
    const cols = buildColumns([makeOverride('MyMod.esp', { pendingFields: { Name: 'draft' } })]);
    expect(cols).toHaveLength(2);
    expect(cols[0]).toMatchObject({ kind: 'disk' });
    expect(cols[1]).toMatchObject({ kind: 'pending', plugin: 'MyMod.esp' });
  });

  it('skips the pending column for immutable overrides even if they have pending fields', () => {
    const cols = buildColumns(
      [makeOverride('Fallout4.esm', { pendingFields: { Name: 'draft' } })],
      new Set([columnKey('Fallout4.esm', null)]),
    );
    expect(cols).toHaveLength(1);
    expect(cols[0]).toMatchObject({ kind: 'disk' });
  });

  it('skips the pending column when pendingFields is present but empty', () => {
    const cols = buildColumns([makeOverride('MyMod.esp', { pendingFields: {} })]);
    expect(cols).toHaveLength(1);
  });

  it('places the pending column immediately after its parent disk column', () => {
    const overrides = [
      makeOverride('Fallout4.esm'),
      makeOverride('MyMod.esp', { pendingFields: { Name: 'draft' } }),
      makeOverride('Other.esp'),
    ];
    const cols = buildColumns(overrides);
    expect(cols).toHaveLength(4);
    expect(cols[0]).toMatchObject({ kind: 'disk' });
    expect(cols[1]).toMatchObject({ kind: 'disk' });                       // MyMod.esp disk
    expect(cols[2]).toMatchObject({ kind: 'pending', plugin: 'MyMod.esp' }); // MyMod.esp pending
    expect(cols[3]).toMatchObject({ kind: 'disk' });                       // Other.esp disk
  });

  // #272 / ADR-0036: the genuinely red case — two overrides sharing a filename but differing in
  // origin must produce two distinct column keys, and each column's own pending-column gate must
  // be decided by its own origin's immutability, not the other column's. Pre-#272,
  // immutableSet.has(o.plugin) collided on the bare filename, so ModB's pending column would be
  // silently skipped too (or ModA's wrongly kept) depending on Set contents.
  it('keys columns by (plugin, origin), so two same-filename different-origin overrides stay distinct', () => {
    const overrides = [
      makeOverride('Shared.esp', { origin: 'ModA', pendingFields: { Name: 'fromA' } }),
      makeOverride('Shared.esp', { origin: 'ModB', pendingFields: { Name: 'fromB' } }),
    ];
    const cols = buildColumns(overrides, new Set([columnKey('Shared.esp', 'ModA')]));

    // ModA is immutable → no pending column; ModB is mutable → keeps its pending column.
    expect(cols).toHaveLength(3);
    expect(cols[0]).toMatchObject({ kind: 'disk', key: columnKey('Shared.esp', 'ModA') });
    expect(cols[1]).toMatchObject({ kind: 'disk', key: columnKey('Shared.esp', 'ModB') });
    expect(cols[2]).toMatchObject({ kind: 'pending', key: columnKey('Shared.esp', 'ModB'), plugin: 'Shared.esp' });
  });
});

// #304: the *reason* a column is read-only, distinct from the fact that it is — `immutableSet`
// alone can't tell a vanilla master (isImmutable, still inLoadOrder) apart from a copy the load
// order doesn't name (isImmutable *because* !inLoadOrder — GameSession.AddUnlistedPlugin always
// pairs the two). PluginHeader needs both to word the tooltip and decide whether to dim.
describe('readOnlyReason', () => {
  it('is null for a mutable column, regardless of inLoadOrder', () => {
    expect(readOnlyReason(false, true)).toBeNull();
    expect(readOnlyReason(false, false)).toBeNull();
  });

  it('is "vanillaMaster" for an immutable column still named by the load order', () => {
    expect(readOnlyReason(true, true)).toBe('vanillaMaster');
  });

  it('is "notInLoadOrder" for an immutable column the load order does not name', () => {
    expect(readOnlyReason(true, false)).toBe('notInLoadOrder');
  });
});

// #304 / ADR-0036: "origin inline only on collision" — computed from the overrides a single
// compare response already carries (CompareResult.Overrides), never from the session's whole
// plugin list. A filename appearing once is the overwhelming common case and must not collide.
describe('collidingFilenames', () => {
  it('is empty when every override has a distinct filename', () => {
    const overrides = [makeOverride('Fallout4.esm'), makeOverride('MyMod.esp')];
    expect(collidingFilenames(overrides)).toEqual(new Set());
  });

  it('is empty for a single override', () => {
    expect(collidingFilenames([makeOverride('Fallout4.esm')])).toEqual(new Set());
  });

  it('names a filename two overrides share, regardless of their differing origins', () => {
    const overrides = [
      makeOverride('Shared.esp', { origin: 'ModA' }),
      makeOverride('Shared.esp', { origin: 'ModB' }),
    ];
    expect(collidingFilenames(overrides)).toEqual(new Set(['Shared.esp']));
  });

  it('does not flag an unrelated filename that only appears once alongside a real collision', () => {
    const overrides = [
      makeOverride('Shared.esp', { origin: 'ModA' }),
      makeOverride('Shared.esp', { origin: 'ModB' }),
      makeOverride('Solo.esp'),
    ];
    expect(collidingFilenames(overrides)).toEqual(new Set(['Shared.esp']));
  });
});

describe('parseElementIndex', () => {
  it('parses the numeric index out of an "[N]" field name', () => {
    expect(parseElementIndex('[0]')).toBe(0);
    expect(parseElementIndex('[12]')).toBe(12);
  });
});

describe('pendingIfChanged', () => {
  it('returns undefined when pending is undefined', () => {
    expect(pendingIfChanged(undefined, 'disk')).toBeUndefined();
  });

  it('returns undefined when pending === disk (reference/primitive equal)', () => {
    expect(pendingIfChanged('same', 'same')).toBeUndefined();
  });

  it('returns undefined when pending deep-equals disk (structural)', () => {
    expect(pendingIfChanged({ X1: 0 }, { X1: 0 })).toBeUndefined();
  });

  it('returns pending when it differs from disk', () => {
    expect(pendingIfChanged({ X1: 5 }, { X1: 0 })).toEqual({ X1: 5 });
  });
});

// Issue #231: the generalized, path-based replacement for the old top-level/array-element/
// struct-child/grandchild switch DiffRow used to extract a row's own pending value out of the
// root's raw pending value — one implementation for every depth, including depths the old switch
// could not express (a struct nested more than one level deep, or a member below an array below a
// member). Supersedes the old extractPendingElementValue (array-element case) and the struct-
// child/grandchild cases the old DiffRow switch hand-rolled directly — deleted along with its own
// call site, now that this one function covers every depth those three used to split across.
describe('pendingValueAtPath', () => {
  it('returns the whole rawPending value for the root (empty path)', () => {
    expect(pendingValueAtPath({ X: 1 }, [])).toEqual({ X: 1 });
  });

  it('returns undefined at the root when rawPending itself is undefined (no pending change)', () => {
    expect(pendingValueAtPath(undefined, [])).toBeUndefined();
  });

  it('struct member: reads the member off rawPending', () => {
    const path: PathSegment[] = [{ kind: 'member', name: 'Target' }];
    expect(pendingValueAtPath({ Target: '000030:Fallout4.esm' }, path)).toBe('000030:Fallout4.esm');
  });

  it('positional array element: reads the element at the parsed index', () => {
    const path: PathSegment[] = [{ kind: 'index', index: 1 }];
    expect(pendingValueAtPath(['alpha', 'delta'], path)).toBe('delta');
  });

  it('positional array element: returns undefined when the index is out of range', () => {
    const path: PathSegment[] = [{ kind: 'index', index: 3 }];
    expect(pendingValueAtPath(['alpha'], path)).toBeUndefined();
  });

  it('sorted array element: returns the key itself when still present in rawPending', () => {
    const path: PathSegment[] = [{ kind: 'sortKey', key: 'KwdC' }];
    expect(pendingValueAtPath(['KwdA', 'KwdC'], path)).toBe('KwdC');
  });

  it('sorted array element: returns undefined when absent from rawPending', () => {
    const path: PathSegment[] = [{ kind: 'sortKey', key: 'KwdC' }];
    expect(pendingValueAtPath(['KwdA'], path)).toBeUndefined();
  });

  it('grandchild (index then member): reads the struct member of the array element', () => {
    const path: PathSegment[] = [{ kind: 'index', index: 2 }, { kind: 'member', name: 'Target' }];
    const rawPending = [{}, {}, { Target: '000077:Fallout4.esm' }];
    expect(pendingValueAtPath(rawPending, path)).toBe('000077:Fallout4.esm');
  });

  it('a depth the old switch could not express: member, then index, then member', () => {
    const path: PathSegment[] = [
      { kind: 'member', name: 'Outer' },
      { kind: 'index', index: 1 },
      { kind: 'member', name: 'Inner' },
    ];
    const rawPending = { Outer: [{ Inner: 'a' }, { Inner: 'b' }] };
    expect(pendingValueAtPath(rawPending, path)).toBe('b');
  });
});

// Issue #227: the pure mutations behind Move Up/Move Down/Remove/Add — extracted out of #142's
// DiffRow-local ArrayElementControls/ArrayAddButton so both the keyboard accelerator (DiskCell,
// in-webview only) and the right-click menu's broadcast handler (RecordPanel, arriving via the
// extension host) restage identically without sharing a runtime call path.
describe('moveArrayElement', () => {
  it('swaps the element at index with its neighbour one position up', () => {
    expect(moveArrayElement(['a', 'b', 'c'], 1, -1)).toEqual(['b', 'a', 'c']);
  });

  it('swaps the element at index with its neighbour one position down', () => {
    expect(moveArrayElement(['a', 'b', 'c'], 0, 1)).toEqual(['b', 'a', 'c']);
  });

  it('returns the array unchanged when the move would go out of bounds', () => {
    expect(moveArrayElement(['a', 'b', 'c'], 0, -1)).toEqual(['a', 'b', 'c']);
    expect(moveArrayElement(['a', 'b', 'c'], 2, 1)).toEqual(['a', 'b', 'c']);
  });

  // Issue #168: `index` itself, not just the swap target, must be bounds-checked. A row's index
  // comes from the union-aligned tree (VMAD/Condition's own positional alignment, or an ordinary
  // unsorted array with differing per-plugin lengths) and can equal or exceed *this specific
  // plugin's* own array length even though the swap target alone looks in range — e.g. index ===
  // array.length (one past this plugin's real last element) with direction -1 has j = index - 1,
  // which passes the existing j-only guard. Without this, the destructuring swap extends the
  // array by one slot and duplicates a value (`[next[index], next[j]] = [next[j], next[index]]`
  // with next[index] undefined) instead of the same "return array unchanged" no-op every other
  // boundary already gets.
  it('returns the array unchanged when index itself is out of bounds, even if the swap target is in range', () => {
    const arr = ['a', 'b'];
    expect(moveArrayElement(arr, 2, -1)).toBe(arr);
    expect(moveArrayElement(arr, 5, -1)).toBe(arr);
    expect(moveArrayElement(arr, -1, 1)).toBe(arr);
  });
});

describe('removeArrayElement', () => {
  it('drops the element at the given index, leaving the others in order', () => {
    expect(removeArrayElement(['a', 'b', 'c'], 1)).toEqual(['a', 'c']);
  });

  // Issue #168: same "index against this specific plugin's own array" concern as
  // moveArrayElement above — `Array.prototype.filter` already leaves the array's *content*
  // unchanged for an out-of-range index (no element has that index to drop), but it hands back a
  // new array reference regardless, which defeats a caller's reference-equality no-op check (the
  // same convention moveArrayElement's own boundary case already relies on, and
  // RecordPanel.handleArrayMove/handleArrayRemove use to skip staging a no-op edit).
  it('returns the same array reference, unchanged, when the index is out of bounds', () => {
    const arr = ['a', 'b'];
    expect(removeArrayElement(arr, 2)).toBe(arr);
    expect(removeArrayElement(arr, -1)).toBe(arr);
  });
});

// Issue #231: a VMAD ArrayOfObject reuses the generic array-add control now (its elementType is
// the new synthesized 'vmadObject' type) — needs its own default-value case, the (formKey, alias)
// pair VmadSection's own defaultElementValue('Object') always started a fresh element with.
describe('defaultElementValue — vmadObject (issue #231)', () => {
  it('defaults a vmadObject element to an empty formKey and alias -1', () => {
    expect(defaultElementValue({ name: '', type: 'vmadObject', isArray: false, validFormKeyTypes: [], enumValues: [] }))
      .toEqual({ formKey: '', alias: -1 });
  });
});

describe('defaultElementValue — explicit override (issue #231)', () => {
  it('returns the override verbatim instead of deriving one from `type`', () => {
    const meta: FieldMetadata = {
      name: '', type: 'struct', isArray: false, validFormKeyTypes: [], enumValues: [],
      defaultValue: { function: 'GetIsID', operator: 'EqualTo' },
    };
    expect(defaultElementValue(meta)).toEqual({ function: 'GetIsID', operator: 'EqualTo' });
  });

  it('does not hand back a reference to the same override object on repeated calls', () => {
    const meta: FieldMetadata = {
      name: '', type: 'struct', isArray: false, validFormKeyTypes: [], enumValues: [],
      defaultValue: { parameters: [] as unknown[] },
    };
    const a = defaultElementValue(meta) as { parameters: unknown[] };
    const b = defaultElementValue(meta) as { parameters: unknown[] };
    a.parameters.push('mutated');
    expect(b.parameters).toEqual([]);
  });
});

describe('appendArrayElement', () => {
  it('appends the given value to the end of the array', () => {
    expect(appendArrayElement(['a', 'b'], 'c')).toEqual(['a', 'b', 'c']);
  });

  it('does not mutate the source array', () => {
    const source = ['a', 'b'];
    appendArrayElement(source, 'c');
    expect(source).toEqual(['a', 'b']);
  });
});

describe('arrayElementContext', () => {
  it('produces the data-vscode-context object for a middle element (can move either way)', () => {
    expect(arrayElementContext('000001:Fallout4.esm', 'MyMod.esp', 'ModA', 'Items', 1, 3)).toEqual({
      webviewSection: 'arrayElement',
      formKey: '000001:Fallout4.esm',
      plugin: 'MyMod.esp',
      origin: 'ModA',
      fieldName: 'Items',
      index: 1,
      canMoveUp: true,
      canMoveDown: true,
      preventDefaultContextMenuItems: true,
    });
  });

  // Issue #227 review: package.json's `when` clause gates Move Up/Move Down on these two flags
  // the same way it gates columnHeader.removeOverride on `!immutable` — a boundary element has
  // nothing to move onto, so the menu item must be absent there, not merely a no-op when clicked
  // (matching the AC's "absent, not disabled" principle for sorted arrays).
  it('canMoveUp is false for the first element', () => {
    expect(arrayElementContext('000001:Fallout4.esm', 'MyMod.esp', 'ModA', 'Items', 0, 3).canMoveUp).toBe(false);
  });

  it('canMoveDown is false for the last element', () => {
    expect(arrayElementContext('000001:Fallout4.esm', 'MyMod.esp', 'ModA', 'Items', 2, 3).canMoveDown).toBe(false);
  });

  // Issue #168: a row's index comes from the union-aligned tree across every plugin's column, not
  // from this one plugin's own array — `arrayLength` is *this* plugin's real length (DiffRow
  // passes arrayEdit.currentArray(plugin).length), so an index at or past it means this plugin
  // doesn't have an element there at all. Move Up must be absent (not merely a no-op), same
  // "absent, not disabled" convention the first/last-element cases above already enforce.
  it('canMoveUp is false when index is at or past this plugin\'s own array length', () => {
    expect(arrayElementContext('000001:Fallout4.esm', 'MyMod.esp', 'ModA', 'Items', 1, 1).canMoveUp).toBe(false);
    expect(arrayElementContext('000001:Fallout4.esm', 'MyMod.esp', 'ModA', 'Items', 2, 1).canMoveUp).toBe(false);
  });
});

describe('arrayParentContext', () => {
  it('produces the data-vscode-context object for an array-parent cell', () => {
    expect(arrayParentContext('000001:Fallout4.esm', 'MyMod.esp', 'ModA', 'Items')).toEqual({
      webviewSection: 'arrayParent',
      formKey: '000001:Fallout4.esm',
      plugin: 'MyMod.esp',
      origin: 'ModA',
      fieldName: 'Items',
      preventDefaultContextMenuItems: true,
    });
  });
});

describe('vmadScriptsContext / vmadScriptContext / vmadPropertyContext', () => {
  it('vmadScriptsContext identifies the "Scripts (VMAD)" wrapper row', () => {
    expect(vmadScriptsContext('000001:Fallout4.esm', 'MyMod.esp', 'ModA')).toEqual({
      webviewSection: 'vmadScripts', formKey: '000001:Fallout4.esm', plugin: 'MyMod.esp', origin: 'ModA',
      preventDefaultContextMenuItems: true,
    });
  });

  it('vmadScriptContext identifies a script row, carrying its current flags for the QuickPick seed', () => {
    expect(vmadScriptContext('000001:Fallout4.esm', 'MyMod.esp', 'ModA', 'MyScript', 'Local')).toEqual({
      webviewSection: 'vmadScript', formKey: '000001:Fallout4.esm', plugin: 'MyMod.esp', origin: 'ModA', scriptName: 'MyScript',
      currentFlags: 'Local', preventDefaultContextMenuItems: true,
    });
  });

  it('vmadScriptContext carries a null currentFlags when the column has no disk value', () => {
    expect(vmadScriptContext('000001:Fallout4.esm', 'MyMod.esp', 'ModA', 'MyScript', null)).toEqual({
      webviewSection: 'vmadScript', formKey: '000001:Fallout4.esm', plugin: 'MyMod.esp', origin: 'ModA', scriptName: 'MyScript',
      currentFlags: null, preventDefaultContextMenuItems: true,
    });
  });

  it('vmadPropertyContext identifies a property row', () => {
    expect(vmadPropertyContext('000001:Fallout4.esm', 'MyMod.esp', 'ModA', 'MyScript', 'Health')).toEqual({
      webviewSection: 'vmadProperty', formKey: '000001:Fallout4.esm', plugin: 'MyMod.esp', origin: 'ModA',
      scriptName: 'MyScript', propName: 'Health', preventDefaultContextMenuItems: true,
    });
  });
});

// Issue #231 (review): a row can be more than one structural-op target at once (a VMAD
// array-of-scalars property is both an array parent/element and a VMAD property) — combining
// contexts rather than picking one is what makes both menus reachable from the same cell.
describe('combineVscodeContexts', () => {
  it('returns undefined when every context is absent', () => {
    expect(combineVscodeContexts(undefined, undefined)).toBeUndefined();
  });

  it('passes a single context through, still as a JSON string (an unchanged call site contract)', () => {
    const result = combineVscodeContexts(arrayParentContext('000001:Fallout4.esm', 'MyMod.esp', 'ModA', 'Items'));
    expect(JSON.parse(result!)).toEqual({
      webviewSection: 'arrayParent', formKey: '000001:Fallout4.esm', plugin: 'MyMod.esp', origin: 'ModA', fieldName: 'Items',
      preventDefaultContextMenuItems: true,
    });
  });

  it('combines two contexts\' webviewSection into one space-separated token list', () => {
    const result = combineVscodeContexts(
      arrayParentContext('000001:Fallout4.esm', 'MyMod.esp', 'ModA', String.raw`VMAD\S\Levels`),
      vmadPropertyContext('000001:Fallout4.esm', 'MyMod.esp', 'ModA', 'S', 'Levels'),
    );
    const parsed = JSON.parse(result!);
    expect(parsed.webviewSection).toBe('arrayParent vmadProperty');
  });

  it('merges every other key from both contexts (so package.json\'s when clauses can read either)', () => {
    const result = combineVscodeContexts(
      arrayParentContext('000001:Fallout4.esm', 'MyMod.esp', 'ModA', String.raw`VMAD\S\Levels`),
      vmadPropertyContext('000001:Fallout4.esm', 'MyMod.esp', 'ModA', 'S', 'Levels'),
    );
    const parsed = JSON.parse(result!);
    expect(parsed.scriptName).toBe('S');
    expect(parsed.propName).toBe('Levels');
    expect(parsed.fieldName).toBe(String.raw`VMAD\S\Levels`);
  });

  it('skips an absent context among present ones', () => {
    const result = combineVscodeContexts(undefined, arrayParentContext('000001:Fallout4.esm', 'MyMod.esp', 'ModA', 'Items'), undefined);
    expect(JSON.parse(result!).webviewSection).toBe('arrayParent');
  });
});

// Issue #231: the generic path-based node accessors that replace RecordPanel/DiffRow's old
// hand-built top-level/array-element/struct-child/grandchild special cases — one recursive
// implementation for a row's value at any depth within the field/wire-path it restages as one
// atomic unit, rather than one hand-coded case per nesting level.
describe('getAtPath', () => {
  it('returns the root itself for an empty path', () => {
    expect(getAtPath({ X: 1 }, [])).toEqual({ X: 1 });
  });

  it('reads a struct member', () => {
    const path: PathSegment[] = [{ kind: 'member', name: 'X' }];
    expect(getAtPath({ X: 1, Y: 2 }, path)).toBe(1);
  });

  it('reads a positional array element', () => {
    const path: PathSegment[] = [{ kind: 'index', index: 1 }];
    expect(getAtPath(['a', 'b', 'c'], path)).toBe('b');
  });

  it('reads a sorted-array element (the segment key is the value itself)', () => {
    const path: PathSegment[] = [{ kind: 'sortKey', key: 'KwdB' }];
    expect(getAtPath(['KwdA', 'KwdB'], path)).toBe('KwdB');
  });

  // Struct-in-array-in-struct: a depth the old RowContext union (top-level/array-element/
  // struct-child/grandchild) could never express at all.
  it('reads through a member → index → member chain (depth previously unrepresentable)', () => {
    const path: PathSegment[] = [
      { kind: 'member', name: 'Outer' },
      { kind: 'index', index: 1 },
      { kind: 'member', name: 'Inner' },
    ];
    const root = { Outer: [{ Inner: 'a' }, { Inner: 'b' }] };
    expect(getAtPath(root, path)).toBe('b');
  });

  it('returns undefined when a member is missing', () => {
    expect(getAtPath({}, [{ kind: 'member', name: 'X' }])).toBeUndefined();
  });
});

describe('setAtPath', () => {
  it('replaces the root itself for an empty path', () => {
    expect(setAtPath({ X: 1 }, [], { X: 99 })).toEqual({ X: 99 });
  });

  it('sets a struct member, preserving siblings', () => {
    const path: PathSegment[] = [{ kind: 'member', name: 'X' }];
    expect(setAtPath({ X: 1, Y: 2 }, path, 99)).toEqual({ X: 99, Y: 2 });
  });

  it('sets a positional array element, preserving siblings', () => {
    const path: PathSegment[] = [{ kind: 'index', index: 1 }];
    expect(setAtPath(['a', 'b', 'c'], path, 'B')).toEqual(['a', 'B', 'c']);
  });

  it('sets a sorted-array element by matching its old value', () => {
    const path: PathSegment[] = [{ kind: 'sortKey', key: 'KwdB' }];
    expect(setAtPath(['KwdA', 'KwdB'], path, 'KwdZ')).toEqual(['KwdA', 'KwdZ']);
  });

  it('sets through a member → index → member chain, preserving every sibling along the way', () => {
    const path: PathSegment[] = [
      { kind: 'member', name: 'Outer' },
      { kind: 'index', index: 1 },
      { kind: 'member', name: 'Inner' },
    ];
    const root = { Extra: 'kept', Outer: [{ Inner: 'a', Also: 'kept0' }, { Inner: 'b', Also: 'kept1' }] };
    expect(setAtPath(root, path, 'B')).toEqual({
      Extra: 'kept',
      Outer: [{ Inner: 'a', Also: 'kept0' }, { Inner: 'B', Also: 'kept1' }],
    });
  });

  it('does not mutate the source root', () => {
    const root = { Outer: [{ Inner: 'a' }] };
    const path: PathSegment[] = [{ kind: 'member', name: 'Outer' }, { kind: 'index', index: 0 }, { kind: 'member', name: 'Inner' }];
    setAtPath(root, path, 'z');
    expect(root).toEqual({ Outer: [{ Inner: 'a' }] });
  });
});

// Issue #114: mirrors MEditService.Core/Queries/ConflictRules.cs's Reduce, used by
// vmadTreeAdapter.ts/conditionTreeAdapter.ts to compute their own synthesized FieldDiff nodes'
// bottom-up conflictAll.
describe('reduceConflictAll', () => {
  it('returns NoConflict for no cell states', () => {
    expect(reduceConflictAll([])).toBe('NoConflict');
  });

  it('returns NoConflict when every state is IdenticalToMaster', () => {
    expect(reduceConflictAll(['IdenticalToMaster', 'IdenticalToMaster'])).toBe('NoConflict');
  });

  it('returns Override when the worst state is an uncontested Override', () => {
    expect(reduceConflictAll(['IdenticalToMaster', 'Override'])).toBe('Override');
  });

  it('returns Conflict when any state is ConflictWins', () => {
    expect(reduceConflictAll(['Override', 'ConflictWins'])).toBe('Conflict');
  });

  it('returns Conflict when any state is ConflictLoses', () => {
    expect(reduceConflictAll(['ConflictLoses'])).toBe('Conflict');
  });
});

describe('aggregateConflictAll', () => {
  it('reduces just the own cell states when there are no children', () => {
    expect(aggregateConflictAll({ 'MyMod.esp': 'Override' })).toBe('Override');
  });

  it('reduces just the own cell states when children is undefined or empty', () => {
    expect(aggregateConflictAll({}, undefined)).toBe('NoConflict');
    expect(aggregateConflictAll({}, [])).toBe('NoConflict');
  });

  // The literal #114 requirement at the adapter seam: a struct/array node with no conflict of its
  // own still escalates to the worse of its children — collapsing it must not hide that something
  // inside differs.
  it('escalates from a conflicting child even when the node has no own-cell-state conflict', () => {
    expect(aggregateConflictAll({}, [{ conflictAll: 'Conflict' }, { conflictAll: 'NoConflict' }])).toBe('Conflict');
  });

  it('does not let an agreeing child pull the aggregate down below the node’s own state', () => {
    expect(aggregateConflictAll({ 'MyMod.esp': 'Override' }, [{ conflictAll: 'NoConflict' }])).toBe('Override');
  });

  it('a child with no conflictAll of its own contributes nothing (safe default)', () => {
    expect(aggregateConflictAll({}, [{ conflictAll: undefined }])).toBe('NoConflict');
  });
});
