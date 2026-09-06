import '@testing-library/jest-dom';
import { describe, it, expect } from 'vitest';
import {
  buildColumns,
  columnStatus,
  collidingFilenames,
  elementSegment,
  isArrayElementHop,
  isMovableElementHop,
  getAtPath,
  wirePath,
  arrayElementContext,
  arrayParentContext,
  combineVscodeContexts,
  headerCellContext,
  stringValueContext,
  metaAtPath,
  type PathHop,
  type PathSegment,
} from './recordUtils';
import type { CompareOverride, FieldMetadata } from './types';

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
    recordType: 'npc_',
    isPartialForm: false,
    isPartialFormable: false,
    ...extra,
  };
}

// One column per CompareOverride, in the wire's own load order — master leftmost, winner
// rightmost, as in xEdit — trusted as sent rather than re-sorted here.
describe('buildColumns', () => {
  it('returns one column per override, in response order', () => {
    const cols = buildColumns([
      makeOverride('Fallout4.esm', { loadOrderIndex: 0 }),
      makeOverride('Patch.esp', { loadOrderIndex: 3 }),
      makeOverride('MyMod.esp', { loadOrderIndex: 7, isWinner: true }),
    ]);
    expect(cols.map(c => c.override.plugin)).toEqual(['Fallout4.esm', 'Patch.esp', 'MyMod.esp']);
  });

  // ADR-0036: two loaded copies sharing a filename are two columns with distinct keys — the
  // compound (plugin, origin) identity is minted here, once, for every consumer.
  it('keys same-filename columns by compound identity', () => {
    const cols = buildColumns([
      makeOverride('Shared.esp', { origin: 'ModA', loadOrderIndex: 1 }),
      makeOverride('Shared.esp', { origin: 'ModB', loadOrderIndex: 1 }),
    ]);
    expect(cols).toHaveLength(2);
    expect(new Set(cols.map(c => c.key)).size).toBe(2);
  });

  it('returns no columns for an empty override list', () => {
    expect(buildColumns([])).toEqual([]);
  });
});

// ADR-0044: `immutableSet` alone can't tell a vanilla master from a copy the load order does
// not name, and the header needs both facts to word the tooltip and decide whether to dim.
describe('columnStatus', () => {
  it('is "tracked" for a mutable, tracked column, regardless of inLoadOrder', () => {
    expect(columnStatus(false, true)).toBe('tracked');
    expect(columnStatus(false, false)).toBe('tracked');
  });

  it('is "vanillaMaster" for an immutable column still named by the load order', () => {
    expect(columnStatus(true, true)).toBe('vanillaMaster');
  });

  it('is "notInLoadOrder" for an immutable column the load order does not name', () => {
    expect(columnStatus(true, false)).toBe('notInLoadOrder');
  });

  // ADR-0041: editing requires tracking, viewing never does. This status earns its own value
  // because each names a different way out, and offering the wrong one is worse than none.
  it('is "untracked" for an otherwise editable column whose mod has no repository', () => {
    expect(columnStatus(false, true, false)).toBe('untracked');
  });

  it('is "tracked" once that same column is tracked', () => {
    expect(columnStatus(false, true, true)).toBe('tracked');
  });

  // Precedence, not an accident of ordering: a vanilla master cannot be tracked at all, so hearing
  // "run Track on it" would send the user somewhere that leads nowhere.
  it('prefers the reason the user cannot fix over the one they can', () => {
    expect(columnStatus(true, true, false)).toBe('vanillaMaster');
    expect(columnStatus(true, false, false)).toBe('notInLoadOrder');
  });
});

// ADR-0036: origin inline only on collision, computed from the overrides one compare response
// already carries, never from the load order's whole plugin list.
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

