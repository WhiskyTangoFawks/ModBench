// Pure model for the Downloads tab: turns a downloads/ directory listing plus
// each archive's .meta sidecar text into render-ready rows.
//
// .meta is a QSettings::IniFormat file MO2 writes beside each download
// (mirrors modorganizer/src/downloadmanager.cpp). Status is one of three MVP
// values; the `removed=true` (hidden) flag is a SEPARATE axis from Status —
// MO2's `removed` means HIDDEN, never the Uninstalled Status (`uninstalled=true`).

import { lineRanges } from './lineScan';

export type DownloadStatus = 'Installed' | 'Uninstalled' | 'Downloaded';

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
  /** Friendly name for display: `.meta` `name` when present and non-empty,
   *  else the raw filename — never blank, even with no `.meta` at all. */
  displayName: string;
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
  /** Version string from the `.meta`, absent when not recorded. */
  version?: string;
  /** Tooltip field from the `.meta`: the mod's name (distinct from the file's
   *  own `displayName`), absent when not recorded. */
  modName?: string;
  /** Tooltip field from the `.meta`: the Nexus file id, absent when not recorded. */
  fileID?: string;
  /** Tooltip field from the `.meta`: the game this download is for, absent when not recorded. */
  gameName?: string;
  /** Tooltip field from the `.meta`: the mod's author, absent when not recorded. */
  author?: string;
}

export type DownloadSortColumn = 'name' | 'status' | 'size' | 'mtimeMs';

/** Re-sort rendered rows by column. Default sort (Filetime desc) is
 *  `sortDownloadRows(rows, 'mtimeMs', true)`. */
export function sortDownloadRows(
  rows: DownloadRow[],
  column: DownloadSortColumn,
  descending: boolean,
): DownloadRow[] {
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

export function parseDownloadMeta(
  text: string,
): {
  status: DownloadStatus;
  hidden: boolean;
  modID?: string;
  name?: string;
  version?: string;
  modName?: string;
  fileID?: string;
  gameName?: string;
  author?: string;
} {
  const values = new Map<string, string>();
  for (const raw of text.split(/\r\n|\r|\n/)) {
    const eq = raw.indexOf('=');
    if (eq === -1) continue;
    values.set(raw.slice(0, eq).trim(), raw.slice(eq + 1).trim());
  }
  let status: DownloadStatus = 'Downloaded';
  if (values.get('uninstalled') === 'true') status = 'Uninstalled';
  else if (values.get('installed') === 'true') status = 'Installed';
  const modID = values.get('modID');
  // `removed` is HIDDEN — a separate key/axis from the `uninstalled` Status above.
  const hidden = values.get('removed') === 'true';
  return {
    status,
    hidden,
    modID: modID && modID !== '0' ? modID : undefined,
    name: values.get('name'),
    version: values.get('version'),
    modName: values.get('modName'),
    fileID: values.get('fileID'),
    gameName: values.get('gameName'),
    author: values.get('author'),
  };
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

/** Set `uninstalled=true` in a `.meta` text (the Uninstall writeback — the
 *  symmetric half of `setInstalledInText`). `installed` is left untouched:
 *  both keys carry history, and `parseDownloadMeta` resolves the precedence
 *  (`uninstalled` wins), matching MO2's own `installed`/`uninstalled` pair. */
export function setUninstalledInText(text: string): string {
  return setMetaFlag(text, 'uninstalled', true);
}

/** Set (`hidden=true`) or clear (`hidden=false`) the `.meta`'s `removed` flag —
 *  the Hide/Unhide mutation. `removed` (HIDDEN) is a SEPARATE axis from the
 *  `uninstalled` Uninstalled Status. Unhide writes `removed=false`, not a key
 *  deletion, matching MO2's `setValue("removed", false)`. */
export function setHiddenInText(text: string, hidden: boolean): string {
  return setMetaFlag(text, 'removed', hidden);
}

/** Filter hidden rows for rendering — a view concern, so it runs client-side on
 *  the already-built rows (like `sortDownloadRows`), not in row building. Off
 *  by default excludes hidden rows; on includes all, flags left intact so the
 *  dimming decoration can distinguish them. Name filtering has no equivalent
 *  here — it is applied at the provider level (DownloadsProvider.setFilter),
 *  so there is no filterRowsByName. */
export function filterHiddenRows(rows: DownloadRow[], showHidden: boolean): DownloadRow[] {
  return showHidden ? rows : rows.filter((r) => !r.hidden);
}

// The row's right-click menu is a native `contributes.menus["view/item/context"]`
// contribution on the `modbench.downloads` TreeView, gated by this space-separated `contextValue`
// flag string and `viewItem =~ /\bflag\b/` `when` clauses. The base
// `'download'` token identifies the row kind (mirrors ModNode's plain `contextValue = 'mod'`);
// `hasMeta`/`hasModID`/`hidden` are appended only when true, in that fixed order, so a `when`
// clause testing any one of them via a word-boundary regex doesn't care about the others' order.
export function downloadContextValue(row: DownloadRow): string {
  const flags = [
    row.hasMeta && 'hasMeta',
    row.modID !== undefined && 'hasModID',
    row.hidden && 'hidden',
  ].filter((f): f is string => f !== false);
  return ['download', ...flags].join(' ');
}

/** Build render-ready rows: suppresses `.meta` sidecars as their own rows,
 *  and default-sorts Filetime desc. Hidden rows are built (flagged `hidden`),
 *  not filtered — hidden-filtering is a view concern (see `filterHiddenRows`). */
export function buildDownloadRows(entries: DownloadEntry[]): DownloadRow[] {
  const rows = entries
    .filter((e) => !e.name.endsWith('.meta'))
    .map((e) => {
      const { status, hidden, modID, name, version, modName, fileID, gameName, author } = parseDownloadMeta(
        e.metaText ?? '',
      );
      // Mirrors MO2's displayNameByInfo (downloadmanager.cpp:1410): `.meta` name
      // when non-empty, else the raw filename — falsy `||` covers absent AND
      // present-but-empty (`name=`) identically, so a row is never blank.
      const displayName = name || e.name;
      return {
        name: e.name,
        displayName,
        status,
        size: e.size,
        mtimeMs: e.mtimeMs,
        hasMeta: e.metaText !== undefined,
        hidden,
        modID,
        version,
        modName,
        fileID,
        gameName,
        author,
      };
    });
  return sortDownloadRows(rows, 'mtimeMs', true);
}
