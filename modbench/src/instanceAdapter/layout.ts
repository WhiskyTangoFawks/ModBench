// MO2's directory structure: the directory names under an instance root, the path functions
// built from them, and the Instance's watcher globs. Each file's own name is its codec's, and
// `formatLiteralScan.test.ts` refuses a second speller.

import { join } from 'node:path';
import { DOWNLOAD_SIDECAR_SUFFIX } from '../mo2Codecs/downloads';
import { MOD_META_FILE_NAME } from '../mo2Codecs/metaIni';
import { MODLIST_FILE_NAME, OVERWRITE_DIR_NAME } from '../mo2Codecs/modlistText';
import { SETTINGS_FILE_NAME } from '../mo2Codecs/modOrganizerIni';
import { PLUGINS_FILE_NAME } from '../mo2Codecs/pluginsText';

const PROFILES = 'profiles';
const MODS = 'mods';
const DOWNLOADS = 'downloads';

export const profilesDir = (instanceRoot: string): string => join(instanceRoot, PROFILES);

export const profileDir = (instanceRoot: string, profile: string): string =>
  join(profilesDir(instanceRoot), profile);

export const modsDir = (instanceRoot: string): string => join(instanceRoot, MODS);

export const modDir = (instanceRoot: string, modName: string): string =>
  join(modsDir(instanceRoot), modName);

export const overwriteDir = (instanceRoot: string): string => join(instanceRoot, OVERWRITE_DIR_NAME);

/** MO2's own default when `download_directory` is unset. Every other download path function
 *  below takes the resolved folder directly, wherever it actually is. */
export const defaultDownloadsDir = (instanceRoot: string): string => join(instanceRoot, DOWNLOADS);

export const settingsFile = (instanceRoot: string): string => join(instanceRoot, SETTINGS_FILE_NAME);

export const modMetaFile = (instanceRoot: string, modName: string): string =>
  join(modDir(instanceRoot, modName), MOD_META_FILE_NAME);

export const modlistFile = (instanceRoot: string, profile: string): string =>
  join(profileDir(instanceRoot, profile), MODLIST_FILE_NAME);

export const pluginsFile = (instanceRoot: string, profile: string): string =>
  join(profileDir(instanceRoot, profile), PLUGINS_FILE_NAME);

export const downloadFile = (downloadsDir: string, name: string): string => join(downloadsDir, name);

export const downloadSidecarFile = (downloadsDir: string, name: string): string =>
  join(downloadsDir, name + DOWNLOAD_SIDECAR_SUFFIX);

/** The git directory whose presence is what "tracked" means (ADR-0007). */
export const modGitDir = (modFolder: string): string => join(modFolder, '.git');

// Watch patterns, POSIX-separated and relative to the instance root: a `RelativePattern` takes a
// glob, never a platform path, so these are built as text rather than with `join`.
export const MODS_GLOB = `${MODS}/**`;
export const OVERWRITE_GLOB = `${OVERWRITE_DIR_NAME}/**`;
export const MODLIST_GLOB = `${PROFILES}/*/${MODLIST_FILE_NAME}`;
export const PLUGINS_GLOB = `${PROFILES}/*/${PLUGINS_FILE_NAME}`;
