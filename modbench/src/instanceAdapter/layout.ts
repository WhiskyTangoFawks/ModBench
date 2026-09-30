// MO2's directory structure: the directory names under an instance root, the path functions
// built from them, and the adapter's watch globs. Each file's own name is its codec's, and
// `formatLiteralScan.test.ts` refuses a second speller.

import { randomBytes } from 'node:crypto';
import { dirname, join, posix, sep, win32 } from 'node:path';
import { DOWNLOAD_SIDECAR_SUFFIX } from './codecs/downloads';
import { MOD_META_FILE_NAME } from './codecs/metaIni';
import { MODLIST_FILE_NAME, OVERWRITE_DIR_NAME, separatorModName } from './codecs/modlistText';
import { SETTINGS_FILE_NAME } from './codecs/modOrganizerIni';
import { PLUGINS_FILE_NAME } from '../loadOrderFileCodec/pluginsText';
import type { EntryRef } from './instanceAdapter';
import { PLUGIN_EXTENSIONS } from './pluginFile';

const PROFILES = 'profiles';
const MODS = 'mods';
const DOWNLOADS = 'downloads';

export const profilesDir = (instanceRoot: string): string => join(instanceRoot, PROFILES);

export const profileDir = (instanceRoot: string, profile: string): string =>
  join(profilesDir(instanceRoot), profile);

export const modsDir = (instanceRoot: string): string => join(instanceRoot, MODS);

export const modDir = (instanceRoot: string, modName: string): string =>
  join(modsDir(instanceRoot), modName);

