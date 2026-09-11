// MO2's own directory and file names, spelled here and nowhere else in the extension
// (ADR-0014 invariant 5). Every other module asks this one for a path; `formatLiteralScan.test.ts`
// fails the suite on a second speller.

import { join } from 'node:path';

const PROFILES = 'profiles';
const MODS = 'mods';
const DOWNLOADS = 'downloads';
const MODLIST = 'modlist.txt';
const PLUGINS = 'plugins.txt';

/** MO2's settings file, at the instance root. */
export const SETTINGS_FILE_NAME = 'ModOrganizer.ini';

/** A mod folder's metadata file. */
export const MOD_META_FILE_NAME = 'meta.ini';

/** Appended to a download's filename to name its sidecar. */
export const DOWNLOAD_SIDECAR_SUFFIX = '.meta';

/** The overwrite directory's name, which is also its reserved origin value (ADR-0012) and the
 *  one directory under `mods/`'s sibling set a modlist line may never name. */
export const OVERWRITE_DIR_NAME = 'overwrite';

export const profilesDir = (instanceRoot: string): string => join(instanceRoot, PROFILES);

export const profileDir = (instanceRoot: string, profile: string): string =>
  join(profilesDir(instanceRoot), profile);

export const modsDir = (instanceRoot: string): string => join(instanceRoot, MODS);

export const modDir = (instanceRoot: string, modName: string): string =>
  join(modsDir(instanceRoot), modName);

export const overwriteDir = (instanceRoot: string): string => join(instanceRoot, OVERWRITE_DIR_NAME);

export const downloadsDir = (instanceRoot: string): string => join(instanceRoot, DOWNLOADS);

export const settingsFile = (instanceRoot: string): string => join(instanceRoot, SETTINGS_FILE_NAME);

export const modMetaFile = (instanceRoot: string, modName: string): string =>
  join(modDir(instanceRoot, modName), MOD_META_FILE_NAME);

export const modlistFile = (instanceRoot: string, profile: string): string =>
  join(profileDir(instanceRoot, profile), MODLIST);

export const pluginsFile = (instanceRoot: string, profile: string): string =>
  join(profileDir(instanceRoot, profile), PLUGINS);

export const downloadFile = (instanceRoot: string, name: string): string =>
  join(downloadsDir(instanceRoot), name);

export const downloadSidecarFile = (instanceRoot: string, name: string): string =>
  join(downloadsDir(instanceRoot), name + DOWNLOAD_SIDECAR_SUFFIX);

// Watch patterns, POSIX-separated and relative to the instance root: a `RelativePattern` takes a
// glob, never a platform path, so these are built as text rather than with `join`.
export const MODS_GLOB = `${MODS}/**`;
export const OVERWRITE_GLOB = `${OVERWRITE_DIR_NAME}/**`;
export const DOWNLOADS_GLOB = `${DOWNLOADS}/**`;
export const MODLIST_GLOB = `${PROFILES}/*/${MODLIST}`;
export const PLUGINS_GLOB = `${PROFILES}/*/${PLUGINS}`;