// How the backend labelled a child is what says how to address it — both answers come from the
// same array metadata, and the key text travels exactly as the diff node states it.
describe('elementSegment', () => {
  const element = (extra: Partial<FieldMetadata> = {}): FieldMetadata =>
    ({ name: '', type: 'struct', isArray: false, validFormKeyTypes: [], enumMembers: [], ...extra });
  const array = (extra: Partial<FieldMetadata>): FieldMetadata =>
    ({ name: 'A', type: 'array', isArray: true, validFormKeyTypes: [], enumMembers: [], ...extra });

  it('addresses a keyed array\'s child by the key text it is labelled with, verbatim', () => {
    expect(elementSegment(array({ keyMembers: ['stage', 'stage_index'], elementType: element() }), '10 / 0', 0))
      .toEqual({ kind: 'key', key: '10 / 0' });
  });

  it('addresses a pure-FormLink array\'s child by the element value', () => {
    expect(elementSegment(array({ elementType: element({ type: 'formKey', isSortable: true }) }), 'KwdA', 0))
      .toEqual({ kind: 'value', value: 'KwdA' });
  });

  // The child's place among its siblings is its position; the "[N]" label is never read back.
  it('addresses every other array\'s child by its place among the array\'s children', () => {
    expect(elementSegment(array({ elementType: element() }), '[2]', 2)).toEqual({ kind: 'index', index: 2 });
    expect(elementSegment(array({ elementType: element() }), 'anything', 5)).toEqual({ kind: 'index', index: 5 });
  });
});

// One rule, since the panel's handler wiring, the cell menu and the native menu all ask it.
describe('isArrayElementHop / isMovableElementHop', () => {
  it('a positional element offers Remove and both Moves', () => {
    const seg: PathSegment = { kind: 'index', index: 0 };
    expect(isArrayElementHop(seg)).toBe(true);
    expect(isMovableElementHop(seg)).toBe(true);
  });

  // A keyed array is stored in key order on every write (Edits/KeyedArrays.cs), so no Move there
  // could change the file.
  it('a keyed element offers Remove but no Move', () => {
    const seg: PathSegment = { kind: 'key', key: 'Guard' };
    expect(isArrayElementHop(seg)).toBe(true);
    expect(isMovableElementHop(seg)).toBe(false);
  });

  it('a sorted element and a struct member offer neither', () => {
    for (const seg of [{ kind: 'value', value: 'KwdA' }, { kind: 'member', name: 'X' }] as PathSegment[]) {
      expect(isArrayElementHop(seg)).toBe(false);
      expect(isMovableElementHop(seg)).toBe(false);
    }
    expect(isArrayElementHop(undefined)).toBe(false);
  });
});

