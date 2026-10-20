// `.meta` is a QSettings::IniFormat file MO2 writes beside each download. Its
// `removed=true` flag is MO2's hidden, which Modbench calls excluded; it is a separate axis from
// Status, which `uninstalled=true` carries.

import type { DownloadMeta, DownloadStatus } from '../../instanceAdapter';
import { installedFileKey } from './metaIni';
import { GENERAL_SECTION, readIniSection, setIniValue } from './qSettingsIni';

/** Appended to a download's filename to name its sidecar. */
export const DOWNLOAD_SIDECAR_SUFFIX = '.meta';

/** `removed` is MO2's hidden, a separate key from the `uninstalled` Status. */
export function parseDownloadMeta(text: string): { meta: DownloadMeta; hidden: boolean } {
  const values = readIniSection(text, GENERAL_SECTION);
  let status: DownloadStatus = 'Downloaded';
  if (values.get('uninstalled') === 'true') status = 'Uninstalled';
  else if (values.get('installed') === 'true') status = 'Installed';
  const modID = values.get('modID');
  const fileID = values.get('fileID');
  const installedKey = modID && modID !== '0' && fileID && fileID !== '0' ? installedFileKey({ nexusId: modID, fileId: fileID }) : undefined;
  const meta: DownloadMeta = {
    status,
    modID: modID && modID !== '0' ? modID : undefined,
    fileID: fileID && fileID !== '0' ? fileID : undefined,
    name: values.get('name'),
    version: values.get('version'),
    modName: values.get('modName'),
    gameName: values.get('gameName'),
    author: values.get('author'),
    installedKey,
  };
  return { meta, hidden: values.get('removed') === 'true' };
}

// Writes the value verbatim, so `false` clears rather than deleting the key,
// matching MO2's `QSettings::setValue`. Empty text yields a minimal `.meta`, in MO2's CRLF.
const setMetaFlag = (text: string, key: string, value: boolean): string =>
  setIniValue(text === '' ? `[${GENERAL_SECTION}]\r\n` : text, GENERAL_SECTION, key, String(value));

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
