// MO2's settings of one profile, in its folder, as QSettings writes them.

import { GENERAL_SECTION, readIniValue } from './qSettingsIni';

export const PROFILE_SETTINGS_FILE_NAME = 'settings.ini';

/** Whether the profile keeps game INIs of its own, which the game then reads in place of its own. */
export const keepsOwnGameInis = (text: string): boolean => readIniValue(text, GENERAL_SECTION, 'LocalSettings') === 'true';
