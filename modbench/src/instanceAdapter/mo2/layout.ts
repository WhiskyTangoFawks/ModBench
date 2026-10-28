// MO2's directory structure: the directory names under an instance root, the path functions
// built from them, and the adapter's watch globs. Each file's own name is its codec's, and
// `formatLiteralScan.test.ts` refuses a second speller.

import { join, relative, sep } from 'node:path';
import { METADATA_FILE_SUFFIX } from './codecs/downloads';
import { MOD_META_FILE_NAME } from './codecs/metaIni';
import { MODLIST_FILE_NAME, OVERWRITE_DIR_NAME, separatorModName } from './codecs/modlistText';
import { SETTINGS_FILE_NAME } from './codecs/modOrganizerIni';
import { PROFILE_SETTINGS_FILE_NAME } from './codecs/profileSettings';
import { GIT_DIR, ownTempPrefix } from '../files';
import { PLUGINS_FILE_NAME } from '../../loadOrderFileCodec/pluginsText';
import { anyCase, isBareName, SOURCE_MODS_FOLDER, type EntryRef } from '../instanceAdapter';
import { PLUGIN_EXTENSIONS } from '../../tables/pluginFile';
import { MANIFEST_SUFFIX } from '../../wire/sourceMod';

const PROFILES = 'profiles';
const MODS = 'mods';
const DOWNLOADS = 'downloads';
const RECORD_INDEX = 'modbench';
const HASH_INDEX = 'hash-index';
const STAT_CACHE = 'stat-cache';
const IGNORE_LIST_FILE = '.gitignore';
const SUBMODULES_FILE = '.gitmodules';
const PLUGIN_ORDER_FILE = 'loadorder.txt';

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

// Another tool can write a mod line with a `/`; a name that reaches outside `mods/` builds no path.
/** The folder a mod's name gives it; `undefined` when it gives none. */
export const modFolderName = (modName: string): string | undefined => (isBareName(modName) ? modName : undefined);

// Another tool can write a separator name MO2 never gives a folder; such a separator builds no path.
const separatorFolderName = (separatorName: string): string | undefined =>
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

export const EXCLUDED_SUFFIX = '.mohidden';

export const isExcludedName = (name: string): boolean => name.toLowerCase().endsWith(EXCLUDED_SUFFIX);

export const excludedName = (name: string): string => name + EXCLUDED_SUFFIX;

export const includedName = (name: string): string => name.slice(0, -EXCLUDED_SUFFIX.length);

/** The path an origin's file or folder has when nothing excludes it. */
export const includedPathOf = (relativePath: string): string =>
  relativePath.split('/').map((segment) => (isExcludedName(segment) ? includedName(segment) : segment)).join('/');

/** The prefix an install's staging folder, beside mods/, is named from. */
export const stagingPrefix = (instanceRoot: string): string => ownTempPrefix(instanceRoot, 'install-');

export const overwriteDir = (instanceRoot: string): string => join(instanceRoot, OVERWRITE_DIR_NAME);

/** MO2's own default when `download_directory` is unset. Every other download path function
 *  below takes the resolved folder directly, wherever it actually is. */
export const defaultDownloadsDir = (instanceRoot: string): string => join(instanceRoot, DOWNLOADS);

export const settingsFile = (instanceRoot: string): string => join(instanceRoot, SETTINGS_FILE_NAME);

/** A mod's manifest, in its folder, named for the mod. */
export const manifestFileName = (modName: string): string => `${modName}${MANIFEST_SUFFIX}`;
export const manifestFileIn = (modFolder: string, modName: string): string => join(modFolder, manifestFileName(modName));

/** The meta file of the mod folder `modFolder`, wherever that folder is. */
export const modMetaFileIn = (modFolder: string): string => join(modFolder, MOD_META_FILE_NAME);

export const profileSettingsFile = (instanceRoot: string, profile: string): string =>
  join(profileDir(instanceRoot, profile), PROFILE_SETTINGS_FILE_NAME);

export const modlistFile = (instanceRoot: string, profile: string): string =>
  join(profileDir(instanceRoot, profile), MODLIST_FILE_NAME);

export const pluginsFile = (instanceRoot: string, profile: string): string =>
  join(profileDir(instanceRoot, profile), PLUGINS_FILE_NAME);

