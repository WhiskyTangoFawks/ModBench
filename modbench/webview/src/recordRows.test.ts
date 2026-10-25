import { describe, it, expect } from 'vitest';
import { compareOverride, compareResultFixture, diffNode, fieldMeta } from './test/fixtures';
import { buildColumns } from './recordUtils';
import { columnKey } from '../../src/wire/columnKey';
import { navRows, recordRows, shownCell, visibleRows, FORM_ID_ROW, RECORD_HEADER_ROW, type FieldRow, type RecordRow } from './recordRows';
import type { ColumnKey, CompareResult, FieldMetadata } from './types';

const MASTER = columnKey({ name: 'Fallout4.esm', origin: 'Data/' });
const MOD = columnKey({ name: 'MyMod.esp', origin: 'Data/' });

const bounds = fieldMeta({
  name: 'Bounds', type: 'struct',
  fields: [fieldMeta({ name: 'X', type: 'int' }), fieldMeta({ name: 'Y', type: 'int' })],
});
const keywords = fieldMeta({
  name: 'Keywords', type: 'array', isArray: true, elementType: fieldMeta({ name: 'Keyword', type: 'int' }),
});
const editorId = fieldMeta({ name: 'EditorID', type: 'string', isEditorId: true });
const formId = fieldMeta({ name: 'FormID', type: 'formKey', isRecordHeaderMember: true, isRecordFormKey: true });
const version = fieldMeta({ name: 'Version', type: 'int', isRecordHeaderMember: true });

function answer(metas: FieldMetadata[], diffs: CompareResult['diffs'], partialMod = false): CompareResult {
  const fields = metas.map(metadata => ({ metadata, value: null }));
  return compareResultFixture({
    overrides: [
      compareOverride({ formKey: '000001:Fallout4.esm', plugin: 'Fallout4.esm', fields }),
      compareOverride({ formKey: '000001:Fallout4.esm', plugin: 'MyMod.esp', fields, isPartialForm: partialMod }),
    ],
    diffs,
  });
}

function rowsFor(result: CompareResult, editable = [MASTER, MOD], partial: ColumnKey[] = []) {
  return recordRows({
    result, columns: buildColumns(result.overrides),
    editableColumns: new Set(editable), partialFormColumns: new Set(partial), recordLabel: () => 'TestNPC [000001:Fallout4.esm]',
  });
}

const fieldRowsOf = (rows: RecordRow[]): FieldRow[] => rows.filter(r => r.kind === 'field');

const boundsDiff = diffNode({
  fieldName: 'Bounds', values: { [MASTER]: { X: 1, Y: 2 }, [MOD]: { X: 3, Y: 2 } },
  children: [
    diffNode({ fieldName: 'X', values: { [MASTER]: 1, [MOD]: 3 } }),
    diffNode({ fieldName: 'Y', values: { [MASTER]: 2, [MOD]: 2 } }),
  ],
});

