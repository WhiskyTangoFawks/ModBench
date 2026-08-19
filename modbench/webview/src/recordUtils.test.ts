import '@testing-library/jest-dom';
import { describe, it, expect } from 'vitest';
import {
  buildColumns,
  readOnlyReason,
  collidingFilenames,
  parseElementIndex,
  pendingIfChanged,
  getAtPath,
  pendingValueAtPath,
  reduceConflictAll,
  aggregateConflictAll,
  type PathSegment,
} from './recordUtils';
import type { CompareOverride } from './types';

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
