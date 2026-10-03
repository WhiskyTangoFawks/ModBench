import '@testing-library/jest-dom';
import { describe, it, expect } from 'vitest';
import {
  buildColumns,
  isArrayElementHop,
  getAtPath,
  wirePath,
  arrayElementContext,
  arrayParentContext,
  combineVscodeContexts,
  headerCellContext,
  cellContext,
  referenceContext,
  stringValueContext,
  metaAtPath,
  type PathHop,
  type PathSegment,
} from './recordUtils';
import type { CompareOverride } from './types';
import { fieldMeta, parseJsonRecord } from './test/fixtures';
import { columnKey } from './columnKey';

function makeOverride(plugin: string, extra: Partial<CompareOverride> = {}): CompareOverride {
  return {
    formKey: '000001:Test.esp',
    plugin,
    loadIndex: '00',
    isWinner: false,
    editorId: null,
    fields: [],
    conflictThis: 'OnlyOne',
    origin: 'Data',
    recordType: 'npc_',
    isPartialForm: false,
    isInOverwrite: false,
    ...extra,
  };
}

describe('buildColumns, one column per CompareOverride in the wire\'s own load order (master leftmost, winner rightmost, as in xEdit), trusted as sent rather than re-sorted',() => {
  it('returns one column per override, in response order', () => {
    const cols = buildColumns([
      makeOverride('Fallout4.esm'),
      makeOverride('Patch.esp'),
      makeOverride('MyMod.esp', { isWinner: true }),
    ]);
    expect(cols.map(c => c.override.plugin)).toEqual(['Fallout4.esm', 'Patch.esp', 'MyMod.esp']);
  });

  it('keys same-filename columns by the compound (plugin, origin) identity, minted here once for every consumer',() => {
    const cols = buildColumns([
      makeOverride('Shared.esp', { origin: 'ModA' }),
      makeOverride('Shared.esp', { origin: 'ModB' }),
    ]);
    expect(cols).toHaveLength(2);
    expect(new Set(cols.map(c => c.key)).size).toBe(2);
  });

  it('returns no columns for an empty override list', () => {
    expect(buildColumns([])).toEqual([]);
  });
});

describe('isArrayElementHop, one rule, since the panel\'s handler wiring, the cell menu and the native menu all ask it',() => {
  it('an array\'s element is one, at a position or at its index in each column', () => {
    expect(isArrayElementHop({ kind: 'index', index: 0 })).toBe(true);
    expect(isArrayElementHop({ kind: 'element', indexes: { 'A.esp': 0 }, keyed: false })).toBe(true);
  });

  it('a struct member is not', () => {
    expect(isArrayElementHop({ kind: 'member', name: 'X' })).toBe(false);
    expect(isArrayElementHop(undefined)).toBe(false);
  });
});