describe('recordRows', () => {
  it('a struct is a row and a row for each member, one step deeper, parent first', () => {
    const rows = rowsFor(answer([bounds], [boundsDiff]));

    expect(fieldRowsOf(rows).map(r => [r.key, r.parent, r.depth])).toEqual([
      ['Bounds', null, 0], ['Bounds.X', 'Bounds', 1], ['Bounds.Y', 'Bounds', 1],
    ]);
    expect(fieldRowsOf(rows).map(r => r.expandable)).toEqual([true, false, false]);
  });

  it('rows come in the order of the diffs', () => {
    const rows = rowsFor(answer([bounds, editorId], [
      diffNode({ fieldName: 'EditorID', values: {} }), diffNode({ fieldName: 'Bounds', values: {} }),
    ]));

    expect(fieldRowsOf(rows).map(r => r.key)).toEqual(['EditorID', 'Bounds']);
  });

  it('two elements sharing a key are rows of their own, the second keyed by its turn', () => {
    const rows = rowsFor(answer([keywords], [diffNode({
      fieldName: 'Keywords', values: {},
      children: [
        diffNode({ fieldName: 'Keyword', values: { [MOD]: 1 } }),
        diffNode({ fieldName: 'Keyword', values: { [MOD]: 2 } }),
      ],
    })]));

    expect(fieldRowsOf(rows).map(r => r.key)).toEqual(['Keywords', 'Keywords.Keyword', 'Keywords.Keyword#2']);
  });

  it('an element row is present in the columns that hold it and the last element is known per column', () => {
    const first = diffNode({ fieldName: 'Keyword', values: { [MASTER]: 1, [MOD]: 1 }, indexes: { [MASTER]: 0, [MOD]: 0 } });
    const second = diffNode({ fieldName: 'Keyword', values: { [MOD]: 2 }, indexes: { [MOD]: 1 } });
    const rows = rowsFor(answer([keywords], [diffNode({ fieldName: 'Keywords', values: {}, children: [first, second] })]));
    const [, one, two] = fieldRowsOf(rows);

    expect([MASTER, MOD].map(c => two?.cells.get(c)?.holds)).toEqual([false, true]);
    expect([MASTER, MOD].map(c => one?.cells.get(c)?.holds)).toEqual([true, true]);
    expect([MASTER, MOD].map(c => one?.isLastElement?.(c))).toEqual([true, false]);
  });

  it('a diff node whose member no schema declares has no row, nor has its subtree', () => {
    const rows = rowsFor(answer([bounds], [
      diffNode({ fieldName: 'Mystery', values: {}, children: [diffNode({ fieldName: 'Child', values: {} })] }),
      boundsDiff,
    ]));

    expect(fieldRowsOf(rows).map(r => r.key)).toEqual(['Bounds', 'Bounds.X', 'Bounds.Y']);
  });

  it('the Record Header comes first and its members under it, the FormID as a row of its own', () => {
    const rows = rowsFor(answer([editorId, version, formId], [
      diffNode({ fieldName: 'EditorID', values: {} }),
      diffNode({ fieldName: 'Version', values: {} }),
      diffNode({ fieldName: 'FormID', values: {} }),
    ]));

    expect(rows.map(r => [r.key, r.kind, r.parent, r.depth])).toEqual([
      [RECORD_HEADER_ROW, 'recordHeader', null, 0],
      ['Record Header.Version', 'field', RECORD_HEADER_ROW, 1],
      ['Record Header.FormID', 'formId', RECORD_HEADER_ROW, 1],
      ['EditorID', 'field', null, 0],
    ]);
  });

  it('a Partial Form column can write the EditorID and no other field of its own', () => {
    const rows = fieldRowsOf(rowsFor(
      answer([editorId, bounds], [diffNode({ fieldName: 'EditorID', values: { [MASTER]: 'Id', [MOD]: 'Id' } }), diffNode({ fieldName: 'Bounds', values: { [MASTER]: { X: 1 } } })]),
      [MASTER, MOD], [MOD],
    ));
    const [id, struct] = rows;

    expect([MASTER, MOD].map(c => id?.cells.get(c)?.editPath !== undefined)).toEqual([true, true]);
    expect([MASTER, MOD].map(c => struct?.cells.get(c)?.editPath !== undefined)).toEqual([true, false]);
    expect([MASTER, MOD].map(c => id?.cells.get(c)?.holds)).toEqual([true, true]);
    expect([MASTER, MOD].map(c => struct?.cells.get(c)?.holds)).toEqual([true, false]);
  });
});