const loadOrderFile = (instanceRoot: string, profile: string): string =>
  join(profileDir(instanceRoot, profile), PLUGIN_ORDER_FILE);

/** A profile's plugin order files in the one order every writer takes their locks. */
export const pluginOrderFiles = (instanceRoot: string, profile: string): [loadOrder: string, plugins: string] =>
  [loadOrderFile(instanceRoot, profile), pluginsFile(instanceRoot, profile)];

export const downloadedFilePath = (downloadsDir: string, name: string): string => join(downloadsDir, name);

export const downloadedFileMetadataPath = (downloadsDir: string, name: string): string =>
  join(downloadsDir, name + METADATA_FILE_SUFFIX);

/** A mod's source folder, its repository, beside `mods/` (ADR-0007); `undefined` when its name
 *  gives it none. */
export const modSourceDir = (instanceRoot: string, modName: string): string | undefined => {
  const folder = modFolderName(modName);
  return folder === undefined ? undefined : join(instanceRoot, SOURCE_MODS_FOLDER, folder);
};

/** The folder beside `mods/` that holds every mod's source folder (ADR-0007). */
export const sourceRootDir = (instanceRoot: string): string => join(instanceRoot, SOURCE_MODS_FOLDER);

/** The folder at the instance root that holds the adapter's index of hashes, which the adapter alone writes. */
export const hashIndexDir = (instanceRoot: string): string => join(instanceRoot, HASH_INDEX);

/** The folder at the instance root, outside every mod folder and the whitelist, where mEdit keeps what it last read
 *  of each mod's files. */
export const statCacheDir = (instanceRoot: string): string => join(instanceRoot, STAT_CACHE);

/** The folder at the instance root where mEdit keeps the record index. */
export const recordIndexDir = (instanceRoot: string): string => join(instanceRoot, RECORD_INDEX);

/** Whether `path` is where git's whitelist holds a manifest: a file of that name directly in a folder of `mods/`. */
export function isManifestPath(instanceRoot: string, path: string): boolean {
  const [mods, , file, ...deeper] = relative(instanceRoot, path).split(sep);
  return mods?.toLowerCase() === MODS && file?.toLowerCase().endsWith(MANIFEST_SUFFIX) === true && deeper.length === 0;
}

// Each holds manifests of its own kind, or none, so the search for other manifests skips it, as it skips the downloads folder.
const NOT_SEARCHED = new Set([MODS, PROFILES, OVERWRITE_DIR_NAME, GIT_DIR, SOURCE_MODS_FOLDER]);

/** Whether the search for other manifests skips the folder named `name` at the instance root. */
export const isSkippedByManifestSearch = (name: string): boolean => NOT_SEARCHED.has(name.toLowerCase());

/** Whether `fileName` is the manifest of the folder named `folderName`. */
export const isOwnManifest = (folderName: string, fileName: string): boolean => fileName.toLowerCase() === manifestFileName(folderName).toLowerCase();

/** Whether `path` has the shape of another manifest: in a folder outside those the search skips, named for it. */
export function isOtherManifestPath(instanceRoot: string, path: string): boolean {
  const segments = relative(instanceRoot, path).split(sep);
  const [top, ...below] = segments;
  const [folder, file] = segments.slice(-2);
  return below.length > 0 && !isSkippedByManifestSearch(top ?? '') && isOwnManifest(folder ?? '', file ?? '');
}

/** The instance repository's ignore list file. */
export const ignoreListFile = (instanceRoot: string): string => join(instanceRoot, IGNORE_LIST_FILE);

/** The instance repository's file of submodules. */
export const submodulesFile = (instanceRoot: string): string => join(instanceRoot, SUBMODULES_FILE);

/** A source mod's path in the instance repository, which is its submodule's path. */
export const sourceModPath = (folderName: string): string => `${SOURCE_MODS_FOLDER}/${folderName}`;

/** A repository appearing at, or vanishing from, the instance root. */
export const REPOSITORY_WATCH_GLOB = GIT_DIR;

/** The repository's config and pre-push hook, where git init's path filter and push check are written. */
export const REPOSITORY_SET_UP_WATCH_GLOB = `${GIT_DIR}/{config,hooks/pre-push}`;

