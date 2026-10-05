import { describe, it, expect } from 'vitest';
import { compareOverride, compareResultFixture, diffNode, fieldMeta } from './test/fixtures';
import { buildColumns } from './recordUtils';
import { columnKey } from './columnKey';
import { navRows, recordRows, visibleRows, RECORD_HEADER_ROW, type FieldRow, type RecordRow } from './recordRows';
import type { ColumnKey, CompareResult, FieldMetadata } from './types';

const MASTER = columnKey('Fallout4.esm', null);
const MOD = columnKey('MyMod.esp', null);

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
    editableColumns: new Set(editable), partialFormColumns: new Set(partial),
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

    expect(rows.map(r => [r.key, r.parent, r.depth])).toEqual([
      ['Bounds', null, 0], ['Bounds.X', 'Bounds', 1], ['Bounds.Y', 'Bounds', 1],
    ]);
    expect(rows.map(r => r.expandable)).toEqual([true, false, false]);
  });

  it('rows come in the order of the diffs', () => {
    const rows = rowsFor(answer([bounds, editorId], [
      diffNode({ fieldName: 'EditorID', values: {} }), diffNode({ fieldName: 'Bounds', values: {} }),
    ]));

    expect(rows.map(r => r.key)).toEqual(['EditorID', 'Bounds']);
  });

  it('two elements sharing a key are rows of their own, the second keyed by its turn', () => {
    const rows = rowsFor(answer([keywords], [diffNode({
      fieldName: 'Keywords', values: {},
      children: [
        diffNode({ fieldName: 'Keyword', values: { [MOD]: 1 } }),
        diffNode({ fieldName: 'Keyword', values: { [MOD]: 2 } }),
      ],
    })]));

    expect(rows.map(r => r.key)).toEqual(['Keywords', 'Keywords.Keyword', 'Keywords.Keyword#2']);
  });

  it('an element row is present in the columns that hold it and the last element is known per column', () => {
    const first = diffNode({ fieldName: 'Keyword', values: { [MASTER]: 1, [MOD]: 1 }, indexes: { [MASTER]: 0, [MOD]: 0 } });
    const second = diffNode({ fieldName: 'Keyword', values: { [MOD]: 2 }, indexes: { [MOD]: 1 } });
    const rows = rowsFor(answer([keywords], [diffNode({ fieldName: 'Keywords', values: {}, children: [first, second] })]));
    const [, one, two] = fieldRowsOf(rows);

    expect([MASTER, MOD].map(c => two?.present(c))).toEqual([false, true]);
    expect([MASTER, MOD].map(c => one?.present(c))).toEqual([true, true]);
    expect([MASTER, MOD].map(c => one?.isLastElement?.(c))).toEqual([true, false]);
  });

  it('a diff node whose member no schema declares has no row, nor has its subtree', () => {
    const rows = rowsFor(answer([bounds], [
      diffNode({ fieldName: 'Mystery', values: {}, children: [diffNode({ fieldName: 'Child', values: {} })] }),
      boundsDiff,
    ]));

    expect(rows.map(r => r.key)).toEqual(['Bounds', 'Bounds.X', 'Bounds.Y']);
  });

  it('the Record Header members come first, under the header, the FormID as a row of its own', () => {
    const rows = rowsFor(answer([editorId, version, formId], [
      diffNode({ fieldName: 'EditorID', values: {} }),
      diffNode({ fieldName: 'Version', values: {} }),
      diffNode({ fieldName: 'FormID', values: {} }),
    ]));

    expect(rows.map(r => [r.key, r.kind, r.parent, r.depth])).toEqual([
      ['Record Header.Version', 'field', RECORD_HEADER_ROW, 1],
      ['Record Header.FormID', 'formId', RECORD_HEADER_ROW, 1],
      ['EditorID', 'field', null, 0],
    ]);
  });

  it('a Partial Form column can write the EditorID and no other field of its own', () => {
    const rows = fieldRowsOf(rowsFor(
      answer([editorId, bounds], [diffNode({ fieldName: 'EditorID', values: {} }), diffNode({ fieldName: 'Bounds', values: {} })]),
      [MASTER, MOD], [MOD],
    ));
    const [id, struct] = rows;

    expect([...(id?.editable ?? [])]).toEqual([MASTER, MOD]);
    expect([...(struct?.editable ?? [])]).toEqual([MASTER]);
    expect([MASTER, MOD].map(c => id?.present(c))).toEqual([true, true]);
    expect([MASTER, MOD].map(c => struct?.present(c))).toEqual([true, false]);
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
    expect(nav.find(r => r.key === 'Bounds')).toEqual({ key: 'Bounds', parent: null, expandable: true, expanded: false });
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
      columns: [], editableColumns: new Set(), partialFormColumns: new Set(),
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
        fields: [fieldMeta({ name: 'Kind', type: 'string', isDiscriminator: true }), location],
      }),
    });
    const master = { Kind: 'RefAlias', location: { id: 5 } };
    const override = { Kind: 'LocAlias', location: null };
    const rows = fieldRowsOf(rowsFor(answer([aliases], [diffNode({
      fieldName: 'aliases', values: {},
      children: [diffNode({
        fieldName: '[0]', values: { [MASTER]: master, [MOD]: override },
        children: [diffNode({ fieldName: 'location', values: { [MASTER]: { id: 5 }, [MOD]: null } })],
      })],
    })])));
    const element = rows[1];
    const member = rows[2];

    expect(rows.map(r => r.key)).toEqual(['aliases', 'aliases.[0]', 'aliases.[0].location']);
    expect(member?.depth).toBe(2);
    expect(member?.cellMetas?.[MASTER]).toBe(refLocation);
    expect(member?.cellMetas?.[MOD]).toBe(location);
    expect(member?.meta).toBe(refLocation);
    expect(element?.cellMetas).toBeUndefined();
  });
});