describe('what the rows show of what is collapsed', () => {
  const rows = rowsFor(answer([bounds, editorId, version], [
    diffNode({ fieldName: 'Version', values: {} }), boundsDiff, diffNode({ fieldName: 'EditorID', values: {} }),
  ]));

  it('nothing collapsed shows every row, and the navigation starts at the Record Header', () => {
    expect(visibleRows(rows, new Set())).toEqual(rows);
    expect(navRows(rows, new Set()).map(r => r.key))
      .toEqual([RECORD_HEADER_ROW, 'Record Header.Version', 'Bounds', 'Bounds.X', 'Bounds.Y', 'EditorID']);
  });

  it('a collapsed row hides everything beneath it and is itself shown, not expanded', () => {
    const nav = navRows(rows, new Set(['Bounds']));

    expect(nav.map(r => r.key)).toEqual([RECORD_HEADER_ROW, 'Record Header.Version', 'Bounds', 'EditorID']);
    expect(nav.find(r => r.key === 'Bounds')).toEqual({ key: 'Bounds', parent: null, expandable: true, expanded: false, holdsRun: false });
  });

  it('a collapsed Record Header hides its members', () => {
    expect(navRows(rows, new Set([RECORD_HEADER_ROW])).map(r => r.key))
      .toEqual([RECORD_HEADER_ROW, 'Bounds', 'Bounds.X', 'Bounds.Y', 'EditorID']);
  });

  it('a collapsed row hides its grandchildren too', () => {
    const header = fieldMeta({ ...bounds, name: 'Hdr', isRecordHeaderMember: true });
    const nested = recordRows({
      result: answer([header], [diffNode({
        fieldName: 'Hdr', values: {}, children: [diffNode({ fieldName: 'X', values: {} })],
      })]),
      columns: [], editableColumns: new Set(), partialFormColumns: new Set(), recordLabel: () => '',
    });

    expect(navRows(nested, new Set([RECORD_HEADER_ROW])).map(r => r.key)).toEqual([RECORD_HEADER_ROW]);
  });
});

describe('a union element', () => {
  it('its rows are its members, each cell reading the leaf its own column\'s element names', () => {
    const refLocation = fieldMeta({ name: 'location', type: 'struct', displayLabel: 'Ref location' });
    const location = fieldMeta({ name: 'location', type: 'struct', variants: { RefAlias: refLocation } });
    const aliases = fieldMeta({
      name: 'aliases', type: 'array', isArray: true,
      elementType: fieldMeta({
        name: '', type: 'struct',
        fields: [fieldMeta({ name: 'Kind', type: 'string', isDiscriminator: true }), fieldMeta({ name: 'name', type: 'string' }), location],
      }),
    });
    const master = { Kind: 'RefAlias', name: 'AnAlias', location: { id: 5 } };
    const override = { Kind: 'LocAlias', name: 'AnAlias', location: null };
    const rows = fieldRowsOf(rowsFor(answer([aliases], [diffNode({
      fieldName: 'aliases', values: {},
      children: [diffNode({
        fieldName: '[0]', values: { [MASTER]: master, [MOD]: override },
        children: [
          diffNode({ fieldName: 'name', values: { [MASTER]: 'AnAlias', [MOD]: 'AnAlias' } }),
          diffNode({ fieldName: 'location', values: { [MASTER]: { id: 5 }, [MOD]: null }, winnerColumn: MASTER }),
        ],
      })],
    })])));
    const element = rows[1];
    const member = rows[3];

    expect(rows.map(r => r.key)).toEqual(['aliases', 'aliases.[0]', 'aliases.[0].name', 'aliases.[0].location']);
    expect(member?.cells.get(MASTER)?.shown).toEqual({ id: 5 });
    expect(member?.cells.get(MOD)?.holds).toBe(false);
    expect(member?.cells.get(MOD)?.shown).toBeUndefined();
    expect(member?.depth).toBe(2);
    expect(member?.cells.get(MASTER)?.meta).toBe(refLocation);
    expect(member?.cells.get(MOD)?.meta).toBe(location);
    expect(member?.meta).toBe(refLocation);
    expect(element?.cells.get(MOD)?.meta).toBe(aliases.elementType);
  });

  it('a member whose columns hold different leaves takes its shape from the column mEdit names its winner, so every member mEdit sends is a row', () => {
    const refLocation = fieldMeta({ name: 'location', type: 'struct', fields: [fieldMeta({ name: 'ref', type: 'int' })] });
    const locLocation = fieldMeta({ name: 'location', type: 'struct', fields: [fieldMeta({ name: 'loc', type: 'int' })] });
    const location = fieldMeta({ name: 'location', type: 'struct', variants: { RefAlias: refLocation, LocAlias: locLocation } });
    const aliases = fieldMeta({
      name: 'aliases', type: 'array', isArray: true,
      elementType: fieldMeta({
        name: '', type: 'struct', fields: [fieldMeta({ name: 'Kind', type: 'string', isDiscriminator: true }), location],
      }),
    });
    const master = { Kind: 'RefAlias', location: { ref: 1 } };
    const override = { Kind: 'LocAlias', location: { loc: 2 } };
    const rows = fieldRowsOf(rowsFor(answer([aliases], [diffNode({
      fieldName: 'aliases', values: {},
      children: [diffNode({
        fieldName: '[0]', values: { [MASTER]: master, [MOD]: override },
        children: [diffNode({
          fieldName: 'location', values: { [MASTER]: master.location, [MOD]: override.location }, winnerColumn: MOD,
          children: [diffNode({ fieldName: 'loc', values: { [MASTER]: null, [MOD]: 2 }, winnerColumn: MOD })],
        })],
      })],
    })])));

    expect(rows.map(r => r.key)).toEqual(['aliases', 'aliases.[0]', 'aliases.[0].location', 'aliases.[0].location.loc']);
    expect(rows[2]?.meta).toBe(locLocation);
  });
});

