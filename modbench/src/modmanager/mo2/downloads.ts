// Pure model for the Downloads tab: turns a downloads/ directory listing plus
// each archive's .meta sidecar text into render-ready rows.
//
// .meta is a QSettings::IniFormat file MO2 writes beside each archive
// (mirrors modorganizer/src/downloadmanager.cpp). Status is one of three MVP
// values; the `removed=true` (hidden) flag is a separate axis owned by the
// Hide/Unhide ticket, not this one — not modeled here.

export type DownloadStatus = 'Installed' | 'Removed' | 'Downloaded';

/** A file in downloads/, pre-suppression: `.meta` sidecars still included so
 *  callers can pass a raw directory listing without filtering it themselves. */
export interface DownloadEntry {
  name: string;
  size: number;
  mtimeMs: number;
  metaText?: string;
}

export interface DownloadRow {
  name: string;
  status: DownloadStatus;
  size: number;
  mtimeMs: number;
}

export type DownloadSortColumn = 'name' | 'status' | 'size' | 'mtimeMs';

/** Re-sort rendered rows by column. Default sort (Filetime desc) is
 *  `sortDownloadRows(rows, 'mtimeMs', true)`. */
export function sortDownloadRows(
  rows: DownloadRow[],
  column: DownloadSortColumn,
  descending: boolean,
): DownloadRow[] {
  const sorted = [...rows].sort((a, b) => {
    const av = a[column];
    const bv = b[column];
    if (av < bv) return -1;
    if (av > bv) return 1;
    return 0;
  });
  return descending ? sorted.reverse() : sorted;
}

export function parseDownloadMeta(text: string): { status: DownloadStatus } {
  const values = new Map<string, string>();
  for (const raw of text.split(/\r\n|\r|\n/)) {
    const eq = raw.indexOf('=');
    if (eq === -1) continue;
    values.set(raw.slice(0, eq).trim(), raw.slice(eq + 1).trim());
  }
  let status: DownloadStatus = 'Downloaded';
  if (values.get('uninstalled') === 'true') status = 'Removed';
  else if (values.get('installed') === 'true') status = 'Installed';
  return { status };
}

/** Build render-ready rows: suppresses `.meta` sidecars as their own rows,
 *  and default-sorts Filetime desc. */
export function buildDownloadRows(entries: DownloadEntry[]): DownloadRow[] {
  const rows = entries
    .filter((e) => !e.name.endsWith('.meta'))
    .map((e) => ({ name: e.name, status: parseDownloadMeta(e.metaText ?? '').status, size: e.size, mtimeMs: e.mtimeMs }));
  return sortDownloadRows(rows, 'mtimeMs', true);
}