// Watch patterns, POSIX-separated and relative to the instance root: a `RelativePattern` takes a
// glob, never a platform path, so these are built as text rather than with `join`.
export const MODS_GLOB = `${MODS}/**`;
export const SOURCE_GLOB = `${SOURCE_MODS_FOLDER}/**`;
export const OVERWRITE_GLOB = `${OVERWRITE_DIR_NAME}/**`;
export const MODLIST_GLOB = `${PROFILES}/*/${MODLIST_FILE_NAME}`;
export const PLUGINS_GLOB = `${PROFILES}/*/${PLUGINS_FILE_NAME}`;
/** A profile switch rewrites the settings and nothing else. */
export const SETTINGS_WATCH_GLOB = SETTINGS_FILE_NAME;
/** Downloads' own base is the resolved folder itself, so this glob is everything under it. */
export const DOWNLOADS_WATCH_GLOB = '**';

/** The plugin files at the root of the game folder's Data folder, the Data folder its base. */
export const DATA_FOLDER_PLUGINS_GLOB = `*.{${[...PLUGIN_EXTENSIONS].map((ext) => anyCase(ext.slice(1))).join(',')}}`;

/** A profile's own INIs: its settings, and the game INIs it keeps. */
export const PROFILE_INIS_GLOB = `${PROFILES}/*/*.${anyCase('ini')}`;

// A repository does not look inside an ignored folder, so each folder is let in, its content ignored, and the files let back.
const heldInEachFolderOf = (folder: string, files: readonly string[]): string[] => [
  `!/${folder}/`, `/${folder}/*`, `!/${folder}/*/`, `/${folder}/*/*`, ...files.map((file) => `!/${folder}/*/${file}`),
];