describe('a condition\'s parameters', () => {
  const kind = fieldMeta({
    name: 'MutagenObjectType', type: 'enum', isDiscriminator: true,
    enumMembers: [{ value: 'LeafA', bitValue: null, label: null }, { value: 'LeafB', bitValue: null, label: null }],
  });
  const dataRows = (fields: FieldMetadata[], master: Record<string, unknown>, mod: Record<string, unknown>, member: string) =>
    fieldRowsOf(rowsFor(answer([fieldMeta({ name: 'Data', type: 'struct', fields: [kind, ...fields] })], [diffNode({
      fieldName: 'Data', values: { [MASTER]: master, [MOD]: mod },
      children: [diffNode({ fieldName: member, values: { [MASTER]: master[member], [MOD]: mod[member] } })],
    })])));

  it('a form parameter takes the shape its own column\'s owner gives it', () => {
    const target = fieldMeta({ name: 'Target', type: 'formKey', indexWhen: ['UseAliases'] });
    const link = fieldMeta({ name: 'Target', type: 'formKey', variants: { LeafA: target } });

    const row = dataRows(
      [link],
      { MutagenObjectType: 'LeafA', Target: '000801:Fallout4.esm' },
      { MutagenObjectType: 'LeafA', UseAliases: true, Target: 3 },
      'Target').find(r => r.name === 'Target');

    expect(row?.cells.get(MOD)?.meta.type).toBe('int');
  });

  it('a parameter has a row where its own column\'s function puts it in use', () => {
    const linkUnderA = fieldMeta({ name: 'Mode', type: 'enum', siblingsInUse: { A: ['Link'], B: [] } });
    const linkUnderB = fieldMeta({ name: 'Mode', type: 'enum', siblingsInUse: { A: [], B: ['Link'] } });
    const mode = fieldMeta({ ...linkUnderA, variants: { LeafA: linkUnderA, LeafB: linkUnderB } });
    const value = { MutagenObjectType: 'LeafB', Mode: 'B', Link: '000801:Fallout4.esm' };

    const rows = dataRows([mode, fieldMeta({ name: 'Link', type: 'formKey' })], value, value, 'Link');

    expect(rows.map(r => r.name)).toContain('Link');
  });

  it('a parameter any column\'s function puts in use has a row, so a conflicting override never hides its own data', () => {
    const mode = fieldMeta({ name: 'Mode', type: 'enum', siblingsInUse: { A: ['Link'], B: [] } });
    const link = fieldMeta({ name: 'Link', type: 'formKey' });

    const rows = dataRows([mode, link],
      { MutagenObjectType: 'LeafA', Mode: 'B', Link: '000801:Fallout4.esm' },
      { MutagenObjectType: 'LeafA', Mode: 'A', Link: '000801:Fallout4.esm' }, 'Link');

    expect(rows.map(r => r.name)).toEqual(['Data', 'Link']);
  });
});

