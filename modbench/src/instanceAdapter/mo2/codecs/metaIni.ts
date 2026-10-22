// meta.ini is QSettings::IniFormat. `[installedFiles]` is a QSettings array whose key
// order is not guaranteed, so it's read scoped to the section and keyed by index.

import type { ModMeta } from '../../instanceAdapter';
import { GENERAL_SECTION, readIniSection, replaceIniSection, setIniValue } from './qSettingsIni';

/** A mod folder's metadata file. */
export const MOD_META_FILE_NAME = 'meta.ini';

/** A Nexus mod and file id pair `[installedFiles]` records. */
export interface InstalledFileId {
  nexusId: string;
  fileId: string;
}

/** What meta.ini says, `[installedFiles]` as its pairs. */
export interface MetaIni extends Omit<ModMeta, 'installedFileKeys'> {
  installedFiles?: readonly InstalledFileId[];
}

/** The keys Modbench writes into meta.ini. */
export interface OwnedMetaKeys extends MetaIni {
  gameName: string;
}

// The keys Modbench owns in meta.ini, each written only when present.
type MetaKeys = Partial<OwnedMetaKeys>;

const OWNED_GENERAL_KEYS = [
  ['gameName', 'gameName'],
  ['nexusId', 'modid'],
  ['version', 'version'],
  ['installationFileName', 'installationFile'],
] as const;

const INSTALLED_FILES = 'installedFiles';

// A `[installedFiles]` array key is `<index>\modid` or `<index>\fileid`; anything else
// in the section (its own `size` key, malformed input) is not one.
function arrayEntryKey(key: string): { index: number; field: 'modid' | 'fileid' } | undefined {
  const sep = key.indexOf('\\');
  if (sep === -1) return undefined;
  const index = Number(key.slice(0, sep));
  if (!Number.isInteger(index)) return undefined;
  const field = key.slice(sep + 1);
  return field === 'modid' || field === 'fileid' ? { index, field } : undefined;
}

function parseInstalledFiles(text: string): InstalledFileId[] | undefined {
  const pairs = new Map<number, { modid?: string; fileid?: string }>();
  for (const [key, value] of readIniSection(text, INSTALLED_FILES)) {
    const entry = arrayEntryKey(key);
    if (!entry) continue;
    const pair = pairs.get(entry.index) ?? {};
    pair[entry.field] = value;
    pairs.set(entry.index, pair);
  }
  if (pairs.size === 0) return undefined;
  return [...pairs.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, { modid, fileid }]) => ({ nexusId: modid ?? '', fileId: fileid ?? '' }));
}

export function parseMetaIni(text: string): MetaIni {
  const general = readIniSection(text, GENERAL_SECTION);
  const present = (key: string): string | undefined => general.get(key) || undefined; // blank == absent
  const modid = present('modid');
  return {
    gameName: present('gameName'),
    version: present('version'),
    newestVersion: present('newestVersion'),
    nexusId: modid && modid !== '0' && modid !== '-1' ? modid : undefined,
    installationFileName: present('installationFile'),
    installedFiles: parseInstalledFiles(text),
  };
}

/** The key a downloaded file carries for an installed file: its pair. */
export const installedFileKey = ({ nexusId, fileId }: InstalledFileId): string => `${nexusId}:${fileId}`;

function installedFileOfKey(key: string): InstalledFileId {
  const at = key.indexOf(':');
  return { nexusId: key.slice(0, at), fileId: key.slice(at + 1) };
}

/** What meta.ini says of a mod, in the words every mod manager shares. */
export const modMetaOf = ({ installedFiles, ...rest }: MetaIni): ModMeta =>
  ({ ...rest, installedFileKeys: installedFiles?.map(installedFileKey) });

/** The meta.ini a mod's meta says. */
export const metaIniOf = ({ installedFileKeys, ...rest }: ModMeta): MetaIni =>
  ({ ...rest, installedFiles: installedFileKeys?.map(installedFileOfKey) });

function installedFilesBody(pairs: readonly InstalledFileId[] | undefined): string[] {
  if (!pairs || pairs.length === 0) return [];
  return [
    ...pairs.flatMap((pair, i) => [`${i + 1}\\modid=${pair.nexusId}`, `${i + 1}\\fileid=${pair.fileId}`]),
    `size=${pairs.length}`,
  ];
}

/** Sets each key `changes` names into existing meta.ini text — replaced, added or (value
 *  absent) cleared — leaving every other key and section as found. */
export function changeOwnedKeysInText(text: string, changes: MetaKeys): string {
  const general = [...OWNED_GENERAL_KEYS]
    .reverse()
    .reduce((acc, [field, key]) => (field in changes ? setIniValue(acc, GENERAL_SECTION, key, changes[field]) : acc), text);
  return 'installedFiles' in changes ? replaceIniSection(general, INSTALLED_FILES, installedFilesBody(changes.installedFiles)) : general;
}

/** Sets every key Modbench owns, an absent one cleared. */
export function setOwnedKeysInText(text: string, keys: MetaKeys): string {
  const { gameName, nexusId, version, installationFileName, installedFiles } = keys;
  return changeOwnedKeysInText(text, { gameName, nexusId, version, installationFileName, installedFiles });
}

/** Keys use MO2's own names, so the result round-trips through `parseMetaIni`. */
export const writeMetaIni = (meta: MetaKeys): string => setOwnedKeysInText('', meta);
