import { cellContext } from './recordUtils';
import type { RecordRow, RunRow } from './recordRows';
import type { ConflictThis } from './types';

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

// A row is quiet when it agrees and every row beneath it does.
function quietKeys(rows: readonly RecordRow[], severalRecords: boolean): Set<string> {
  const quiet = new Set<string>();
  const stays = new Set<string>();
  for (const row of [...rows].reverse()) {
    if (agrees(row, severalRecords) && !stays.has(row.key)) quiet.add(row.key);
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
 *  the runs restored. */
export function collapseRuns(rows: readonly RecordRow[], { severalRecords, restored }: Collapse): RecordRow[] {
  const quiet = quietKeys(rows, severalRecords);
  const groups: { rows: RecordRow[]; quiet: boolean }[] = [];
  for (const row of rows) {
    const run = groups.at(-1);
    const joins = quiet.has(row.key) && run?.quiet === true
      && ((row.parent !== null && quiet.has(row.parent)) || run.rows[0]?.parent === row.parent);
    if (joins) run.rows.push(row);
    else groups.push({ rows: [row], quiet: quiet.has(row.key) });
  }
  return groups.flatMap(({ rows: held, quiet: isRun }) => {
    const first = held[0];
    return isRun && held.length > 1 && first && !restored.has(runKey(first.key)) ? [runRow(held)] : held;
  });
}