describe('a cell\'s context, which its right-click hands a command and the host\'s keys read while it is focused', () => {
  const level = fieldMeta({ name: 'Level', type: 'int' });
  const rows = fieldRowsOf(rowsFor(answer([level], [diffNode({ fieldName: 'Level', values: { [MASTER]: 5, [MOD]: 7 } })]), [MOD]));
  const row = rows[0];

  it('a cell that reads empty copies the empty text', () => {
    const name = fieldMeta({ name: 'Name', type: 'string' });
    const [empty] = fieldRowsOf(rowsFor(answer([name], [diffNode({ fieldName: 'Name', values: { [MASTER]: '' } })])));
    expect(empty?.cells.get(MASTER)?.context.copyText).toBe('');
  });

  it('the label cell copies its label', () => {
    expect(row?.label.context).toEqual({ webviewSection: 'cell', copyText: 'Level', preventDefaultContextMenuItems: true });
  });
});

describe('a translated string\'s cell', () => {
  const name = fieldMeta({ name: 'Name', type: 'translatedString' });
  const held = { TargetLanguage: 'English', Values: [{ Language: 'English', String: 'Old' }, { Language: 'French', String: 'Vieux' }] };
  const result = { ...answer([name], [diffNode({ fieldName: 'Name', values: { [MASTER]: held } })]), stringsLanguage: 'French' };

  it('shows its text in the comparison\'s strings language, and holds the document\'s value', () => {
    expect(fieldRowsOf(rowsFor(result))[0]?.cells.get(MASTER)).toMatchObject({ shown: 'Vieux', value: held });
  });
});

describe('the focused cell, as the grid shows it', () => {
  const rows = rowsFor(answer([bounds], [boundsDiff]), [MOD]);
  const none = new Set<string>();

  it('is the cell its row and column name, the label column included', () => {
    expect(shownCell(rows, none, new Set(), { rowKey: 'Bounds.X', plugin: MOD })?.context)
      .toMatchObject({ webviewSection: 'cell editableCell', copyText: '3' });
    expect(shownCell(rows, none, new Set(), { rowKey: 'Bounds.X', plugin: null })?.context).toMatchObject({ copyText: 'X' });
  });

  it.each([
    ['its row is collapsed away', new Set(['Bounds']), new Set<ColumnKey>(), 'Bounds.X'],
    ['its column is collapsed', none, new Set([MOD]), 'Bounds.X'],
    ['its row is gone', none, new Set<ColumnKey>(), 'Gone'],
  ])('is none while %s', (_case, collapsedRows, collapsedColumns, rowKey) => {
    expect(shownCell(rows, collapsedRows, collapsedColumns, { rowKey, plugin: MOD })).toBeUndefined();
  });
});

describe('the record header rows\' cells', () => {
  const result = compareResultFixture({
    overrides: ['Fallout4.esm', 'MyMod.esp'].map(plugin => compareOverride({
      formKey: '000001:Fallout4.esm', plugin, editorId: 'TestNPC', fields: [{ metadata: formId, value: null }],
    })),
    diffs: [diffNode({ fieldName: 'FormID', values: {} })],
  });
  const rows = rowsFor(result);

  it('the Record Header is the first row; its label copies its name and its other cells copy nothing', () => {
    const [header] = rows;
    expect(header?.key).toBe(RECORD_HEADER_ROW);
    expect(header?.label.context).toEqual({ webviewSection: 'cell', copyText: 'Record Header', preventDefaultContextMenuItems: true });
    expect(header?.cells.get(MOD)?.context).toEqual({ webviewSection: 'cell', preventDefaultContextMenuItems: true });
  });

  it('a FormID cell copies its copy\'s FormKey as it reads', () => {
    const row = rows.find(r => r.key === FORM_ID_ROW);
    expect(row?.label.context).toEqual({ webviewSection: 'cell', copyText: 'FormID', preventDefaultContextMenuItems: true });
    expect(row?.cells.get(MOD)?.context)
      .toEqual({ webviewSection: 'cell', copyText: 'TestNPC [000001:Fallout4.esm]', preventDefaultContextMenuItems: true });
  });
});

