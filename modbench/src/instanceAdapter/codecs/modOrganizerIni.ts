// MO2 wraps special-character values as `@ByteArray(<value>)`; a profile name needs no
// wrapping, but MO2 writes one, so we match it.

import { decodeIniValue, GENERAL_SECTION, readIniValue, setIniValue } from './qSettingsIni';

/** MO2's settings file, at the instance root. */
export const SETTINGS_FILE_NAME = 'ModOrganizer.ini';

const SELECTED_PROFILE_KEY = 'selected_profile';

const missingKey = (key: string): Error => new Error(`ModOrganizer.ini: missing ${key}`);

function readRequired(text: string, key: string): string {
  const raw = readIniValue(text, GENERAL_SECTION, key);
  if (raw === undefined) throw missingKey(key);
  return decodeIniValue(raw);
}

export const readSelectedProfile = (text: string): string => readRequired(text, SELECTED_PROFILE_KEY);

export const readGameName = (text: string): string => readRequired(text, 'gameName');

export const readGamePath = (text: string): string => readRequired(text, 'gamePath');

/** `[Settings] download_directory`, undefined when unset or empty — MO2's own default then
 *  applies either way: its own UI removes the key rather than write an empty value. */
export function readDownloadDirectory(text: string): string | undefined {
  const raw = readIniValue(text, 'Settings', 'download_directory');
  return raw ? decodeIniValue(raw) || undefined : undefined;
}

export function setSelectedProfileInText(text: string, profile: string): string {
  if (readIniValue(text, GENERAL_SECTION, SELECTED_PROFILE_KEY) === undefined) throw missingKey(SELECTED_PROFILE_KEY);
  return setIniValue(text, GENERAL_SECTION, SELECTED_PROFILE_KEY, `@ByteArray(${profile})`);
}
