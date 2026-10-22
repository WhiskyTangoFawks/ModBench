// `.meta` is a QSettings::IniFormat file MO2 writes beside each downloaded file. Its
// `removed=true` flag is MO2's hidden, which Modbench calls excluded; it is a separate axis from
// Status, which `uninstalled=true` carries.

import type { DownloadedFileMeta, DownloadedFileStatus } from '../../instanceAdapter';
import { qtToInt } from './qtInt';
import { installedFileKey } from './metaIni';
import { GENERAL_SECTION, readIniSection, setIniValue } from './qSettingsIni';

/** Appended to a downloaded file's name to name its metadata file. */
export const METADATA_FILE_SUFFIX = '.meta';

/** `removed` is MO2's hidden, a separate key from the `uninstalled` Status. */
export function parseDownloadedFileMeta(text: string): { meta: DownloadedFileMeta; hidden: boolean } {
  const values = readIniSection(text, GENERAL_SECTION);
  let status: DownloadedFileStatus = 'Downloaded';
  if (values.get('uninstalled') === 'true') status = 'Uninstalled';
  else if (values.get('installed') === 'true') status = 'Installed';
  const id = (key: string): string | undefined => {
    const value = values.get(key);
    return value && value !== '0' ? value : undefined;
  };
  const modID = id('modID');
  const fileCategory = values.get('fileCategory');
  const fileID = id('fileID');
  const installedKey = modID && fileID ? installedFileKey({ nexusId: modID, fileId: fileID }) : undefined;
  const meta: DownloadedFileMeta = {
    status,
    modID,
    fileCategory: fileCategory === undefined ? undefined : qtToInt(fileCategory),
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
 *  a downloaded file uninstalled and then reinstalled would otherwise still read Uninstalled. */
export function setInstalledInText(text: string): string {
  return setMetaFlag(setMetaFlag(text, 'uninstalled', false), 'installed', true);
}

/** `installed` is left untouched, as MO2 leaves it: the two keys coexist and
 *  `parseDownloadedFileMeta` resolves the precedence. */
export function setUninstalledInText(text: string): string {
  return setMetaFlag(text, 'uninstalled', true);
}

/** Unhide writes `removed=false` rather than deleting the key, matching MO2's
 *  `setValue("removed", false)`. */
export function setHiddenInText(text: string, hidden: boolean): string {
  return setMetaFlag(text, 'removed', hidden);
}
