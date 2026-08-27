import '@testing-library/jest-dom';
import { describe, it, expect } from 'vitest';
import {
  buildColumns,
  readOnlyReason,
  collidingFilenames,
  parseElementIndex,
  getAtPath,
  setAtPath,
  reduceConflictAll,
  aggregateConflictAll,
  hasElementAt,
  moveArrayElement,
  removeArrayElement,
  appendArrayElement,
  arrayElementContext,
  arrayParentContext,
  combineVscodeContexts,
  vmadScriptsContext,
  vmadScriptContext,
  vmadPropertyContext,
  headerCellContext,
  stringValueContext,
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
  it('produces one disk column per override', () => {
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

  // #415 / ADR-0041: "editing requires tracking; viewing never does". A mutable, loaded plugin in
  // an untracked mod folder is read-only for a reason that is one command away from gone, which is
  // why it needs its own value rather than folding into the two above — each names a different way
  // out, and offering the wrong one is worse than offering none.
  it('is "untracked" for an otherwise editable column whose mod has no repository', () => {
    expect(readOnlyReason(false, true, false)).toBe('untracked');
  });

  it('is null once that same column is tracked', () => {
    expect(readOnlyReason(false, true, true)).toBeNull();
  });

  // Precedence, not an accident of ordering: a vanilla master cannot be tracked at all, so hearing
  // "run Track on it" would send the user somewhere that leads nowhere.
  it('prefers the reason the user cannot fix over the one they can', () => {
    expect(readOnlyReason(true, true, false)).toBe('vanillaMaster');
    expect(readOnlyReason(true, false, false)).toBe('notInLoadOrder');
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


// Issue #231: the generalized, path-based replacement for the old top-level/array-element/
// struct-child/grandchild switch DiffRow used to extract a row's own pending value out of the
// root's raw pending value — one implementation for every depth, including depths the old switch
// could not express (a struct nested more than one level deep, or a member below an array below a
// member). Supersedes the old extractPendingElementValue (array-element case) and the struct-
// child/grandchild cases the old DiffRow switch hand-rolled directly — deleted along with its own
// call site, now that this one function covers every depth those three used to split across.


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

// #426 Track 4 (resurrected from before #410, git history b1992bf~1): the pure array-arity/order
// mutations behind Move Up/Move Down/Remove/Add.
describe('hasElementAt', () => {
  it('is true within bounds, false at or past length, false for a negative index', () => {
    expect(hasElementAt(3, 0)).toBe(true);
    expect(hasElementAt(3, 2)).toBe(true);
    expect(hasElementAt(3, 3)).toBe(false);
    expect(hasElementAt(3, -1)).toBe(false);
  });
});

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

  // Issue #168: `index` itself, not just the swap target, must be bounds-checked — a row's index
  // comes from the union-aligned tree across every plugin's column and can equal or exceed *this
  // specific plugin's* own array length even though the swap target alone looks in range.
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

  it('returns the same array reference, unchanged, when the index is out of bounds', () => {
    const arr = ['a', 'b'];
    expect(removeArrayElement(arr, 2)).toBe(arr);
    expect(removeArrayElement(arr, -1)).toBe(arr);
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

  it('canMoveUp is false for the first element', () => {
    expect(arrayElementContext('000001:Fallout4.esm', 'MyMod.esp', 'ModA', 'Items', 0, 3).canMoveUp).toBe(false);
  });

  it('canMoveDown is false for the last element', () => {
    expect(arrayElementContext('000001:Fallout4.esm', 'MyMod.esp', 'ModA', 'Items', 2, 3).canMoveDown).toBe(false);
  });

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

// Issue #231 (review): a row can be more than one structural-op target at once (a VMAD
// array-of-scalars property is both an array parent/element and a VMAD property) — combining
// contexts rather than picking one is what makes both menus reachable from the same cell. Only
// arrayParent is exercised here today; VMAD's own context builders return with Track 5.
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

  it('skips an absent context among present ones', () => {
    const result = combineVscodeContexts(undefined, arrayParentContext('000001:Fallout4.esm', 'MyMod.esp', 'ModA', 'Items'), undefined);
    expect(JSON.parse(result!).webviewSection).toBe('arrayParent');
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

// #494: restores Copy as Override Into…/Copy as New Record Into… (#436) as the column header's own
// native context — unconditional on the column's own read-only-ness, since copying *from* an
// immutable/vanilla column is the headline use case, unlike every row-scoped context above.
describe('headerCellContext', () => {
  it('identifies the header cell, carrying the column\'s own record identity', () => {
    expect(headerCellContext('000001:Fallout4.esm', 'MyMod.esp', 'ModA')).toEqual({
      webviewSection: 'recordHeader', formKey: '000001:Fallout4.esm', plugin: 'MyMod.esp', origin: 'ModA',
      preventDefaultContextMenuItems: true,
    });
  });

  it('combines like every other context, for a header cell that one day carries more than one', () => {
    const result = combineVscodeContexts(headerCellContext('000001:Fallout4.esm', 'MyMod.esp', 'ModA'));
    expect(JSON.parse(result!)).toEqual({
      webviewSection: 'recordHeader', formKey: '000001:Fallout4.esm', plugin: 'MyMod.esp', origin: 'ModA',
      preventDefaultContextMenuItems: true,
    });
  });
});

// #258 / ADR-0039: the string-cell right-click menu's own identity — the extended editor's only
// remaining trigger now that no left-click gesture reaches it.
describe('stringValueContext', () => {
  it('carries the cell\'s own identity, current value and readOnly flag', () => {
    expect(stringValueContext('000001:Fallout4.esm', 'MyMod.esp', 'ModA', 'Name', 'Dogmeat', false)).toEqual({
      webviewSection: 'stringValue',
      formKey: '000001:Fallout4.esm',
      plugin: 'MyMod.esp',
      origin: 'ModA',
      fieldName: 'Name',
      value: 'Dogmeat',
      readOnly: false,
      preventDefaultContextMenuItems: true,
    });
  });

  it('carries readOnly: true for an immutable/untracked/not-in-load-order column unchanged', () => {
    expect(stringValueContext('000001:Fallout4.esm', 'Fallout4.esm', 'Data', 'Name', 'Dogmeat', true).readOnly).toBe(true);
  });

  it('combines like every other context', () => {
    const result = combineVscodeContexts(stringValueContext('000001:Fallout4.esm', 'MyMod.esp', 'ModA', 'Name', 'Dogmeat', false));
    expect(JSON.parse(result!)).toEqual({
      webviewSection: 'stringValue', formKey: '000001:Fallout4.esm', plugin: 'MyMod.esp', origin: 'ModA',
      fieldName: 'Name', value: 'Dogmeat', readOnly: false, preventDefaultContextMenuItems: true,
    });
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
