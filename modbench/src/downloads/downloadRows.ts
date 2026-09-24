// How the Downloads tree presents the rows the Instance publishes. None of it touches a file, so
// none of it belongs to the codec that parsed one.

import { extname } from 'node:path';
import type { DownloadRow } from '../instanceLoader/instance';
import { ARCHIVE_EXTENSIONS } from '../install/install';

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

/** `showHidden` keeps the flags intact, so the dimming decoration can still tell hidden rows
 *  apart. */
export function filterHiddenRows<T extends DownloadRow>(rows: readonly T[], showHidden: boolean): T[] {
  return showHidden ? [...rows] : rows.filter((r) => !r.hidden);
}

const archiveExtensions: readonly string[] = ARCHIVE_EXTENSIONS;

/** Only the files install can take are rows, by install's own extension list. Unconditional,
 *  unlike `filterHiddenRows`: no toggle brings a non-archive back. */
export function filterArchiveRows<T extends DownloadRow>(rows: readonly T[]): T[] {
  return rows.filter((r) => archiveExtensions.includes(extname(r.name).slice(1).toLowerCase()));
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
