// `.meta` is a QSettings::IniFormat file MO2 writes beside each download. Its
// `removed=true` flag is MO2's hidden, which Modbench calls excluded; it is a separate axis from
// Status, which `uninstalled=true` carries.

import { lineRanges } from './lineScan';

/** Appended to a download's filename to name its sidecar. */
export const DOWNLOAD_SIDECAR_SUFFIX = '.meta';

export type DownloadStatus = 'Installed' | 'Uninstalled' | 'Downloaded';

export function parseDownloadMeta(
  text: string,
): {
  status: DownloadStatus;
  excluded: boolean;
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
  // `removed` is MO2's hidden — a separate key/axis from the `uninstalled` Status above.
  const excluded = values.get('removed') === 'true';
  return {
    status,
    excluded,
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
