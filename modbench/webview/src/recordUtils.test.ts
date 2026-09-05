import '@testing-library/jest-dom';
import { describe, it, expect } from 'vitest';
import {
  buildColumns,
  columnStatus,
  collidingFilenames,
  parseElementIndex,
  elementKeyText,
  keyedElementIndex,
  elementSegment,
  isArrayElementHop,
  isMovableElementHop,
  getAtPath,
  setAtPath,
  arrayElementContext,
  arrayParentContext,
  combineVscodeContexts,
  headerCellContext,
  stringValueContext,
  metaAtPath,
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

describe('parseElementIndex', () => {
  it('parses the numeric index out of an "[N]" field name', () => {
    expect(parseElementIndex('[0]')).toBe(0);
    expect(parseElementIndex('[12]')).toBe(12);
  });
});

// A keyed array's row label is what the path has to carry, rendered the way the backend renders
// it (Queries/ElementKey.cs), since the two texts have to agree exactly.
describe('elementKeyText', () => {
  it('reads a string member', () => {
    expect(elementKeyText({ name: 'Ambush', flags: 'Local' }, ['name'])).toBe('Ambush');
  });

  it('joins a composite key with " / ", in the order the annotation lists the members', () => {
    expect(elementKeyText({ stage: 10, stage_index: 0 }, ['stage', 'stage_index'])).toBe('10 / 0');
  });

  it('walks a dotted member name into the element\'s own sub-struct', () => {
    expect(elementKeyText({ property: { name: '', alias: 3 } }, ['property.alias'])).toBe('3');
  });

  it('renders a bool member as the backend does', () => {
    expect(elementKeyText({ on: true }, ['on'])).toBe('true');
  });

  // A freshly added element carries its discriminator and nothing else, so its key is empty — a
  // real key, and the only handle on the row until the user names it.
  it('reads an absent or null member as the empty key', () => {
    expect(elementKeyText({ concrete_type: 'ScriptIntProperty' }, ['name'])).toBe('');
    expect(elementKeyText({ name: null }, ['name'])).toBe('');
    expect(elementKeyText(undefined, ['name'])).toBe('');
  });
});

// How the backend labelled a child is what says how to address it — both answers come from the
// same array metadata.
describe('elementSegment', () => {
  const element = (extra: Partial<FieldMetadata> = {}): FieldMetadata =>
    ({ name: '', type: 'struct', isArray: false, validFormKeyTypes: [], enumMembers: [], ...extra });
  const array = (extra: Partial<FieldMetadata>): FieldMetadata =>
    ({ name: 'A', type: 'array', isArray: true, validFormKeyTypes: [], enumMembers: [], ...extra });

  it('addresses a keyed array\'s child by the key it is labelled with', () => {
    expect(elementSegment(array({ keyMembers: ['name'], elementType: element() }), 'Ambush'))
      .toEqual({ kind: 'key', key: 'Ambush', members: ['name'] });
  });

  it('addresses a pure-FormLink array\'s child by the element value', () => {
    expect(elementSegment(array({ elementType: element({ type: 'formKey', isSortable: true }) }), 'KwdA'))
      .toEqual({ kind: 'sortKey', key: 'KwdA' });
  });

  it('addresses every other array\'s child by position', () => {
    expect(elementSegment(array({ elementType: element() }), '[2]')).toEqual({ kind: 'index', index: 2 });
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
    const seg: PathSegment = { kind: 'key', key: 'Guard', members: ['name'] };
    expect(isArrayElementHop(seg)).toBe(true);
    expect(isMovableElementHop(seg)).toBe(false);
  });

  it('a sorted element and a struct member offer neither', () => {
    for (const seg of [{ kind: 'sortKey', key: 'KwdA' }, { kind: 'member', name: 'X' }] as PathSegment[]) {
      expect(isArrayElementHop(seg)).toBe(false);
      expect(isMovableElementHop(seg)).toBe(false);
    }
    expect(isArrayElementHop(undefined)).toBe(false);
  });
});

describe('keyedElementIndex', () => {
  const seg: PathSegment & { kind: 'key' } = { kind: 'key', key: 'Guard', members: ['name'] };

  // The reason a keyed element has no index a path could carry: one path is shared by every column
  // of the row, and the columns hold the same key in different places.
  it('answers each column\'s own position for the same key', () => {
    expect(keyedElementIndex([{ name: 'Ambush' }, { name: 'Guard' }], seg)).toBe(1);
    expect(keyedElementIndex([{ name: 'Guard' }], seg)).toBe(0);
  });

  it('answers -1 where the column carries no element under that key', () => {
    expect(keyedElementIndex([{ name: 'Ambush' }], seg)).toBe(-1);
  });
});


// One recursive implementation for a row's value at any depth within the field it restages as
// one atomic unit, rather than a hand-coded case per nesting level.
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

  // One path serves every column, and a column that does not carry this keyword has nothing here —
  // answering the key regardless would read as if it did.
  it('reads nothing for a sorted-array element this column does not carry', () => {
    expect(getAtPath(['KwdA'], [{ kind: 'sortKey', key: 'KwdB' }])).toBeUndefined();
  });

  it('reads a keyed-array element against whichever column\'s array it is given', () => {
    const path: PathSegment[] = [{ kind: 'key', key: 'Guard', members: ['name'] }, { kind: 'member', name: 'flags' }];
    expect(getAtPath([{ name: 'Ambush', flags: 'a' }, { name: 'Guard', flags: 'g' }], path)).toBe('g');
    expect(getAtPath([{ name: 'Guard', flags: 'g2' }], path)).toBe('g2');
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

// `path` is the row's restage coordinates, never a bare scalar index: an array nested inside a
// struct needs every hop from the subtree root. `canMoveUp`/`canMoveDown` read the last segment.
describe('arrayElementContext', () => {
  it('produces the data-vscode-context object for a middle element (can move either way)', () => {
    const path: PathSegment[] = [{ kind: 'index', index: 1 }];
    expect(arrayElementContext('000001:Fallout4.esm', 'MyMod.esp', 'ModA', 'Items', path, 3)).toEqual({
      webviewSection: 'arrayElement',
      formKey: '000001:Fallout4.esm',
      plugin: 'MyMod.esp',
      origin: 'ModA',
      rootField: 'Items',
      path,
      canMoveUp: true,
      canMoveDown: true,
      preventDefaultContextMenuItems: true,
    });
  });

  it('canMoveUp is false for the first element', () => {
    const path: PathSegment[] = [{ kind: 'index', index: 0 }];
    expect(arrayElementContext('000001:Fallout4.esm', 'MyMod.esp', 'ModA', 'Items', path, 3).canMoveUp).toBe(false);
  });

  it('canMoveDown is false for the last element', () => {
    const path: PathSegment[] = [{ kind: 'index', index: 2 }];
    expect(arrayElementContext('000001:Fallout4.esm', 'MyMod.esp', 'ModA', 'Items', path, 3).canMoveDown).toBe(false);
  });

  // A keyed array is stored in key order on every write, so neither Move could change the file;
  // Remove still applies, which is why the row carries this context at all.
  it('offers neither Move on a keyed element, and still offers the element itself', () => {
    const path: PathSegment[] = [{ kind: 'key', key: 'Guard', members: ['name'] }];
    const context = arrayElementContext('000001:Fallout4.esm', 'MyMod.esp', 'ModA', 'Scripts', path, 3);
    expect(context.canMoveUp).toBe(false);
    expect(context.canMoveDown).toBe(false);
    expect(context.webviewSection).toBe('arrayElement');
    expect(context.path).toBe(path);
  });

  it('canMoveUp is false when index is at or past this plugin\'s own array length', () => {
    expect(arrayElementContext(
      '000001:Fallout4.esm', 'MyMod.esp', 'ModA', 'Items', [{ kind: 'index', index: 1 }], 1,
    ).canMoveUp).toBe(false);
    expect(arrayElementContext(
      '000001:Fallout4.esm', 'MyMod.esp', 'ModA', 'Items', [{ kind: 'index', index: 2 }], 1,
    ).canMoveUp).toBe(false);
  });

  // canMoveUp/canMoveDown must key off the last hop, not path.length, and the full chain must
  // survive onto the payload rather than collapse to the trailing index.
  it('a nested element carries every hop of its own path, and canMoveUp/canMoveDown read the last one', () => {
    const path: PathSegment[] = [{ kind: 'member', name: 'Sub' }, { kind: 'index', index: 0 }];
    const ctx = arrayElementContext('000001:Fallout4.esm', 'MyMod.esp', 'ModA', 'Container', path, 2);
    expect(ctx.path).toEqual(path);
    expect(ctx.rootField).toBe('Container');
    expect(ctx.canMoveUp).toBe(false); // last hop's index is 0
    expect(ctx.canMoveDown).toBe(true);
  });
});

describe('arrayParentContext', () => {
  it('produces the data-vscode-context object for a top-level array-parent cell (empty path)', () => {
    expect(arrayParentContext('000001:Fallout4.esm', 'MyMod.esp', 'ModA', 'Items', [])).toEqual({
      webviewSection: 'arrayParent',
      formKey: '000001:Fallout4.esm',
      plugin: 'MyMod.esp',
      origin: 'ModA',
      rootField: 'Items',
      path: [],
      preventDefaultContextMenuItems: true,
    });
  });

  // A nested array's "Add" must address the array itself: "the root field is the array" holds
  // only for a top-level array.
  it('carries the row\'s own path for a nested array-parent cell', () => {
    const path: PathSegment[] = [{ kind: 'member', name: 'Entries' }];
    const ctx = arrayParentContext('000001:Fallout4.esm', 'MyMod.esp', 'ModA', 'Container', path);
    expect(ctx.path).toEqual(path);
    expect(ctx.rootField).toBe('Container');
  });
});

// A row can be more than one structural-op target at once, so combining contexts rather than
// picking one is what makes both menus reachable from the same cell.
describe('combineVscodeContexts', () => {
  it('returns undefined when every context is absent', () => {
    expect(combineVscodeContexts(undefined, undefined)).toBeUndefined();
  });

  it('passes a single context through, still as a JSON string (an unchanged call site contract)', () => {
    const result = combineVscodeContexts(arrayParentContext('000001:Fallout4.esm', 'MyMod.esp', 'ModA', 'Items', []));
    expect(JSON.parse(result!)).toEqual({
      webviewSection: 'arrayParent', formKey: '000001:Fallout4.esm', plugin: 'MyMod.esp', origin: 'ModA', rootField: 'Items', path: [],
      preventDefaultContextMenuItems: true,
    });
  });

  it('skips an absent context among present ones', () => {
    const result = combineVscodeContexts(undefined, arrayParentContext('000001:Fallout4.esm', 'MyMod.esp', 'ModA', 'Items', []), undefined);
    expect(JSON.parse(result!).webviewSection).toBe('arrayParent');
  });

  it('combines two contexts\' webviewSection into one space-separated token list', () => {
    const result = combineVscodeContexts(
      arrayElementContext('000001:Fallout4.esm', 'MyMod.esp', 'ModA', 'tags', [{ kind: 'index', index: 0 }], 2),
      stringValueContext('000001:Fallout4.esm', 'MyMod.esp', 'ModA', 'tags', 'a', false, [{ kind: 'index', index: 0 }], 'tags'),
    );
    const parsed = JSON.parse(result!);
    expect(parsed.webviewSection).toBe('arrayElement stringValue');
  });

  it('merges every other key from both contexts (so package.json\'s when clauses can read either)', () => {
    const result = combineVscodeContexts(
      arrayElementContext('000001:Fallout4.esm', 'MyMod.esp', 'ModA', 'tags', [{ kind: 'index', index: 0 }], 2),
      stringValueContext('000001:Fallout4.esm', 'MyMod.esp', 'ModA', 'tags', 'a', false, [{ kind: 'index', index: 0 }], 'tags'),
    );
    const parsed = JSON.parse(result!);
    expect(parsed.canMoveDown).toBe(true);
    expect(parsed.value).toBe('a');
    expect(parsed.rootField).toBe('tags');
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
  it('carries the cell\'s own identity, current value and readOnly flag', () => {
    expect(stringValueContext('000001:Fallout4.esm', 'MyMod.esp', 'ModA', 'Name', 'Dogmeat', false, [], 'Name')).toEqual({
      webviewSection: 'stringValue',
      formKey: '000001:Fallout4.esm',
      plugin: 'MyMod.esp',
      origin: 'ModA',
      fieldName: 'Name',
      value: 'Dogmeat',
      readOnly: false,
      path: [],
      rootField: 'Name',
      preventDefaultContextMenuItems: true,
    });
  });

  it('carries readOnly: true for an immutable/untracked/not-in-load-order column unchanged', () => {
    expect(stringValueContext('000001:Fallout4.esm', 'Fallout4.esm', 'Data', 'Name', 'Dogmeat', true, [], 'Name').readOnly).toBe(true);
  });

  // A nested string leaf carries its own path within the field and the subtree root's wire path
  // — the two coordinates whole-field reconstruction needs, distinct from the display `fieldName`.
  it('carries the row\'s own path and the subtree root\'s wire path for a nested string leaf', () => {
    const path: PathSegment[] = [{ kind: 'member', name: 'Entries' }, { kind: 'index', index: 0 }, { kind: 'member', name: 'Id' }];
    const ctx = stringValueContext('000001:Fallout4.esm', 'MyMod.esp', 'ModA', 'Container', 'A', false, path, 'Container');
    expect(ctx.path).toEqual(path);
    expect(ctx.rootField).toBe('Container');
  });

  it('combines like every other context', () => {
    const result = combineVscodeContexts(
      stringValueContext('000001:Fallout4.esm', 'MyMod.esp', 'ModA', 'Name', 'Dogmeat', false, [], 'Name'),
    );
    expect(JSON.parse(result!)).toEqual({
      webviewSection: 'stringValue', formKey: '000001:Fallout4.esm', plugin: 'MyMod.esp', origin: 'ModA',
      fieldName: 'Name', value: 'Dogmeat', readOnly: false, path: [], rootField: 'Name',
      preventDefaultContextMenuItems: true,
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

  // Two plugins hold `Guard` at different positions and one path, shared by both columns, must
  // reach it in each. Addressing by index parses NaN and posts the array unchanged.
  it('sets a keyed-array element at each column\'s own position for that key', () => {
    const path: PathSegment[] = [{ kind: 'key', key: 'Guard', members: ['name'] }, { kind: 'member', name: 'flags' }];
    expect(setAtPath([{ name: 'Ambush', flags: 'a' }, { name: 'Guard', flags: 'g' }], path, 'X'))
      .toEqual([{ name: 'Ambush', flags: 'a' }, { name: 'Guard', flags: 'X' }]);
    expect(setAtPath([{ name: 'Guard', flags: 'g' }], path, 'X'))
      .toEqual([{ name: 'Guard', flags: 'X' }]);
  });

  // "10 / 3" slices to "0 / " and reads as a valid index 0, so a wrong answer is a silent write
  // to a different element. Any key whose second character is a digit behaves this way.
  it('sets the element a composite key names, not the one that key parses to as an index', () => {
    const fragments = [
      { stage: 5, stage_index: 1, script_name: 'Five' },
      { stage: 10, stage_index: 3, script_name: 'Ten' },
    ];
    const path: PathSegment[] = [
      { kind: 'key', key: '10 / 3', members: ['stage', 'stage_index'] },
      { kind: 'member', name: 'script_name' },
    ];
    expect(setAtPath(fragments, path, 'Renamed')).toEqual([
      { stage: 5, stage_index: 1, script_name: 'Five' },
      { stage: 10, stage_index: 3, script_name: 'Renamed' },
    ]);
  });

  // A rename must reach the write path as a real change, not as the array it started from.
  it('posts a keyed rename that JSON.stringify actually carries', () => {
    const scripts = [{ name: 'Ambush', flags: 'Local' }, { name: 'Guard', flags: 'Local' }];
    const path: PathSegment[] = [{ kind: 'key', key: 'Ambush', members: ['name'] }, { kind: 'member', name: 'name' }];
    expect(JSON.stringify(setAtPath(scripts, path, 'Renamed')))
      .toBe('[{"name":"Renamed","flags":"Local"},{"name":"Guard","flags":"Local"}]');
  });

  it('leaves a column that carries no element under the key exactly as it is', () => {
    const path: PathSegment[] = [{ kind: 'key', key: 'Guard', members: ['name'] }, { kind: 'member', name: 'flags' }];
    expect(setAtPath([{ name: 'Ambush', flags: 'a' }], path, 'X')).toEqual([{ name: 'Ambush', flags: 'a' }]);
  });

  // The empty key is the only handle a freshly added element's own rename has.
  it('sets a freshly added element addressed by the empty key', () => {
    const path: PathSegment[] = [{ kind: 'key', key: '', members: ['name'] }, { kind: 'member', name: 'name' }];
    expect(setAtPath([{ name: 'Alpha' }, { flags: 'Local' }], path, 'Named'))
      .toEqual([{ name: 'Alpha' }, { flags: 'Local', name: 'Named' }]);
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

// The array-op broadcast handler has only the wire's rootField and path, never a render-time
// `overrideMeta`, so it descends FieldMetadata itself to reach a nested array's element type.
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

  it('descends a sortKey hop via .elementType, same as index', () => {
    expect(metaAtPath(entriesMeta, [{ kind: 'sortKey', key: 'anything' }])).toBe(entryMeta);
  });

  it('descends a key hop via .elementType, same as index', () => {
    expect(metaAtPath(entriesMeta, [{ kind: 'key', key: 'anything', members: ['Id'] }])).toBe(entryMeta);
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
