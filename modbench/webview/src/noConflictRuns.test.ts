import { describe, it, expect } from 'vitest';
import { compareOverride, compareResultFixture, diffNode, fieldMeta } from './test/fixtures';
import { buildColumns } from './recordUtils';
import { columnKey } from '../../src/wire/columnKey';
import { recordRows, type RecordRow } from './recordRows';
import { collapseRuns, quietColumns } from './noConflictRuns';
import type { CompareResult, FieldDiff, FieldMetadata } from './types';

const MASTER = columnKey({ name: 'Fallout4.esm', origin: 'Data/' });
const MOD = columnKey({ name: 'MyMod.esp', origin: 'Data/' });

const scalar = (name: string) => fieldMeta({ name, type: 'int' });
const bounds = fieldMeta({ name: 'Bounds', type: 'struct', fields: [scalar('X'), scalar('Y')] });
const version = fieldMeta({ name: 'Version', type: 'int', isRecordHeaderMember: true, isVersionControlInfo1: true });

const agree = (name: string): FieldDiff =>
  diffNode({ fieldName: name, values: { [MASTER]: 1, [MOD]: 1 }, cellStates: { [MOD]: 'IdenticalToMaster' } });
const differ = (name: string, state: 'Override' | 'ConflictWins' | 'ConflictLoses' = 'Override'): FieldDiff =>
  diffNode({ fieldName: name, values: { [MASTER]: 1, [MOD]: 2 }, cellStates: { [MOD]: state }, conflictAll: 'Override' });

function rowsOf(fieldMetas: FieldMetadata[], fieldDiffs: FieldDiff[], columns: readonly string[] = [MASTER, MOD]): RecordRow[] {
  const metas = [scalar('Lead'), ...fieldMetas];
  const lead = { ...differ('Lead'), conflictAll: 'ConflictBenign' as const };
  const diffs = [lead, ...fieldDiffs];
  const fields = metas.map(metadata => ({ metadata, value: null }));
  const result: CompareResult = compareResultFixture({
    overrides: [
      compareOverride({ formKey: '000001:Fallout4.esm', plugin: 'Fallout4.esm', fields, column: columns[0] === MASTER ? undefined : columns[0] }),
      compareOverride({ formKey: '000001:Fallout4.esm', plugin: 'MyMod.esp', fields, column: columns[1] === MOD ? undefined : columns[1] }),
    ],
    diffs,
  });
  return recordRows({
    result, columns: buildColumns(result.overrides),
    editableColumns: new Set(), partialFormColumns: new Set(), recordLabel: () => 'TestNPC',
  });
}

const wholeGrid = (rows: RecordRow[], restored: string[] = [], severalRecords = false) =>
  collapseRuns(rows, { severalRecords, restored: new Set(restored) })
    .map(r => (r.kind === 'run' ? `${r.holds.length} rows` : r.key));
const collapsed = (rows: RecordRow[], restored: string[] = [], severalRecords = false) => {
  const grid = wholeGrid(rows, restored, severalRecords);
  return grid.slice(grid.indexOf('Lead') + 1);
};
const metas = ['A', 'B', 'C', 'D', 'E'].map(scalar);