describe('getAtPath, one recursive reader for a value at any depth along an envelope\'s hops',() => {
  it('returns the root itself for an empty path', () => {
    expect(getAtPath({ X: 1 }, [])).toEqual({ X: 1 });
  });

  it('reads a struct member', () => {
    const path: PathHop[] = [{ kind: 'member', name: 'X' }];
    expect(getAtPath({ X: 1, Y: 2 }, path)).toBe(1);
  });

  it('reads a positional array element', () => {
    const path: PathHop[] = [{ kind: 'index', index: 1 }];
    expect(getAtPath(['a', 'b', 'c'], path)).toBe('b');
  });

  it('reads through a member → index → member chain (struct-in-array-in-struct depth)', () => {
    const path: PathHop[] = [
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

describe('arrayElementContext, whose `path` is the envelope\'s own wire path, never a bare scalar index, as an array nested inside a struct needs every hop',() => {
  it('produces the data-vscode-context object for a middle element', () => {
    const path: PathHop[] = [{ kind: 'member', name: 'Items' }, { kind: 'index', index: 1 }];
    expect(arrayElementContext('000001:Fallout4.esm', 'MyMod.esp', 'ModA', path, 3, false)).toEqual({
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

  it('canMoveDown is false for the last element', () => {
    const path: PathHop[] = [{ kind: 'member', name: 'Items' }, { kind: 'index', index: 2 }];
    expect(arrayElementContext('000001:Fallout4.esm', 'MyMod.esp', 'ModA', path, 3, false).canMoveDown).toBe(false);
  });

  it('canMoveUp is false for the first element', () => {
    const path: PathHop[] = [{ kind: 'member', name: 'Items' }, { kind: 'index', index: 0 }];
    expect(arrayElementContext('000001:Fallout4.esm', 'MyMod.esp', 'ModA', path, 3, false).canMoveUp).toBe(false);
  });

  it('a nested element carries every hop of its own path, and the Moves read the last one', () => {
    const path: PathHop[] = [{ kind: 'member', name: 'Container' }, { kind: 'member', name: 'Sub' }, { kind: 'index', index: 0 }];
    const ctx = arrayElementContext('000001:Fallout4.esm', 'MyMod.esp', 'ModA', path, 2, false);
    expect(ctx.path).toEqual(path);
    expect(ctx.canMoveUp).toBe(false);
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

  it('carries every hop down to a nested array-parent cell, as its "Add" addresses the array itself, more hops than the record\'s own member',() => {
    const path: PathHop[] = [{ kind: 'member', name: 'Container' }, { kind: 'member', name: 'Entries' }];
    const ctx = arrayParentContext('000001:Fallout4.esm', 'MyMod.esp', 'ModA', path);
    expect(ctx.path).toEqual(path);
  });
});

describe('combineVscodeContexts, combining rather than picking one, as a row can be more than one structural-op target and both menus must be reachable from the same cell',() => {
  const TAGS_PATH: PathHop[] = [{ kind: 'member', name: 'tags' }, { kind: 'index', index: 0 }];

  it('returns undefined when every context is absent', () => {
    expect(combineVscodeContexts(undefined, undefined)).toBeUndefined();
  });

  it('passes a single context through, still as a JSON string (an unchanged call site contract)', () => {
    const result = combineVscodeContexts(arrayParentContext('000001:Fallout4.esm', 'MyMod.esp', 'ModA', [{ kind: 'member', name: 'Items' }]));
    if (!result) throw new Error('expected a combined context for one present context');
    expect(JSON.parse(result)).toEqual({
      webviewSection: 'arrayParent', formKey: '000001:Fallout4.esm', plugin: 'MyMod.esp', origin: 'ModA',
      path: [{ kind: 'member', name: 'Items' }],
      preventDefaultContextMenuItems: true,
    });
  });

  it('skips an absent context among present ones', () => {
    const result = combineVscodeContexts(undefined, arrayParentContext('000001:Fallout4.esm', 'MyMod.esp', 'ModA', [{ kind: 'member', name: 'Items' }]), undefined);
    if (!result) throw new Error('expected a combined context skipping the absent ones');
    expect(parseJsonRecord(result).webviewSection).toBe('arrayParent');
  });

  it('combines two contexts\' webviewSection into one space-separated token list', () => {
    const result = combineVscodeContexts(
      arrayElementContext('000001:Fallout4.esm', 'MyMod.esp', 'ModA', TAGS_PATH, 3, false),
      stringValueContext('000001:Fallout4.esm', 'MyMod.esp', 'ModA', 'Dogmeat [000001:Fallout4.esm]', 'tags', 'a', false, TAGS_PATH),
    );
    if (!result) throw new Error('expected a combined context for two present contexts');
    expect(parseJsonRecord(result).webviewSection).toBe('arrayElement stringValue');
  });

  it('merges every other key from both contexts (so package.json\'s when clauses can read either)', () => {
    const result = combineVscodeContexts(
      arrayElementContext('000001:Fallout4.esm', 'MyMod.esp', 'ModA', TAGS_PATH, 3, false),
      stringValueContext('000001:Fallout4.esm', 'MyMod.esp', 'ModA', 'Dogmeat [000001:Fallout4.esm]', 'tags', 'a', false, TAGS_PATH),
    );
    if (!result) throw new Error('expected a combined context for two present contexts');
    const parsed = parseJsonRecord(result);
    expect(parsed.canMoveDown).toBe(true);
    expect(parsed.value).toBe('a');
    expect(parsed.path).toEqual(TAGS_PATH);
  });
});

describe('headerCellContext, unconditional on the column\'s read-only-ness, as copying from an immutable column is the headline use case',() => {
  it('identifies the header cell, carrying the column\'s own record identity', () => {
    expect(headerCellContext('000001:Fallout4.esm', 'MyMod.esp', 'ModA', true)).toEqual({
      webviewSection: 'recordHeader', formKey: '000001:Fallout4.esm', plugin: 'MyMod.esp', origin: 'ModA',
      editable: true, preventDefaultContextMenuItems: true,
    });
  });

  it('combines like every other context, for a header cell that one day carries more than one', () => {
    const result = combineVscodeContexts(
      headerCellContext('000001:Fallout4.esm', 'MyMod.esp', 'ModA', false));
    if (!result) throw new Error('expected a combined context for the header cell context');
    expect(JSON.parse(result)).toEqual({
      webviewSection: 'recordHeader', formKey: '000001:Fallout4.esm', plugin: 'MyMod.esp', origin: 'ModA',
      editable: false,
      preventDefaultContextMenuItems: true,
    });
  });
});

describe('stringValueContext, the string-cell right-click menu\'s own identity and the extended editor\'s only trigger, since no left-click gesture reaches it',() => {
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

  it('carries every hop of a nested string leaf\'s wire path, so its set envelope lands at its own hops, not the member it sits under',() => {
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
    if (!result) throw new Error('expected a combined context for the string-value context');
    expect(JSON.parse(result)).toEqual({
      webviewSection: 'stringValue', formKey: '000001:Fallout4.esm', plugin: 'MyMod.esp', origin: 'ModA',
      recordLabel: 'Dogmeat', fieldName: 'Name', value: 'Dogmeat', readOnly: false, path: NAME_PATH,
      preventDefaultContextMenuItems: true,
    });
  });
});

describe('wirePath', () => {
  it('leads with the root member and carries member and index hops as they are', () => {
    const path: PathSegment[] = [
      { kind: 'member', name: 'Scripts' }, { kind: 'index', index: 1 },
      { kind: 'member', name: 'Properties' }, { kind: 'index', index: 2 },
    ];
    expect(wirePath('VirtualMachineAdapter', path, columnKey('A.esp', 'Data'))).toEqual([
      { kind: 'member', name: 'VirtualMachineAdapter' }, ...path,
    ]);
  });

  it('is the one member hop for a top-level row', () => {
    expect(wirePath('Level', [], columnKey('A.esp', 'Data'))).toEqual([{ kind: 'member', name: 'Level' }]);
  });

  it('turns an element into its position in the given column', () => {
    const path: PathSegment[] = [{ kind: 'member', name: 'Packages' }, { kind: 'element', indexes: { 'A.esp': 0, 'B.esp': 2 }, keyed: false }];
    expect(wirePath('Data', path, columnKey('B.esp', 'Data')))
      .toEqual([{ kind: 'member', name: 'Data' }, { kind: 'member', name: 'Packages' }, { kind: 'index', index: 2 }]);
  });

  it('is no path for a column that does not hold the element', () => {
    expect(wirePath('Packages', [{ kind: 'element', indexes: { 'A.esp': 0 }, keyed: false }], columnKey('B.esp', 'Data'))).toBeUndefined();
  });
});

describe('metaAtPath, descending FieldMetadata itself, as a collapsed row\'s prose summary has only a path, never the row\'s own resolved metadata',() => {
  const idMeta = fieldMeta({ name: 'Id', type: 'string' });
  const weightMeta = fieldMeta({ name: 'Weight', type: 'int' });
  const entryMeta = fieldMeta({ name: '', type: 'struct', fields: [idMeta, weightMeta] });
  const entriesMeta = fieldMeta({ name: 'Entries', type: 'array', isArray: true, elementType: entryMeta });
  const containerMeta = fieldMeta({ name: 'Container', type: 'struct', fields: [entriesMeta] });

  it('returns the root meta itself for an empty path', () => {
    expect(metaAtPath(entriesMeta, [])).toBe(entriesMeta);
  });

  it('descends a struct member via .fields', () => {
    expect(metaAtPath(containerMeta, [{ kind: 'member', name: 'Entries' }])).toBe(entriesMeta);
  });

  it('descends an array index via .elementType', () => {
    expect(metaAtPath(entriesMeta, [{ kind: 'index', index: 0 }])).toBe(entryMeta);
  });

  it('finds a nested array\'s own element type through a member chain', () => {
    const path: PathHop[] = [{ kind: 'member', name: 'Entries' }];
    expect(metaAtPath(containerMeta, path)?.elementType).toBe(entryMeta);
  });

  it('returns undefined when a member is missing, rather than throwing', () => {
    expect(metaAtPath(containerMeta, [{ kind: 'member', name: 'Missing' }])).toBeUndefined();
  });

  it('returns undefined when the root meta itself is undefined', () => {
    expect(metaAtPath(undefined, [{ kind: 'member', name: 'X' }])).toBeUndefined();
  });
});

describe('cellContext', () => {
  it('names the cell and carries the text copy value copies', () => {
    expect(cellContext('Dogmeat')).toEqual({ webviewSection: 'cell', copyText: 'Dogmeat', preventDefaultContextMenuItems: true });
  });

  it('carries no text for a cell that copies nothing', () => {
    expect(cellContext(undefined)).toEqual({ webviewSection: 'cell', preventDefaultContextMenuItems: true });
  });
});

describe('referenceContext', () => {
  it('carries the record the reference points to under its own key, beside the record the panel shows', () => {
    const merged = combineVscodeContexts(
      arrayElementContext('000001:Fallout4.esm', 'MyMod.esp', 'ModA', [{ kind: 'member', name: 'Keywords' }, { kind: 'index', index: 0 }], 2, false),
      referenceContext('000019:Fallout4.esm'),
    );
    const parsed = parseJsonRecord(merged ?? '');
    expect(parsed.formKey).toBe('000001:Fallout4.esm');
    expect(parsed.referenceTarget).toBe('000019:Fallout4.esm');
    expect(parsed.webviewSection).toBe('arrayElement reference');
  });
});
