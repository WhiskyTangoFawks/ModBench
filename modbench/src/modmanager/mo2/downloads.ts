// `.meta` is a QSettings::IniFormat file MO2 writes beside each download. Its
// `removed=true` flag means HIDDEN and is a separate axis from Status, which
// `uninstalled=true` carries.

import { DOWNLOAD_SIDECAR_SUFFIX } from './layout';
import { lineRanges } from './lineScan';

export type DownloadStatus = 'Installed' | 'Uninstalled' | 'Downloaded';

/** `.meta` sidecars are still included, so a caller can pass a raw directory
 *  listing without filtering it first. */
export interface DownloadEntry {
  name: string;
  size: number;
  mtimeMs: number;
  metaText?: string;
}

export interface DownloadRow {
  name: string;
  /** The `.meta` `name` when non-empty, else the raw filename — never blank. */
  displayName: string;
  status: DownloadStatus;
  size: number;
  mtimeMs: number;
  hasMeta: boolean;
  /** `.meta` `removed=true` — a separate axis from Status. */
  hidden: boolean;
  /** Nexus mod id; MO2 writes `0` for none, which reads as absent here. */
  modID?: string;
  /** Nexus file id; MO2 writes `0` for none, which reads as absent here — the
   *  upgrade pick's precise match, sharper than modID's mod-level one. */
  fileID?: string;
  version?: string;
  /** The mod's own name, distinct from the file's `displayName`. */
  modName?: string;
  gameName?: string;
  author?: string;
}

export type DownloadSortColumn = 'name' | 'status' | 'size' | 'mtimeMs';

export function sortDownloadRows(
  rows: readonly DownloadRow[],
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
  fileID?: string;
  name?: string;
  version?: string;
  modName?: string;
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
  const fileID = values.get('fileID');
  // `removed` is HIDDEN — a separate key/axis from the `uninstalled` Status above.
  const hidden = values.get('removed') === 'true';
  return {
    status,
    hidden,
    modID: modID && modID !== '0' ? modID : undefined,
    fileID: fileID && fileID !== '0' ? fileID : undefined,
    name: values.get('name'),
    version: values.get('version'),
    modName: values.get('modName'),
    gameName: values.get('gameName'),
    author: values.get('author'),
  };
}

// Writes the value verbatim, so `false` clears rather than deleting the key,
// matching MO2's `QSettings::setValue`. Empty text yields a minimal `.meta`.
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

/** Both keys, as MO2's own markInstalled writes them: a reader resolves `uninstalled` first, so
 *  a download uninstalled and then reinstalled would otherwise still read Uninstalled. */
export function setInstalledInText(text: string): string {
  return setMetaFlag(setMetaFlag(text, 'uninstalled', false), 'installed', true);
}

/** `installed` is left untouched, as MO2 leaves it: the two keys coexist and
 *  `parseDownloadMeta` resolves the precedence. */
export function setUninstalledInText(text: string): string {
  return setMetaFlag(text, 'uninstalled', true);
}

/** Unhide writes `removed=false` rather than deleting the key, matching MO2's
 *  `setValue("removed", false)`. */
export function setHiddenInText(text: string, hidden: boolean): string {
  return setMetaFlag(text, 'removed', hidden);
}

/** A view concern, so it runs over already-built rows. `showHidden` keeps the
 *  flags intact, so the dimming decoration can still tell hidden rows apart. */
export function filterHiddenRows(rows: readonly DownloadRow[], showHidden: boolean): DownloadRow[] {
  return showHidden ? [...rows] : rows.filter((r) => !r.hidden);
}

// A space-separated flag string, because `when` clauses match it with
// `viewItem =~ /\bflag\b/`: flags appear only when true, and the word-boundary
// regex makes any one of them testable regardless of the others.
export function downloadContextValue(row: DownloadRow): string {
  const flags = [
    row.hasMeta && 'hasMeta',
    row.modID !== undefined && 'hasModID',
    row.hidden && 'hidden',
  ].filter((f): f is string => f !== false);
  return ['download', ...flags].join(' ');
}

// Archive filenames come from two of MO2's files and are compared, never displayed, so they are
// folded: a Windows filename is case-insensitive.
const archiveKey = (filename: string): string => filename.toLowerCase();

/** Which mods each download was installed into, keyed by the download's folded filename: the
 *  reverse of every mod's meta.ini `installationFile`, many to many. A mod naming no file
 *  claims nothing, which is unknown rather than an uninstall. */
export function modsByInstallationFile(
  mods: readonly { name: string; archiveFilename?: string }[],
): Map<string, string[]> {
  const byFile = new Map<string, string[]>();
  for (const mod of mods) {
    if (!mod.archiveFilename) continue;
    const key = archiveKey(mod.archiveFilename);
    byFile.set(key, [...(byFile.get(key) ?? []), mod.name]);
  }
  return byFile;
}

/** Hidden rows are built and flagged, never filtered — filtering is a view concern. Sidecars do
 *  not become rows of their own. `installedInto` is what makes a row Installed: the sidecar's
 *  own flag outlives the mod it claims. */
export function buildDownloadRows(
  entries: DownloadEntry[], installedInto: ReadonlyMap<string, readonly string[]>,
): DownloadRow[] {
  const rows = entries
    .filter((e) => !e.name.endsWith(DOWNLOAD_SIDECAR_SUFFIX))
    .map((e) => {
      const { status: sidecarStatus, hidden, modID, fileID, name, version, modName, gameName, author } = parseDownloadMeta(
        e.metaText ?? '',
      );
      // Installed is the mods' answer; the sidecar keeps its other two, which say nothing
      // about whether a mod stands on disk.
      const status: DownloadStatus = installedInto.has(archiveKey(e.name))
        ? 'Installed'
        : (sidecarStatus === 'Installed' ? 'Downloaded' : sidecarStatus);
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
        fileID,
        version,
        modName,
        gameName,
        author,
      };
    });
  return sortDownloadRows(rows, 'mtimeMs', true);
}