// One recursive reader for a row's value at any depth, which the presentation table and the
// sorted-array hop both read through.
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

  it('reads a sorted-array element (the segment value is the element itself)', () => {
    const path: PathSegment[] = [{ kind: 'value', value: 'KwdB' }];
    expect(getAtPath(['KwdA', 'KwdB'], path)).toBe('KwdB');
  });

  // One path serves every column, and a column that does not carry this keyword has nothing here —
  // answering the key regardless would read as if it did.
  it('reads nothing for a sorted-array element this column does not carry', () => {
    expect(getAtPath(['KwdA'], [{ kind: 'value', value: 'KwdB' }])).toBeUndefined();
  });

  // Which element a key names is the backend's to resolve (Queries/ElementKey.cs); the webview
  // holds no mirror of that rule, so a key hop reads nothing here.
  it('reads nothing through a key hop', () => {
    const path: PathSegment[] = [{ kind: 'key', key: 'Guard' }, { kind: 'member', name: 'flags' }];
    expect(getAtPath([{ name: 'Guard', flags: 'g' }], path)).toBeUndefined();
  });

  // Struct-in-array-in-struct: a depth a fixed-level union could never express.
  it('reads through a member → index → member chain (struct-in-array-in-struct depth)', () => {
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

// `path` is the envelope's own wire path, never a bare scalar index: an array nested inside a
// struct needs every hop. `canMoveUp`/`canMoveDown` read the last hop.
describe('arrayElementContext', () => {
  it('produces the data-vscode-context object for a middle element (can move either way)', () => {
    const path: PathHop[] = [{ kind: 'member', name: 'Items' }, { kind: 'index', index: 1 }];
    expect(arrayElementContext('000001:Fallout4.esm', 'MyMod.esp', 'ModA', path, 3)).toEqual({
      webviewSection: 'arrayElement',
      formKey: '000001:Fallout4.esm',
      plugin: 'MyMod.esp',
      origin: 'ModA',
      path,
      canMoveUp: true,
      canMoveDown: true,
      preventDefaultContextMenuItems: true,
    });
  });

  it('canMoveUp is false for the first element', () => {
    const path: PathHop[] = [{ kind: 'member', name: 'Items' }, { kind: 'index', index: 0 }];
    expect(arrayElementContext('000001:Fallout4.esm', 'MyMod.esp', 'ModA', path, 3).canMoveUp).toBe(false);
  });

  it('canMoveDown is false for the last element', () => {
    const path: PathHop[] = [{ kind: 'member', name: 'Items' }, { kind: 'index', index: 2 }];
    expect(arrayElementContext('000001:Fallout4.esm', 'MyMod.esp', 'ModA', path, 3).canMoveDown).toBe(false);
  });

  // A keyed array is stored in key order on every write, so neither Move could change the file;
  // Remove still applies, which is why the row carries this context at all.
  it('offers neither Move on a keyed element, and still offers the element itself', () => {
    const path: PathHop[] = [{ kind: 'member', name: 'Scripts' }, { kind: 'key', key: 'Guard' }];
    const context = arrayElementContext('000001:Fallout4.esm', 'MyMod.esp', 'ModA', path, 3);
    expect(context.canMoveUp).toBe(false);
    expect(context.canMoveDown).toBe(false);
    expect(context.webviewSection).toBe('arrayElement');
    expect(context.path).toBe(path);
  });

  it('canMoveUp is false when index is at or past this plugin\'s own array length', () => {
    expect(arrayElementContext(
      '000001:Fallout4.esm', 'MyMod.esp', 'ModA', [{ kind: 'member', name: 'Items' }, { kind: 'index', index: 1 }], 1,
    ).canMoveUp).toBe(false);
    expect(arrayElementContext(
      '000001:Fallout4.esm', 'MyMod.esp', 'ModA', [{ kind: 'member', name: 'Items' }, { kind: 'index', index: 2 }], 1,
    ).canMoveUp).toBe(false);
  });

  // canMoveUp/canMoveDown must key off the last hop, not path.length, and the full chain must
  // survive onto the payload rather than collapse to the trailing index.
  it('a nested element carries every hop of its own path, and canMoveUp/canMoveDown read the last one', () => {
    const path: PathHop[] = [{ kind: 'member', name: 'Container' }, { kind: 'member', name: 'Sub' }, { kind: 'index', index: 0 }];
    const ctx = arrayElementContext('000001:Fallout4.esm', 'MyMod.esp', 'ModA', path, 2);
    expect(ctx.path).toEqual(path);
    expect(ctx.canMoveUp).toBe(false); // last hop's index is 0
    expect(ctx.canMoveDown).toBe(true);
  });
});

describe('arrayParentContext', () => {
  it('produces the data-vscode-context object for a top-level array-parent cell (one member hop)', () => {
    expect(arrayParentContext('000001:Fallout4.esm', 'MyMod.esp', 'ModA', [{ kind: 'member', name: 'Items' }])).toEqual({
      webviewSection: 'arrayParent',
      formKey: '000001:Fallout4.esm',
      plugin: 'MyMod.esp',
      origin: 'ModA',
      path: [{ kind: 'member', name: 'Items' }],
      preventDefaultContextMenuItems: true,
    });
  });

  // A nested array's "Add" must address the array itself, which is more hops than the record's
  // own member.
  it('carries every hop down to a nested array-parent cell', () => {
    const path: PathHop[] = [{ kind: 'member', name: 'Container' }, { kind: 'member', name: 'Entries' }];
    const ctx = arrayParentContext('000001:Fallout4.esm', 'MyMod.esp', 'ModA', path);
    expect(ctx.path).toEqual(path);
  });
});

// A row can be more than one structural-op target at once, so combining contexts rather than
// picking one is what makes both menus reachable from the same cell.
describe('combineVscodeContexts', () => {
  const TAGS_PATH: PathHop[] = [{ kind: 'member', name: 'tags' }, { kind: 'index', index: 0 }];

  it('returns undefined when every context is absent', () => {
    expect(combineVscodeContexts(undefined, undefined)).toBeUndefined();
  });

  it('passes a single context through, still as a JSON string (an unchanged call site contract)', () => {
    const result = combineVscodeContexts(arrayParentContext('000001:Fallout4.esm', 'MyMod.esp', 'ModA', [{ kind: 'member', name: 'Items' }]));
    expect(JSON.parse(result!)).toEqual({
      webviewSection: 'arrayParent', formKey: '000001:Fallout4.esm', plugin: 'MyMod.esp', origin: 'ModA',
      path: [{ kind: 'member', name: 'Items' }],
      preventDefaultContextMenuItems: true,
    });
  });

  it('skips an absent context among present ones', () => {
    const result = combineVscodeContexts(undefined, arrayParentContext('000001:Fallout4.esm', 'MyMod.esp', 'ModA', [{ kind: 'member', name: 'Items' }]), undefined);
    expect(JSON.parse(result!).webviewSection).toBe('arrayParent');
  });

  it('combines two contexts\' webviewSection into one space-separated token list', () => {
    const result = combineVscodeContexts(
      arrayElementContext('000001:Fallout4.esm', 'MyMod.esp', 'ModA', TAGS_PATH, 2),
      stringValueContext('000001:Fallout4.esm', 'MyMod.esp', 'ModA', 'Dogmeat [000001:Fallout4.esm]', 'tags', 'a', false, TAGS_PATH),
    );
    const parsed = JSON.parse(result!);
    expect(parsed.webviewSection).toBe('arrayElement stringValue');
  });

  it('merges every other key from both contexts (so package.json\'s when clauses can read either)', () => {
    const result = combineVscodeContexts(
      arrayElementContext('000001:Fallout4.esm', 'MyMod.esp', 'ModA', TAGS_PATH, 2),
      stringValueContext('000001:Fallout4.esm', 'MyMod.esp', 'ModA', 'Dogmeat [000001:Fallout4.esm]', 'tags', 'a', false, TAGS_PATH),
    );
    const parsed = JSON.parse(result!);
    expect(parsed.canMoveDown).toBe(true);
    expect(parsed.value).toBe('a');
    expect(parsed.path).toEqual(TAGS_PATH);
  });
});

// Unconditional on the column's read-only-ness, since copying from an immutable column is the
// headline use case, unlike every row-scoped context above.
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

// ADR-0039: the string-cell right-click menu's own identity — the extended editor's only
// trigger, since no left-click gesture reaches it.
describe('stringValueContext', () => {
  const NAME_PATH: PathHop[] = [{ kind: 'member', name: 'Name' }];

  it('carries the cell\'s own identity, record label, current value and readOnly flag', () => {
    expect(stringValueContext(
      '000001:Fallout4.esm', 'MyMod.esp', 'ModA', 'Dogmeat [000001:Fallout4.esm]', 'Name', 'Dogmeat', false, NAME_PATH,
    )).toEqual({
      webviewSection: 'stringValue',
      formKey: '000001:Fallout4.esm',
      plugin: 'MyMod.esp',
      origin: 'ModA',
      recordLabel: 'Dogmeat [000001:Fallout4.esm]',
      fieldName: 'Name',
      value: 'Dogmeat',
      readOnly: false,
      path: NAME_PATH,
      preventDefaultContextMenuItems: true,
    });
  });

  it('carries readOnly: true for an immutable/untracked/not-in-load-order column unchanged', () => {
    expect(stringValueContext(
      '000001:Fallout4.esm', 'Fallout4.esm', 'Data', 'Dogmeat', 'Name', 'Dogmeat', true, NAME_PATH,
    ).readOnly).toBe(true);
  });

  // A nested string leaf's set envelope lands at its own hops, not the member it sits under.
  it('carries every hop of a nested string leaf\'s wire path', () => {
    const path: PathHop[] = [
      { kind: 'member', name: 'Container' }, { kind: 'member', name: 'Entries' },
      { kind: 'index', index: 0 }, { kind: 'member', name: 'Id' },
    ];
    expect(stringValueContext('000001:Fallout4.esm', 'MyMod.esp', 'ModA', 'Dogmeat', 'Id', 'A', false, path).path)
      .toEqual(path);
  });

  it('combines like every other context', () => {
    const result = combineVscodeContexts(
      stringValueContext('000001:Fallout4.esm', 'MyMod.esp', 'ModA', 'Dogmeat', 'Name', 'Dogmeat', false, NAME_PATH),
    );
    expect(JSON.parse(result!)).toEqual({
      webviewSection: 'stringValue', formKey: '000001:Fallout4.esm', plugin: 'MyMod.esp', origin: 'ModA',
      recordLabel: 'Dogmeat', fieldName: 'Name', value: 'Dogmeat', readOnly: false, path: NAME_PATH,
      preventDefaultContextMenuItems: true,
    });
  });
});

// The envelope's path is the row's hops under the record's own member; the one hop the backend
// cannot take — a sorted array's element, named by its value — becomes that value's position in
// the written column.
describe('wirePath', () => {
  it('leads with the root member and carries member, index and key hops as they are', () => {
    const path: PathSegment[] = [
      { kind: 'member', name: 'Scripts' }, { kind: 'key', key: '10 / 0' },
      { kind: 'member', name: 'Properties' }, { kind: 'index', index: 2 },
    ];
    expect(wirePath('VirtualMachineAdapter', path, undefined)).toEqual([
      { kind: 'member', name: 'VirtualMachineAdapter' }, ...path,
    ]);
  });

  it('is the one member hop for a top-level row', () => {
    expect(wirePath('Level', [], 4)).toEqual([{ kind: 'member', name: 'Level' }]);
  });

  // Two columns hold the same keyword at different positions, so the answer is per column.
  it('turns a sorted element into its position in the given column\'s own array', () => {
    const path: PathSegment[] = [{ kind: 'value', value: 'KwdC' }];
    expect(wirePath('Keywords', path, ['KwdA', 'KwdC'])).toEqual([{ kind: 'member', name: 'Keywords' }, { kind: 'index', index: 1 }]);
    expect(wirePath('Keywords', path, ['KwdC'])).toEqual([{ kind: 'member', name: 'Keywords' }, { kind: 'index', index: 0 }]);
  });

  it('resolves a sorted element nested under member hops against the node those hops reach', () => {
    const path: PathSegment[] = [{ kind: 'member', name: 'Keywords' }, { kind: 'value', value: 'KwdB' }];
    expect(wirePath('Data', path, { Keywords: ['KwdA', 'KwdB'] }))
      .toEqual([{ kind: 'member', name: 'Data' }, { kind: 'member', name: 'Keywords' }, { kind: 'index', index: 1 }]);
  });
});

// A collapsed row's prose summary has only a path, never a render-time `overrideMeta`, so it
// descends FieldMetadata itself to reach a nested array's element type.
describe('metaAtPath', () => {
  const idMeta: FieldMetadata = { name: 'Id', type: 'string', isArray: false, validFormKeyTypes: [], enumMembers: [] };
  const weightMeta: FieldMetadata = { name: 'Weight', type: 'int', isArray: false, validFormKeyTypes: [], enumMembers: [] };
  const entryMeta: FieldMetadata = {
    name: '', type: 'struct', isArray: false, validFormKeyTypes: [], enumMembers: [], fields: [idMeta, weightMeta],
  };
  const entriesMeta: FieldMetadata = {
    name: 'Entries', type: 'array', isArray: true, validFormKeyTypes: [], enumMembers: [], elementType: entryMeta,
  };
  const containerMeta: FieldMetadata = {
    name: 'Container', type: 'struct', isArray: false, validFormKeyTypes: [], enumMembers: [], fields: [entriesMeta],
  };

  it('returns the root meta itself for an empty path', () => {
    expect(metaAtPath(entriesMeta, [])).toBe(entriesMeta);
  });

  it('descends a struct member via .fields', () => {
    expect(metaAtPath(containerMeta, [{ kind: 'member', name: 'Entries' }])).toBe(entriesMeta);
  });

  it('descends an array index via .elementType', () => {
    expect(metaAtPath(entriesMeta, [{ kind: 'index', index: 0 }])).toBe(entryMeta);
  });

  it('descends a value hop via .elementType, same as index', () => {
    expect(metaAtPath(entriesMeta, [{ kind: 'value', value: 'anything' }])).toBe(entryMeta);
  });

  it('descends a key hop via .elementType, same as index', () => {
    expect(metaAtPath(entriesMeta, [{ kind: 'key', key: 'anything' }])).toBe(entryMeta);
  });

  // A nested array's own element type, reached through a member chain from the subtree root.
  it('finds a nested array\'s own element type through a member chain', () => {
    const path: PathSegment[] = [{ kind: 'member', name: 'Entries' }];
    expect(metaAtPath(containerMeta, path)?.elementType).toBe(entryMeta);
  });

  it('returns undefined when a member is missing, rather than throwing', () => {
    expect(metaAtPath(containerMeta, [{ kind: 'member', name: 'Missing' }])).toBeUndefined();
  });

  it('returns undefined when the root meta itself is undefined', () => {
    expect(metaAtPath(undefined, [{ kind: 'member', name: 'X' }])).toBeUndefined();
  });
});
