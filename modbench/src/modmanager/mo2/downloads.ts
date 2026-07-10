// Pure model for the Downloads tab: turns a downloads/ directory listing plus
// each archive's .meta sidecar text into render-ready rows.
//
// .meta is a QSettings::IniFormat file MO2 writes beside each archive
// (mirrors modorganizer/src/downloadmanager.cpp). Status is one of three MVP
// values; the `removed=true` (hidden) flag is a SEPARATE axis from Status —
// MO2's `removed` means HIDDEN, never the "Removed" Status (`uninstalled=true`).

import { lineRanges } from './lineScan';

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
  /** Whether a `.meta` sidecar exists — gates the Open Meta File action. */
  hasMeta: boolean;
  /** Hidden (`.meta` `removed=true`) — a separate axis from Status. Hidden rows
   *  are filtered out unless Show hidden is on, then shown dimmed. */
  hidden: boolean;
  /** Nexus mod id from the `.meta`; absent (or `0`) gates Visit on Nexus off. */
  modID?: string;
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

export function parseDownloadMeta(text: string): { status: DownloadStatus; hidden: boolean; modID?: string } {
  const values = new Map<string, string>();
  for (const raw of text.split(/\r\n|\r|\n/)) {
    const eq = raw.indexOf('=');
    if (eq === -1) continue;
    values.set(raw.slice(0, eq).trim(), raw.slice(eq + 1).trim());
  }
  let status: DownloadStatus = 'Downloaded';
  if (values.get('uninstalled') === 'true') status = 'Removed';
  else if (values.get('installed') === 'true') status = 'Installed';
  const modID = values.get('modID');
  // `removed` is HIDDEN — a separate key/axis from the `uninstalled` Status above.
  const hidden = values.get('removed') === 'true';
  return { status, hidden, modID: modID && modID !== '0' ? modID : undefined };
}

/** Surgically set `key=value` in a `.meta` text — the shared byte-faithful
 *  `[General]` flag write behind the Install/Hide/Unhide mutations. Flips an
 *  existing `key=` line's value in place, or inserts the key right after
 *  `[General]`, or — if the archive had no `.meta` at all (`text === ''`) —
 *  creates a minimal one from scratch. Writes the value verbatim (`false`
 *  clears, not a key deletion), matching MO2's `QSettings::setValue`. */
function setMetaFlag(text: string, key: string, value: boolean): string {
  const line = `${key}=${value}`;
  for (const { start, contentEnd } of lineRanges(text)) {
    if (text.slice(start, contentEnd).startsWith(`${key}=`)) {
      return text.slice(0, start) + line + text.slice(contentEnd);
    }
  }
  let eol = '\r\n';
  if (!text.includes('\r\n') && text.includes('\n')) eol = '\n';
  if (text.trim() === '') return `[General]${eol}${line}${eol}`;
  for (const { start, contentEnd, end } of lineRanges(text)) {
    if (text.slice(start, contentEnd).trim() === '[General]') {
      return text.slice(0, end) + `${line}${eol}` + text.slice(end);
    }
  }
  return `[General]${eol}${line}${eol}` + text;
}

/** Set `installed=true` in a `.meta` text (the Install writeback). */
export function setInstalledInText(text: string): string {
  return setMetaFlag(text, 'installed', true);
}

/** Set (`hidden=true`) or clear (`hidden=false`) the `.meta`'s `removed` flag —
 *  the Hide/Unhide mutation. `removed` (HIDDEN) is a SEPARATE axis from the
 *  `uninstalled` "Removed" Status. Unhide writes `removed=false`, not a key
 *  deletion, matching MO2's `setValue("removed", false)`. */
export function setHiddenInText(text: string, hidden: boolean): string {
  return setMetaFlag(text, 'removed', hidden);
}

/** Filter hidden rows for rendering — a view concern, so it runs client-side on
 *  the already-built rows (like `sortDownloadRows`), not in row building. Off
 *  by default excludes hidden rows; on includes all, flags left intact so the
 *  webview can dim them. The name-filter (`filterRowsByName`) composes after this. */
export function filterHiddenRows(rows: DownloadRow[], showHidden: boolean): DownloadRow[] {
  return showHidden ? rows : rows.filter((r) => !r.hidden);
}

/** Filter rows by a case-insensitive substring match on Name — the toolbar
 *  Filter box. A view concern like `filterHiddenRows`, run client-side and
 *  composed AFTER it (hidden-filtering wins first). An empty or whitespace-only
 *  query returns all rows. */
export function filterRowsByName(rows: DownloadRow[], query: string): DownloadRow[] {
  const q = query.trim().toLowerCase();
  return q === '' ? rows : rows.filter((r) => r.name.toLowerCase().includes(q));
}

/** Build render-ready rows: suppresses `.meta` sidecars as their own rows,
 *  and default-sorts Filetime desc. Hidden rows are built (flagged `hidden`),
 *  not filtered — hidden-filtering is a view concern (see `filterHiddenRows`). */
export function buildDownloadRows(entries: DownloadEntry[]): DownloadRow[] {
  const rows = entries
    .filter((e) => !e.name.endsWith('.meta'))
    .map((e) => {
      const { status, hidden, modID } = parseDownloadMeta(e.metaText ?? '');
      return { name: e.name, status, size: e.size, mtimeMs: e.mtimeMs, hasMeta: e.metaText !== undefined, hidden, modID };
    });
  return sortDownloadRows(rows, 'mtimeMs', true);
}