const escapedForIgnoreList = (name: string): string => name.replace(/[\\*?[]/g, String.raw`\$&`);

type Markers = readonly [first: string, last: string];

// Git's last matching line wins: what leaves a folder out sits before the user's lines, and what lets a file in after.
interface OwnLines { readonly leftOut: Markers; readonly letIn: Markers }
type Role = keyof OwnLines;

const SOURCE_MODS: OwnLines = {
  leftOut: ['# Source mods with a remote, the rest left out', '# End of source mods with a remote, the rest left out'],
  letIn: ['# Source mods with a remote', '# End of source mods with a remote'],
};
const OTHER_MANIFESTS: OwnLines = {
  leftOut: ['# Manifests outside the mod folders, the rest left out', '# End of manifests outside the mod folders, the rest left out'],
  letIn: ['# Manifests outside the mod folders', '# End of manifests outside the mod folders'],
};
const WHITELIST_LAST_LINE = `!/${MODS}/*/*.${MANIFEST_SUFFIX.slice(1)}`;

const markersOf = (role: Role): Markers[] => [SOURCE_MODS[role], OTHER_MANIFESTS[role]];

function afterLeftOutBlocks(lines: readonly string[], at: number): number {
  const markers = markersOf('leftOut').find(([first]) => first === lines[at]);
  const end = markers === undefined ? -1 : lines.indexOf(markers[1], at);
  return end === -1 ? at : afterLeftOutBlocks(lines, end + 1);
}

function beforeLetInBlocks(lines: readonly string[], at: number): number {
  const markers = markersOf('letIn').find(([, last]) => last === lines[at - 1]);
  const begin = markers === undefined ? -1 : lines.lastIndexOf(markers[0], at - 1);
  return begin === -1 ? at : beforeLetInBlocks(lines, begin);
}

// The run of blocks of `role`: the left-out ones after the whitelist, or first with none; the let-in ones last.
function runOf(lines: readonly string[], role: Role): { readonly start: number; readonly end: number } {
  if (role === 'letIn') return { start: beforeLetInBlocks(lines, lines.length), end: lines.length };
  const start = lines.findLastIndex((line) => line.trimEnd() === WHITELIST_LAST_LINE) + 1;
  return { start, end: afterLeftOutBlocks(lines, start) };
}

// The block of `role` made of `inner`, and gone with no `inner`: in place in its run, else moved to the run's end. False
// when its markers do not pair.
function placed(lines: string[], role: Role, [first, last]: Markers, inner: readonly string[]): boolean {
  const begin = lines.indexOf(first);
  const end = lines.indexOf(last);
  if ((begin === -1) !== (end === -1) || end < begin) return false;
  const block = inner.length === 0 ? [] : [first, ...inner, last];
  const run = runOf(lines, role);
  if (begin !== -1 && begin >= run.start && begin < run.end) {
    lines.splice(begin, end - begin + 1, ...block);
    return true;
  }
  if (begin !== -1) lines.splice(begin, end - begin + 1);
  lines.splice(runOf(lines, role).end, 0, ...block);
  return true;
}

// An ignore list with `own` written as its kind's two blocks, every other line kept. Undefined when markers do not pair.
function withOwnLines(ignoreList: string, kind: OwnLines, own: readonly string[]): string | undefined {
  const lines = ignoreList.split('\n');
  if (lines.at(-1) === '') lines.pop();
  const letIn = own.filter((line) => line.startsWith('!'));
  const leftOut = own.filter((line) => !line.startsWith('!'));
  return placed(lines, 'leftOut', kind.leftOut, leftOut) && placed(lines, 'letIn', kind.letIn, letIn) ? `${lines.join('\n')}\n` : undefined;
}

/** An ignore list with the lines of `folderNames`, the source mods with a remote. Undefined when their markers do not
 *  pair. */
export const withSourceModLines = (ignoreList: string, folderNames: readonly string[]): string | undefined =>
  withOwnLines(ignoreList, SOURCE_MODS, folderNames.length === 0 ? [] : [
    `!/${SOURCE_MODS_FOLDER}/`, `/${SOURCE_MODS_FOLDER}/*`, ...folderNames.map((name) => `!/${SOURCE_MODS_FOLDER}/${escapedForIgnoreList(name)}`),
  ]);

// Each folder above a manifest is let in once, before the folders and the manifest it holds.
function otherManifestLines(manifests: readonly (readonly string[])[]): string[] {
  const lines: string[] = [];
  const letIn = new Set<string>();
  for (const segments of manifests) {
    const escaped = segments.map(escapedForIgnoreList);
    for (const at of escaped.slice(0, -1).keys()) {
      const folder = escaped.slice(0, at + 1).join('/');
      if (!letIn.has(folder)) lines.push(`!/${folder}/`, `/${folder}/*`);
      letIn.add(folder);
    }
    lines.push(`!/${escaped.join('/')}`);
  }
  return lines;
}

/** An ignore list with the lines of other manifests, each by its path in the instance. Undefined when their markers do
 *  not pair. */
export const withOtherManifestLines = (ignoreList: string, manifests: readonly (readonly string[])[]): string | undefined =>
  withOwnLines(ignoreList, OTHER_MANIFESTS, otherManifestLines(manifests));

/** The whitelist (modlist-repository.md, The repository, story 2): each mod's metadata stays out. */
export const whitelistIgnoreList = (publisherFileName: string | undefined): string => `${[
  '/*', `!/${IGNORE_LIST_FILE}`, `!/${SUBMODULES_FILE}`, `!/${SETTINGS_FILE_NAME}`,
  ...publisherFileName === undefined ? [] : [`!/${escapedForIgnoreList(publisherFileName)}`],
  ...heldInEachFolderOf(PROFILES, [MODLIST_FILE_NAME, PLUGINS_FILE_NAME, PLUGIN_ORDER_FILE, `*.${anyCase('ini')}`]),
  ...heldInEachFolderOf(MODS, [`*.${MANIFEST_SUFFIX.slice(1)}`]),
].join('\n')}\n`;

/** The mod manager's configuration as git's attributes match it. */
export const SETTINGS_FILE_PATTERN = `/${SETTINGS_FILE_NAME}`;

/** Each profile's INIs as git's attributes match them. */
export const PROFILE_INIS_PATTERN = `/${PROFILES}/*/*.${anyCase('ini')}`;

/** The archives at the root of the Data folder and the files of its strings folder, the Data folder its base. */
export const dataFolderArchivesGlob = (archiveExtension: string, stringsFolder: string): string =>
  `{*${anyCase(archiveExtension)},${anyCase(stringsFolder)}/*}`;
