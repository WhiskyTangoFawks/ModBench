import '@testing-library/jest-dom';
import { describe, it, expect } from 'vitest';
import {
  buildColumns,
  isArrayElementHop,
  getAtPath,
  wirePath,
  arrayElementContext,
  arrayParentContext,
  cellContext,
  stringValueContext,
  metaAtPath,
} from './recordUtils';
import type { CompareOverride, PathHop, PathSegment } from './types';
import { compareOverride, fieldMeta } from './test/fixtures';
import { columnKey } from '../../src/wire/columnKey';

const copyIn = (plugin: string, extra: Partial<CompareOverride> = {}): CompareOverride =>
  compareOverride({ formKey: '000001:Test.esp', plugin, fields: [], ...extra });

describe('the columns, one per copy in the wire\'s own load order (master leftmost, winner rightmost, as in xEdit), trusted as sent rather than re-sorted', () => {
  it('are one per copy, in response order', () => {
    const cols = buildColumns([
      copyIn('Fallout4.esm'),
      copyIn('Patch.esp'),
      copyIn('MyMod.esp', { isWinner: true }),
    ]);
    expect(cols.map(c => c.override.plugin)).toEqual(['Fallout4.esm', 'Patch.esp', 'MyMod.esp']);
  });

  it('keep same-filename copies apart by the compound (plugin, origin) identity, minted here once for every consumer', () => {
    const cols = buildColumns([
      copyIn('Shared.esp', { origin: 'ModA' }),
      copyIn('Shared.esp', { origin: 'ModB' }),
    ]);
    expect(cols.map(c => c.key)).toEqual(['Shared.esp|ModA', 'Shared.esp|ModB']);
  });

  it('are none for no copies', () => {
    expect(buildColumns([])).toEqual([]);
  });
});

describe('a hop is an array element\'s, one rule, since the panel\'s handler wiring, the cell menu and the native menu all ask it', () => {
  it.each<[string, PathSegment | undefined, boolean]>([
    ['an element at a position is', { kind: 'index', index: 0 }, true],
    ['an element at its index in each column is', { kind: 'element', indexes: { 'A.esp': 0 }, keyed: false }, true],
    ['a struct member is not', { kind: 'member', name: 'X' }, false],
    ['no hop is not', undefined, false],
  ])('%s', (_case, hop, element) => {
    expect(isArrayElementHop(hop)).toBe(element);
  });
});

describe('a value read along an envelope\'s hops, at any depth', () => {
  it.each<[string, unknown, PathHop[], unknown]>([
    ['is the root itself for no hops', { X: 1 }, [], { X: 1 }],
    ['reads a struct member', { X: 1, Y: 2 }, [{ kind: 'member', name: 'X' }], 1],
    ['reads a positional array element', ['a', 'b', 'c'], [{ kind: 'index', index: 1 }], 'b'],
    ['reads through a member, an index and a member, a depth a fixed-level union could never express',
      { Outer: [{ Inner: 'a' }, { Inner: 'b' }] },
      [{ kind: 'member', name: 'Outer' }, { kind: 'index', index: 1 }, { kind: 'member', name: 'Inner' }], 'b'],
    ['is nothing where a member is missing', {}, [{ kind: 'member', name: 'X' }], undefined],
  ])('%s', (_case, root, path, value) => {
    expect(getAtPath(root, path)).toEqual(value);
  });
});