describe('a union element\'s member only some leaves declare', () => {
  const only = (leaf: string) => fieldMeta({ name: 'external', type: 'struct', variants: { [leaf]: fieldMeta({ name: 'external', type: 'struct' }) } });
  const aliases = fieldMeta({
    name: 'aliases', type: 'array', isArray: true,
    elementType: fieldMeta({
      name: '', type: 'struct',
      fields: [fieldMeta({ name: 'Kind', type: 'string', isDiscriminator: true }), only('LocAlias')],
    }),
  });
  const rows = fieldRowsOf(rowsFor(answer([aliases], [diffNode({
    fieldName: 'aliases', values: {},
    children: [diffNode({
      fieldName: '[0]', values: { [MASTER]: { Kind: 'RefAlias', external: null }, [MOD]: { Kind: 'LocAlias', external: { id: 7 } } },
      children: [diffNode({ fieldName: 'external', values: { [MASTER]: null, [MOD]: { id: 7 } } })],
    })],
  })])));
  const external = rows.find(r => r.key === 'aliases.[0].external');

  it('is a row, held by the columns whose leaf declares it', () => {
    expect([MASTER, MOD].map(c => external?.cells.get(c)?.holds)).toEqual([false, true]);
  });
});

describe('a cell in a column that cannot be edited', () => {
  const name = fieldMeta({ name: 'Name', type: 'string' });
  const names = fieldMeta({ name: 'Names', type: 'array', isArray: true, elementType: fieldMeta({ name: '', type: 'string' }) });
  const rows = fieldRowsOf(rowsFor(answer([name, names], [
    diffNode({ fieldName: 'Name', values: { [MASTER]: 'A', [MOD]: 'B' } }),
    diffNode({
      fieldName: 'Names', values: { [MASTER]: ['A'], [MOD]: ['B'] },
      children: [diffNode({ fieldName: '[0]', values: { [MASTER]: 'A', [MOD]: 'B' } })],
    }),
  ]), [MASTER]));

  it.each([
    ['a string offers the extended editor read-only', 'Name', { webviewSection: 'cell stringValue', readOnly: true }],
    ['an array offers no array command', 'Names', { webviewSection: 'cell' }],
  ])('%s', (_what, key, expected) => {
    expect(rows.find(r => r.key === key)?.cells.get(MOD)?.context).toMatchObject(expected);
  });
});

