// How the Downloads tree presents the rows the Instance publishes. None of it touches a file, so
// none of it belongs to the codec that parsed one.

import type { DownloadRow } from '../instanceLoader/instance';
import { isArchiveName } from '../install/install';

/** The columns MO2's own Downloads pane sorts by. `name` means the label (downloads.md, Order
 *  and view state, story 2), so it reads `displayName`, not the row's `name` field. */
export type DownloadSortColumn = 'name' | 'status' | 'size' | 'mtimeMs';

function sortValue(row: DownloadRow, column: DownloadSortColumn): string | number {
  return column === 'name' ? row.displayName : row[column];
}

export function sortDownloadRows<T extends DownloadRow>(
  rows: readonly T[],
  column: DownloadSortColumn,
  descending: boolean,
): T[] {
  // Negate the comparator for descending, don't reverse the sorted array —
  // reversing would also reverse tied rows, undoing the sort's stability.
  const dir = descending ? -1 : 1;
  return [...rows].sort((a, b) => {
    const av = sortValue(a, column);
    const bv = sortValue(b, column);
    if (av < bv) return -dir;
    if (av > bv) return dir;
    return 0;
  });
}

/** `showExcluded` keeps the flags intact, so the dimming decoration can still tell excluded rows
 *  apart. */
export function filterExcludedRows<T extends DownloadRow>(rows: readonly T[], showExcluded: boolean): T[] {
  return showExcluded ? [...rows] : rows.filter((r) => !r.excluded);
}

/** Only the files install can take are rows, by install's own extension list. Unconditional,
 *  unlike `filterExcludedRows`: no toggle brings a non-archive back. */
export function filterArchiveRows<T extends DownloadRow>(rows: readonly T[]): T[] {
  return rows.filter((r) => isArchiveName(r.name));
}

// A space-separated flag string, because `when` clauses match it with
// `viewItem =~ /\bflag\b/`: flags appear only when true, and the word-boundary
// regex makes any one of them testable regardless of the others.
export function downloadContextValue(row: DownloadRow): string {
  const flags = [
    row.modID !== undefined && 'hasModID',
    row.hasMeta && 'hasMeta',
    row.excluded && 'excluded',
  ].filter((f): f is string => f !== false);
  return ['download', ...flags].join(' ');
}
