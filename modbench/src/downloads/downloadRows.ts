// How the Downloads tree presents the rows the Instance publishes. None of it touches a file, so
// none of it belongs to the codec that parsed one.

import type { DownloadRow } from '../instanceLoader/instance';

/** The columns MO2's own Downloads pane sorts by, each a field of the row itself. */
export type DownloadSortColumn = 'name' | 'status' | 'size' | 'mtimeMs';

export function sortDownloadRows<T extends DownloadRow>(
  rows: readonly T[],
  column: DownloadSortColumn,
  descending: boolean,
): T[] {
  // Negate the comparator for descending, don't reverse the sorted array —
  // reversing would also reverse tied rows, undoing the sort's stability.
  const dir = descending ? -1 : 1;
  return [...rows].sort((a, b) => {
    const av = a[column];
    const bv = b[column];
    if (av < bv) return -dir;
    if (av > bv) return dir;
    return 0;
  });
}

/** `showHidden` keeps the flags intact, so the dimming decoration can still tell hidden rows
 *  apart. */
export function filterHiddenRows<T extends DownloadRow>(rows: readonly T[], showHidden: boolean): T[] {
  return showHidden ? [...rows] : rows.filter((r) => !r.hidden);
}

// A space-separated flag string, because `when` clauses match it with
// `viewItem =~ /\bflag\b/`: flags appear only when true, and the word-boundary
// regex makes any one of them testable regardless of the others.
export function downloadContextValue(row: DownloadRow): string {
  const flags = [
    row.modID !== undefined && 'hasModID',
    row.hasMeta && 'hasMeta',
    row.hidden && 'hidden',
  ].filter((f): f is string => f !== false);
  return ['download', ...flags].join(' ');
}
