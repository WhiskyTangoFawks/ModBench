import { cellContext, type Column } from './recordUtils';
import type { RecordRow, RunRow } from './recordRows';
import type { ColumnKey, ConflictThis } from './types';

const TAKES_PART: readonly ConflictThis[] = ['Override', 'ConflictWins', 'ConflictLoses'];

const runKey = (firstRowKey: string): string => `run:${firstRowKey}`;

interface Collapse {
  severalRecords: boolean;
  restored: ReadonlySet<string>;
}

function agrees(row: RecordRow, severalRecords: boolean): boolean {
  switch (row.kind) {
    case 'recordHeader': return true;
    case 'run': return false;
    case 'formId': return !severalRecords;
    case 'field':
      if (row.meta.isVersionControlInfo1) return true;
      return severalRecords
        ? row.diff.conflictAll !== 'ConflictBenign'
        : !Object.values(row.diff.cellStates).some(state => TAKES_PART.includes(state));
  }
}

function quietKeys(rows: readonly RecordRow[], { severalRecords, restored }: Collapse): Set<string> {
  const quiet = new Set<string>();
  const stays = new Set<string>();
  for (const row of [...rows].reverse()) {
    if (agrees(row, severalRecords) && !restored.has(row.key) && !stays.has(row.key)) quiet.add(row.key);
    else if (row.parent !== null) stays.add(row.parent);
  }
  return quiet;
}

function runRow(held: readonly RecordRow[]): RunRow {
  const [first] = held;
  if (!first) throw new Error('A run holds rows.');
  return {
    kind: 'run', key: runKey(first.key), parent: first.parent, depth: first.depth, expandable: true,
    name: `${held.length} rows`, holds: held.map(row => row.key), label: { context: cellContext(undefined) }, cells: new Map(),
  };
}

/** editor.md, Rows, story 6: the rows with each run of rows no copy changes held by one row, but
 *  the rows a restore showed. */
export function collapseRuns(rows: readonly RecordRow[], collapse: Collapse): RecordRow[] {
  const quiet = quietKeys(rows, collapse);
  const groups: { rows: RecordRow[]; quiet: boolean }[] = [];
  for (const row of rows) {
    const run = groups.at(-1);
    const joins = quiet.has(row.key) && run?.quiet === true
      && ((row.parent !== null && quiet.has(row.parent)) || run.rows[0]?.parent === row.parent);
    if (joins) run.rows.push(row);
    else groups.push({ rows: [row], quiet: quiet.has(row.key) });
  }
  return groups.flatMap(({ rows: held, quiet: isRun }) => {
    return isRun && held.length > 1 ? [runRow(held)] : held;
  });
}

/** editor.md, Columns, story 9: the columns whose copy is identical to the master, but the file's.
 *  A column's own state is its worst cell, so IdenticalToMaster says every cell is. */
export function quietColumns(
  columns: readonly Column[], { severalRecords, fileColumn }: { severalRecords: boolean; fileColumn: ColumnKey | undefined },
): Set<ColumnKey> {
  if (severalRecords) return new Set();
  return new Set(columns.filter(({ key, override }) => override.conflictThis === 'IdenticalToMaster' && key !== fileColumn).map(({ key }) => key));
}