describe('an array element\'s menu context, whose `path` is the envelope\'s own wire path, never a bare scalar index, as an array nested inside a struct needs every hop', () => {
  it('carries the element\'s copy and path, and offers both moves to a middle element', () => {
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

  it.each([
    ['the last element cannot move down', 2, { canMoveUp: true, canMoveDown: false }],
    ['the first element cannot move up', 0, { canMoveUp: false, canMoveDown: true }],
  ])('%s', (_case, index, moves) => {
    const path: PathHop[] = [{ kind: 'member', name: 'Items' }, { kind: 'index', index }];
    expect(arrayElementContext('000001:Fallout4.esm', 'MyMod.esp', 'ModA', path, 3, false)).toMatchObject(moves);
  });
});

describe('a cell\'s menu context, its own items and every menu its cell is the target of, as a row can be more than one structural-op target and both menus must be reachable from the same cell', () => {
  const TAGS_PATH: PathHop[] = [{ kind: 'member', name: 'tags' }, { kind: 'index', index: 0 }];

  it('offers no copy value on a cell that copies nothing', () => {
    expect(cellContext(undefined)).toEqual({ webviewSection: 'cell', preventDefaultContextMenuItems: true });
  });

  it('skips an absent context among present ones', () => {
    expect(cellContext(undefined, undefined, arrayParentContext('000001:Fallout4.esm', 'MyMod.esp', 'ModA', [{ kind: 'member', name: 'Items' }]), undefined))
      .toEqual({
        webviewSection: 'cell arrayParent', formKey: '000001:Fallout4.esm', plugin: 'MyMod.esp', origin: 'ModA',
        path: [{ kind: 'member', name: 'Items' }], preventDefaultContextMenuItems: true,
      });
  });

  it('combines the contexts\' webviewSection into one space-separated token list, and merges every other key, so package.json\'s when clauses can read either', () => {
    const context = cellContext(
      'a',
      arrayElementContext('000001:Fallout4.esm', 'MyMod.esp', 'ModA', TAGS_PATH, 3, false),
      stringValueContext('000001:Fallout4.esm', 'MyMod.esp', 'ModA', 'Dogmeat [000001:Fallout4.esm]', 'tags', 'a', false, TAGS_PATH),
    );
    expect(context.webviewSection).toBe('cell arrayElement stringValue');
    expect(context.canMoveDown).toBe(true);
    expect(context.value).toBe('a');
    expect(context.path).toEqual(TAGS_PATH);
  });
});

describe('a row\'s wire path in one column', () => {
  const inColumn = (name: string) => columnKey({ name, origin: 'Data/' });

  it.each<[string, string, PathSegment[], string, PathHop[] | undefined]>([
    ['leads with the root member and carries member and index hops as they are', 'VirtualMachineAdapter', [
      { kind: 'member', name: 'Scripts' }, { kind: 'index', index: 1 },
      { kind: 'member', name: 'Properties' }, { kind: 'index', index: 2 },
    ], 'A.esp', [
      { kind: 'member', name: 'VirtualMachineAdapter' }, { kind: 'member', name: 'Scripts' }, { kind: 'index', index: 1 },
      { kind: 'member', name: 'Properties' }, { kind: 'index', index: 2 },
    ]],
    ['is the one member hop for a top-level row', 'Level', [], 'A.esp', [{ kind: 'member', name: 'Level' }]],
    ['turns an element into its position in the given column', 'Data',
      [{ kind: 'member', name: 'Packages' }, { kind: 'element', indexes: { 'A.esp': 0, 'B.esp': 2 }, keyed: false }], 'B.esp',
      [{ kind: 'member', name: 'Data' }, { kind: 'member', name: 'Packages' }, { kind: 'index', index: 2 }]],
    ['is no path for a column that does not hold the element', 'Packages',
      [{ kind: 'element', indexes: { 'A.esp': 0 }, keyed: false }], 'B.esp', undefined],
  ])('%s', (_case, root, path, column, hops) => {
    expect(wirePath(root, path, inColumn(column))).toEqual(hops);
  });
});

describe('the schema found along a path, as a collapsed row\'s prose summary has only a path, never the row\'s own resolved metadata', () => {
  const idMeta = fieldMeta({ name: 'Id', type: 'string' });
  const weightMeta = fieldMeta({ name: 'Weight', type: 'int' });
  const entryMeta = fieldMeta({ name: '', type: 'struct', fields: [idMeta, weightMeta] });
  const entriesMeta = fieldMeta({ name: 'Entries', type: 'array', isArray: true, elementType: entryMeta });
  const containerMeta = fieldMeta({ name: 'Container', type: 'struct', fields: [entriesMeta] });

  it.each([
    ['is the root itself for no hops', entriesMeta, [], entriesMeta],
    ['descends a struct member to its field', containerMeta, [{ kind: 'member', name: 'Entries' }], entriesMeta],
    ['descends an array index to its element type', entriesMeta, [{ kind: 'index', index: 0 }], entryMeta],
    ['is nothing where a member is missing, rather than throwing', containerMeta, [{ kind: 'member', name: 'Missing' }], undefined],
    ['is nothing under no schema', undefined, [{ kind: 'member', name: 'X' }], undefined],
  ] as const)('%s', (_case, root, path, found) => {
    expect(metaAtPath(root, [...path])).toBe(found);
  });
});