describe('collapseRuns', () => {
  it('collapses each run of rows no copy changes into one row that counts them, and keeps the rows that differ', () => {
    const rows = rowsOf(metas, [agree('A'), agree('B'), differ('C'), agree('D'), agree('E')]);

    expect(collapsed(rows)).toEqual(['2 rows', 'C', '2 rows']);
  });

  it.each(['Override', 'ConflictWins', 'ConflictLoses'] as const)('keeps a row with a %s cell', (state) => {
    const rows = rowsOf(metas, [agree('A'), differ('B', state), agree('C')]);

    expect(collapsed(rows)).toEqual(['A', 'B', 'C']);
  });

  it('collapses the version stamps whatever their cells say, with the record header over them', () => {
    const rows = rowsOf([version, scalar('A')], [differ('Version'), differ('A')]);

    expect(wholeGrid(rows)).toEqual(['2 rows', 'Lead', 'A']);
  });

  it('keeps a struct while any row beneath it stays', () => {
    const rows = rowsOf([bounds, scalar('A'), scalar('B')], [
      diffNode({
        fieldName: 'Bounds', values: { [MASTER]: { X: 1, Y: 1 }, [MOD]: { X: 1, Y: 2 } },
        children: [agree('X'), differ('Y')],
      }),
      agree('A'), agree('B'),
    ]);

    expect(collapsed(rows)).toEqual(['Bounds', 'Bounds.X', 'Bounds.Y', '2 rows']);
  });

  it('collapses a struct whose members all agree, with them, as one run at its depth', () => {
    const rows = rowsOf([bounds, scalar('A')], [
      diffNode({ fieldName: 'Bounds', values: { [MASTER]: { X: 1, Y: 1 }, [MOD]: { X: 1, Y: 1 } }, children: [agree('X'), agree('Y')] }),
      agree('A'),
    ]);

    expect(collapseRuns(rows, { severalRecords: false, restored: new Set() }).find(row => row.kind === 'run')).toMatchObject({ kind: 'run', holds: ['Bounds', 'Bounds.X', 'Bounds.Y', 'A'], depth: 0, parent: null });
  });

  it('does not collapse a run of one row', () => {
    const rows = rowsOf(metas, [differ('A'), agree('B'), differ('C')]);

    expect(collapsed(rows)).toEqual(['A', 'B', 'C']);
  });

  it.each([
    ['shows the rows a restore showed and leaves the other runs collapsed', [agree('A'), agree('B'), differ('C'), agree('D'), agree('E')], ['A', 'B'], ['A', 'B', 'C', '2 rows']],
    ['keeps a restored row shown when a re-read moves the start of its run', [agree('A'), agree('B'), agree('C'), differ('D'), agree('E')], ['B', 'C'], ['A', 'B', 'C', 'D', 'E']],
    ['collapses the rows no restore showed, around a differing row', [agree('A'), agree('B'), agree('C'), differ('D'), agree('E')], ['A'], ['A', '2 rows', 'D', 'E']],
  ])('%s', (_name, fields, restored, expected) => {
    expect(collapsed(rowsOf(metas, fields), restored)).toEqual(expected);
  });

  it('opened on several records, collapses a row unless the records disagree on it', () => {
    const rows = rowsOf(metas, [
      diffNode({ fieldName: 'A', values: { '0': 1, '1': 1 } }), diffNode({ fieldName: 'B', values: { '0': 1, '1': 1 } }),
      diffNode({ fieldName: 'C', values: { '0': 1, '1': 2 }, conflictAll: 'ConflictBenign' }),
      diffNode({ fieldName: 'D', values: { '0': 1, '1': 1 } }), diffNode({ fieldName: 'E', values: { '0': 1, '1': 1 } }),
    ], ['0', '1']);

    expect(collapsed(rows, [], true)).toEqual(['2 rows', 'C', '2 rows']);
  });
});

describe('quietColumns', () => {
  const keyOf = (plugin: string) => columnKey({ name: plugin, origin: 'Data/' });
  const columnOf = (plugin: string, conflictThis: 'Master' | 'IdenticalToMaster' | 'Override' | undefined) =>
    ({ key: keyOf(plugin), override: compareOverride({ formKey: '000001:Fallout4.esm', plugin, fields: [], conflictThis }) });
  const columns = [columnOf('Fallout4.esm', 'Master'), columnOf('Same.esp', 'IdenticalToMaster'), columnOf('Edit.esp', 'Override'), columnOf('File.esp', 'IdenticalToMaster')];

  it.each([
    ['the columns identical to the master, but the master\'s and the file\'s', columns, false, keyOf('File.esp'), ['Same.esp']],
    ['no column when several records are compared', columns, true, undefined, []],
    ['no column with no cell of its own', [columnOf('Fallout4.esm', 'Master'), columnOf('Empty.esp', undefined)], false, undefined, []],
  ] as const)('holds %s', (_name, given, severalRecords, fileColumn, held) => {
    expect(quietColumns(given, { severalRecords, fileColumn })).toEqual(new Set(held.map(keyOf)));
  });
});
