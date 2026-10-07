// mods-conflicts.md, Cells: a file's row state and each copy's cell state, from which copies are the same.

import type { Copy } from '../instanceLoader/instance';
import type { ConflictCellState, ConflictRowState } from '../wire/conflictTable';

interface FileStates {
  readonly row: ConflictRowState | null;
  /** One for each copy, in the copies' order. */
  readonly cells: readonly (ConflictCellState | null)[];
}

const CELL_SEVERITY: readonly ConflictCellState[] = ['IdenticalToMaster', 'Master', 'Override', 'ConflictWins', 'ConflictLoses'];
const ROW_SEVERITY: readonly ConflictRowState[] = ['NoConflict', 'Override', 'Conflict'];

function worst<T>(severity: readonly T[], states: readonly (T | null)[]): T | null {
  return states.reduce<T | null>((acc, state) =>
    (state !== null && (acc === null || severity.indexOf(state) > severity.indexOf(acc)) ? state : acc), null);
}

export const worstCell = (states: readonly (ConflictCellState | null)[]): ConflictCellState | null => worst(CELL_SEVERITY, states);
export const worstRow = (states: readonly (ConflictRowState | null)[]): ConflictRowState | null => worst(ROW_SEVERITY, states);

/** A row's copies, winning-most first. A copy that cannot be read leaves every state unknown,
 *  since the others are told apart by it. */
export function fileStates(copies: readonly Copy[]): FileStates {
  const groups = copies.map((copy) => (copy.kind === 'read' ? copy.sameAs : undefined));
  const unknown: FileStates = { row: null, cells: copies.map(() => null) };
  if (copies.length === 0 || groups.includes(undefined)) return unknown;
  const winner = groups[0];
  const masterIndex = groups.length - 1;
  const master = groups[masterIndex];
  const differing = groups.filter((group) => group !== master);
  const row: ConflictRowState = differing.length === 0 ? 'NoConflict'
    : differing.every((group) => group === winner) ? 'Override' : 'Conflict';
  const cells = groups.map((group, index): ConflictCellState => {
    if (index === masterIndex) return 'Master';
    if (row === 'Conflict' && group === winner) return 'ConflictWins';
    if (group !== master && group !== winner) return 'ConflictLoses';
    return group === master ? 'IdenticalToMaster' : 'Override';
  });
  return { row, cells };
}