describe('a member the document omits', () => {
  const memberOf = (
    metas: FieldMetadata[], diffs: CompareResult['diffs'], key: string, options: { partial?: boolean } = {},
  ) => {
    const result = answer(metas, diffs, options.partial);
    return fieldRowsOf(rowsFor(result, [MASTER, MOD], options.partial ? [MOD] : [])).find(r => r.key === key)?.cells.get(MOD);
  };
  const struct = (name: string, fields: FieldMetadata[], allowsNull = false) => fieldMeta({ name, type: 'struct', fields, allowsNull });
  const memberDiff = (name: string, master: unknown) => diffNode({ fieldName: name, values: { [MASTER]: master, [MOD]: null } });

  const stats = struct('Stats', [
    fieldMeta({ name: 'Weight', type: 'int' }),
    fieldMeta({ name: 'Essential', type: 'bool' }),
    fieldMeta({ name: 'Prefix', type: 'string' }),
    fieldMeta({ name: 'RunOn', type: 'enum', default: 'Subject', enumMembers: [{ value: 'Subject' }, { value: 'Target' }] }),
    fieldMeta({ name: 'Count', type: 'int', default: 100 }),
    fieldMeta({ name: 'Owner', type: 'formKey', validFormKeyTypes: ['NPC_'], allowsNull: true }),
  ]);
  const statsDiff = diffNode({
    fieldName: 'Stats', values: { [MASTER]: { Weight: 3 }, [MOD]: {} },
    children: ['Weight', 'Essential', 'Prefix', 'RunOn', 'Count', 'Owner'].map(name => memberDiff(name, 'x')),
  });

  it.each([
    ['an int', 'Weight', 0],
    ['a bool', 'Essential', false],
    ['a string', 'Prefix', ''],
    ['an enum, the default its metadata names', 'RunOn', 'Subject'],
    ['a scalar with a declared default', 'Count', 100],
    ['a nullable link, which has no default to read', 'Owner', undefined],
  ])('of a struct the column holds reads as its default: %s', (_kind, name, expected) => {
    const cell = memberOf([stats], [statsDiff], `Stats.${name}`);

    expect(cell?.holds).toBe(true);
    expect(cell?.value).toEqual(expected);
  });

  const size = struct('Size', [
    fieldMeta({ name: 'Width', type: 'int' }),
    fieldMeta({ name: 'Label', type: 'string' }),
    fieldMeta({ name: 'Depth', type: 'int', default: 12 }),
  ]);
  const sizeDiff = diffNode({
    fieldName: 'Size', values: { [MASTER]: { Width: 3, Label: 'x', Depth: 7 }, [MOD]: null },
    children: ['Width', 'Label', 'Depth'].map(name => memberDiff(name, 1)),
  });

  it.each([
    ['Size', undefined],
    ['Size.Width', 0],
    ['Size.Label', ''],
    ['Size.Depth', 12],
  ])('a non-nullable struct it omits is held at its defaults: %s', (key, value) => {
    const cell = memberOf([size], [sizeDiff], key);

    expect(cell?.holds).toBe(true);
    expect(cell?.value).toEqual(value);
  });

  const unsetStruct = struct('Bounds', [fieldMeta({ name: 'X', type: 'int' })], true);
  const unsetDiff = diffNode({
    fieldName: 'Bounds', values: { [MASTER]: { X: 10 }, [MOD]: null }, children: [memberDiff('X', 10)],
  });
  const values = fieldMeta({ name: 'Values', type: 'array', isArray: true, elementType: fieldMeta({ name: '', type: 'int' }) });
  const valuesDiff = diffNode({
    fieldName: 'Values', values: { [MASTER]: [1, 2], [MOD]: [1] },
    children: [diffNode({ fieldName: '[0]', values: { [MASTER]: 1, [MOD]: 1 } }), memberDiff('[1]', 2)],
  });

  it.each([
    ['a nullable struct it leaves unset', unsetStruct, unsetDiff, 'Bounds'],
    ['a member of that unset struct', unsetStruct, unsetDiff, 'Bounds.X'],
    ['an element past its own array\'s length', values, valuesDiff, 'Values.[1]'],
  ])('is nothing in the column that holds no owner for it: %s', (_kind, meta, diff, key) => {
    const cell = memberOf([meta], [diff], key);

    expect(cell?.holds).toBe(false);
    expect(cell?.shown).toBeUndefined();
  });

  it.each([
    ['a field', fieldMeta({ name: 'Name', type: 'string' }), 'Name', diffNode({ fieldName: 'Name', values: { [MASTER]: 'Original', [MOD]: null } })],
    ['a non-nullable struct, whose absence would read as its default', size, 'Size', sizeDiff],
    ['a member of that struct', size, 'Size.Width', sizeDiff],
  ])('is nothing in a Partial Form column, which holds none of the record\'s own fields: %s', (_kind, meta, key, diff) => {
    const cell = memberOf([meta], [diff], key, { partial: true });

    expect(cell?.holds).toBe(false);
    expect(cell?.shown).toBeUndefined();
  });
});