// MOBase::fixDirectoryName, which MO2 runs on every name it gives a folder: surrounding and
// repeated whitespace and trailing dots go, the characters Windows forbids in a file name go, and
// a DOS device name is no name.
const FORBIDDEN_IN_FOLDER_NAME = /[<>:"/\\|?*]/g;
const DEVICE_NAMES = new Set([
  'CON', 'PRN', 'AUX', 'NUL', ...[1, 2, 3, 4, 5, 6, 7, 8, 9].flatMap((n) => [`COM${n}`, `LPT${n}`]),
]);
const simplified = (text: string): string => text.trim().replace(/\s+/g, ' ');

/** The name MO2 would give a folder asked to be `name`; empty when nothing of it is left. */
export function mo2FolderName(name: string): string {
  const filtered = simplified(name).replace(/\.+$/, '').replace(FORBIDDEN_IN_FOLDER_NAME, '');
  return DEVICE_NAMES.has(filtered) ? '' : simplified(filtered);
}

/** The folder under `mods/` a mod line names. `undefined` for a name that would reach outside
 *  `mods/`, such as one another tool wrote with a `/`: no path is built from it. */
export const modFolderName = (modName: string): string | undefined =>
  (modName === '' || modName === '.' || modName === '..' || /[\\/]/.test(modName) ? undefined : modName);

/** The folder under `mods/` MO2 gives a separator. `undefined` for a name MO2 never gives a
 *  folder, such as one another tool wrote with a `/`: such a separator has no folder, and no path
 *  is built from its name. */
export const separatorFolderName = (separatorName: string): string | undefined =>
  mo2FolderName(separatorName) === separatorName ? separatorModName(separatorName) : undefined;

export const separatorDir = (instanceRoot: string, separatorName: string): string | undefined => {
  const folder = separatorFolderName(separatorName);
  return folder === undefined ? undefined : modDir(instanceRoot, folder);
};

/** The folder of a mod or separator; `undefined` when its name gives it none. */
export const entryDir = (instanceRoot: string, entry: EntryRef): string | undefined => {
  if (entry.kind === 'separator') return separatorDir(instanceRoot, entry.name);
  const folder = modFolderName(entry.name);
  return folder === undefined ? undefined : modDir(instanceRoot, folder);
};

// Beside mods/ rather than inside it: the same volume, so the landing rename is one step, and
// outside every watcher's glob.
const STAGING_PREFIX = '.medit-install-';

/** The prefix a fresh staging folder's name is made from. */
export const stagingPrefix = (instanceRoot: string): string => join(instanceRoot, STAGING_PREFIX);

export const overwriteDir = (instanceRoot: string): string => join(instanceRoot, OVERWRITE_DIR_NAME);

/** MO2's own default when `download_directory` is unset. Every other download path function
 *  below takes the resolved folder directly, wherever it actually is. */
export const defaultDownloadsDir = (instanceRoot: string): string => join(instanceRoot, DOWNLOADS);

export const settingsFile = (instanceRoot: string): string => join(instanceRoot, SETTINGS_FILE_NAME);

/** The meta file of the mod folder `modFolder`, wherever that folder is. */
export const modMetaFileIn = (modFolder: string): string => join(modFolder, MOD_META_FILE_NAME);

export const modMetaFile = (instanceRoot: string, modName: string): string => modMetaFileIn(modDir(instanceRoot, modName));

export const modlistFile = (instanceRoot: string, profile: string): string =>
  join(profileDir(instanceRoot, profile), MODLIST_FILE_NAME);

export const pluginsFile = (instanceRoot: string, profile: string): string =>
  join(profileDir(instanceRoot, profile), PLUGINS_FILE_NAME);

export const downloadFile = (downloadsDir: string, name: string): string => join(downloadsDir, name);

/** The name of the downloaded file at `path`; undefined when `path` is not one in `downloadsDir`.
 *  Windows matches paths without case. */
export function downloadNameAt(downloadsDir: string, path: string, platform: NodeJS.Platform): string | undefined {
  const paths = platform === 'win32' ? win32 : posix;
  const key = (p: string): string => (platform === 'win32' ? paths.normalize(p).toLowerCase() : paths.normalize(p));
  const name = paths.basename(path);
  return key(paths.join(downloadsDir, name)) === key(path) ? name : undefined;
}

export const downloadSidecarFile = (downloadsDir: string, name: string): string =>
  join(downloadsDir, name + DOWNLOAD_SIDECAR_SUFFIX);

/** The folder a plugin sits in: its mod's folder, overwrite/, or Data/. */
export const pluginFolder = (pluginFile: string): string => dirname(pluginFile);

/** A file inside `folder`, by the relative path a source tree names it with. */
export const fileInFolder = (folder: string, relativePath: string): string => join(folder, relativePath);

/** Whether `file` sits anywhere beneath `folder`. */
export const isInFolder = (folder: string, file: string): boolean => file.startsWith(folder + sep);

const GIT_DIR = '.git';
export const PLUGIN_SOURCE_FOLDER = 'plugin-source';

/** The git directory whose presence is what "tracked" means (ADR-0007). */
export const modGitDir = (modFolder: string): string => join(modFolder, GIT_DIR);

// Names in a mod folder match without case, as Windows matches them, on every platform alike.
const nameKey = (name: string): string => name.toLowerCase();

/** Whether an entry at a mod folder's root is its plugin source. */
export const isPluginSourceFolder = (name: string): boolean => nameKey(name) === PLUGIN_SOURCE_FOLDER;

const REPOSITORY_OR_PLUGIN_SOURCE_ENTRIES = new Set([GIT_DIR, '.gitignore', PLUGIN_SOURCE_FOLDER]);

/** Whether an entry at a mod folder's root is its repository or its plugin source (ADR-0007),
 *  which an upgrade keeps and no release supplies. */
export const isRepositoryOrPluginSource = (name: string): boolean => REPOSITORY_OR_PLUGIN_SOURCE_ENTRIES.has(nameKey(name));

// Watch patterns, POSIX-separated and relative to the instance root: a `RelativePattern` takes a
// glob, never a platform path, so these are built as text rather than with `join`.
export const MODS_GLOB = `${MODS}/**`;
export const OVERWRITE_GLOB = `${OVERWRITE_DIR_NAME}/**`;
export const MODLIST_GLOB = `${PROFILES}/*/${MODLIST_FILE_NAME}`;
export const PLUGINS_GLOB = `${PROFILES}/*/${PLUGINS_FILE_NAME}`;
/** A profile switch rewrites the settings and nothing else. */
export const SETTINGS_WATCH_GLOB = SETTINGS_FILE_NAME;
/** Downloads' own base is the resolved folder itself, so this glob is everything under it. */
export const DOWNLOADS_WATCH_GLOB = '**';

// A glob matches case, and a plugin's extension is any case, so each letter is a class.
const anyCase = (text: string): string => text.replace(/./g, (c) => `[${c.toLowerCase()}${c.toUpperCase()}]`);

/** The plugin files at the root of the game folder's Data folder, the Data folder its base. */
export const DATA_FOLDER_PLUGINS_GLOB = `*.{${[...PLUGIN_EXTENSIONS].map((ext) => anyCase(ext.slice(1))).join(',')}}`;

// The one spelling of files.ts's own temp suffix, so a sibling target's temp — whose name only
// starts the same way — can never pass a check built for one exact target.
const TEMP_WRITE_SUFFIX = String.raw`[0-9a-f]{12}\.tmp`;
const TEMP_WRITE_PATTERN = new RegExp(String.raw`\.${TEMP_WRITE_SUFFIX}$`);

function escapeForRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
}

/** The temp path files.ts writes to beside `path`, before its one rename onto it. */
export function tempWritePath(path: string): string {
  return `${path}.${randomBytes(6).toString('hex')}.tmp`;
}

/** Whether `name` is one of files.ts's own temp files, for any target. Every scan that lists an
 *  instance folder's own contents excludes it. */
export function isTempWrite(name: string): boolean {
  return TEMP_WRITE_PATTERN.test(name);
}

/** Whether `name` is exactly the temp file `tempWritePath` gives the file named `base` — not a
 *  sibling target's own temp, whose name only starts with `base`. */
export function isTempWriteOf(base: string, name: string): boolean {
  return new RegExp(String.raw`^${escapeForRegExp(base)}\.${TEMP_WRITE_SUFFIX}$`).test(name);
}
