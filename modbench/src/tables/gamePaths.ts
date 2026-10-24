// Every per-game fact needed to find an install, speak to Nexus and name the plugins the game loads
// with no line, keyed by Mutagen's GameRelease, and where a plugin sits in an install.

import { join, parse } from 'node:path';

export interface GamePathInfo {
  /** The game's name as an instance's settings spell it. */
  readonly gameName: string;
  /** The Nexus slug — the {game} segment of nexusmods.com/{game}/mods/{id}. */
  readonly nexusSlug: string;
  /** The other releases whose files the mod manager also accepts as this game's, by the short names it knows them by, in the order it asks Nexus about them. */
  readonly validShortNames?: readonly string[];
  /** Steam's numeric app id, when the release ships on Steam. Needed to find which Steam
   *  library holds the install (`libraryfolders.vdf`) and its Proton prefix. Absent for a
   *  release the table only knows the Nexus slug for. */
  readonly steamAppId?: string;
  /** The `steamapps/common/<name>` folder holding the install. Absent alongside `steamAppId`. */
  readonly steamFolderName?: string;
  /** The game's masters: the plugins it loads with no plugins.txt line, in the order it loads
   *  them. Mutagen's `Implicits.Listings` for the release. */
  readonly masters: readonly string[];
  /** The Creation Club list's file name in the game folder, for a release that has one. */
  readonly creationClubList?: string;
  /** The folder a mod's script-extender files sit in, under the Data folder. */
  readonly scriptExtenderFolder: string;
  readonly programs: Programs;
  readonly pluginCompanions: PluginCompanions;
  readonly archiveLists: ArchiveLists;
  /** The BA2 versions the release reads its archives of textures and its other archives as; absent until what mEdit
   *  writes is known to load in the game. */
  readonly ba2Versions?: Ba2Versions;
}

/** In the game folder: the game's program, and its script extender's loader. */
export interface Programs {
  readonly game: string;
  readonly extenderLoader: string;
}

export interface Ba2Versions {
  readonly general: number;
  readonly textures: number;
}

/** The INIs whose `[Archive]` keys list the archives the game loads, and those keys: xEdit's for the
 *  release. */
export interface ArchiveLists {
  /** In the game folder: the INI the user's own start from. */
  readonly defaultIni: string;
  /** The user's INIs, in the order the game reads them. Where they are is the mod manager's. */
  readonly userInis: readonly string[];
  /** Under `Documents/My Games`, where the game keeps its own copies of them. */
  readonly myGamesFolder: string;
  /** In the order the game loads the archives they list. */
  readonly keys: readonly string[];
}

interface PluginCompanions {
  /** With its period: Mutagen's `ArchiveExtensionProvider` for the release. */
  readonly archiveExtension: string;
  /** As Mutagen's `StringsLanguageFormat` for the release spells them in `<plugin>_<language>.STRINGS`;
   *  which of them the game ships is this table's own. */
  readonly stringsLanguages: readonly string[];
}

const FALLOUT4_MASTERS = [
  'Fallout4.esm', 'DLCRobot.esm', 'DLCworkshop01.esm', 'DLCCoast.esm', 'DLCworkshop02.esm', 'DLCworkshop03.esm',
  'DLCNukaWorld.esm',
];
const SKYRIM_MASTERS = ['Skyrim.esm', 'Update.esm', 'Dawnguard.esm', 'HearthFires.esm', 'Dragonborn.esm'];
const STARFIELD_MASTERS = [
  'Starfield.esm', 'Constellation.esm', 'OldMars.esm', 'BlueprintShips-Starfield.esm', 'ShatteredSpace.esm',
  'SFBGS006.esm', 'SFBGS007.esm', 'SFBGS003.esm', 'SFBGS008.esm', 'SFBGS004.esm', 'SFBGS00D.esm', 'SFBGS047.esm',
  'SFBGS050.esm', 'BlueprintShips-SFBGS050.esm',
];
const FALLOUT4_COMPANIONS: PluginCompanions = {
  archiveExtension: '.ba2',
  stringsLanguages: ['en', 'de', 'it', 'es', 'esmx', 'fr', 'pl', 'cn', 'zhhans', 'ja', 'ptbr', 'ru'],
};
const SKYRIM_COMPANIONS: PluginCompanions = {
  archiveExtension: '.bsa',
  stringsLanguages: ['English', 'German', 'Italian', 'Spanish', 'French', 'Polish', 'Russian', 'Japanese', 'Czech', 'Chinese'],
};

// Next-gen Fallout 4 reads version 1 too, and writes versions 7 and 8 that mEdit does not.
const FALLOUT4_BA2_VERSIONS: Ba2Versions = { general: 1, textures: 1 };

const RESOURCE_ARCHIVE_KEYS = ['sResourceArchiveList', 'sResourceArchiveList2'];
const RESOURCE_INDEX_KEYS = ['sResourceIndexFileList', 'sResourceStartUpArchiveList', ...RESOURCE_ARCHIVE_KEYS];
const FALLOUT4_ARCHIVES: ArchiveLists = {
  myGamesFolder: 'Fallout4', defaultIni: 'Fallout4_Default.ini', userInis: ['Fallout4.ini', 'Fallout4Custom.ini'], keys: RESOURCE_INDEX_KEYS,
};
const SKYRIM_ARCHIVES: ArchiveLists = {
  myGamesFolder: 'Skyrim Special Edition', defaultIni: 'Skyrim_Default.ini', userInis: ['Skyrim.ini', 'SkyrimCustom.ini'], keys: RESOURCE_ARCHIVE_KEYS,
};

const GAME_PATHS: Record<string, GamePathInfo> = {
  Fallout4: {
    gameName: 'Fallout 4', nexusSlug: 'fallout4', steamAppId: '377160', steamFolderName: 'Fallout 4',
    masters: FALLOUT4_MASTERS, creationClubList: 'Fallout4.ccc',
    scriptExtenderFolder: 'f4se', programs: { game: 'Fallout4.exe', extenderLoader: 'f4se_loader.exe' },
    pluginCompanions: FALLOUT4_COMPANIONS, archiveLists: FALLOUT4_ARCHIVES,
    ba2Versions: FALLOUT4_BA2_VERSIONS,
  },
  Fallout4VR: {
    gameName: 'Fallout 4 VR', nexusSlug: 'fallout4', validShortNames: ['Fallout4'], masters: [...FALLOUT4_MASTERS, 'Fallout4_VR.esm'],
    creationClubList: 'Fallout4.ccc',
    scriptExtenderFolder: 'f4se', programs: { game: 'Fallout4VR.exe', extenderLoader: 'f4sevr_loader.exe' }, pluginCompanions: FALLOUT4_COMPANIONS,
    archiveLists: { ...FALLOUT4_ARCHIVES, myGamesFolder: 'Fallout4VR', defaultIni: 'Fallout4.ini' }, ba2Versions: FALLOUT4_BA2_VERSIONS,
  },
  SkyrimSE: {
    gameName: 'Skyrim Special Edition', nexusSlug: 'skyrimspecialedition', validShortNames: ['Skyrim'], steamAppId: '489830', steamFolderName: 'Skyrim Special Edition',
    masters: SKYRIM_MASTERS,
    creationClubList: 'Skyrim.ccc',
    scriptExtenderFolder: 'skse', programs: { game: 'SkyrimSE.exe', extenderLoader: 'skse64_loader.exe' },
    pluginCompanions: SKYRIM_COMPANIONS, archiveLists: SKYRIM_ARCHIVES,
  },
  SkyrimVR: {
    gameName: 'Skyrim VR', nexusSlug: 'skyrimspecialedition', validShortNames: ['Skyrim', 'SkyrimSE'], masters: [...SKYRIM_MASTERS, 'SkyrimVR.esm'],
    creationClubList: 'Skyrim.ccc',
    scriptExtenderFolder: 'skse', programs: { game: 'SkyrimVR.exe', extenderLoader: 'sksevr_loader.exe' }, pluginCompanions: SKYRIM_COMPANIONS,
    archiveLists: { ...SKYRIM_ARCHIVES, myGamesFolder: 'Skyrim VR', defaultIni: 'Skyrim.ini', userInis: ['Skyrim.ini', 'SkyrimVR.ini', 'SkyrimCustom.ini'] },
  },
  Starfield: {
    gameName: 'Starfield', nexusSlug: 'starfield', steamAppId: '1716740', steamFolderName: 'Starfield',
    masters: STARFIELD_MASTERS, creationClubList: 'Starfield.ccc',
    scriptExtenderFolder: 'sfse', programs: { game: 'Starfield.exe', extenderLoader: 'sfse_loader.exe' }, pluginCompanions: FALLOUT4_COMPANIONS,
    archiveLists: { myGamesFolder: 'Starfield', defaultIni: 'Starfield.ini', userInis: ['StarfieldCustom.ini'], keys: RESOURCE_INDEX_KEYS },
  },
};

/** @public Read by the game-name scan alone. */
export const GAME_RELEASES: readonly string[] = Object.keys(GAME_PATHS);

/** Every script-extender folder name, lowercased. */
export const SCRIPT_EXTENDER_FOLDERS: ReadonlySet<string> = new Set(
  Object.values(GAME_PATHS).map((info) => info.scriptExtenderFolder.toLowerCase()),
);

// Rebuilt from the table above so the two directions can never disagree. Morrowind resolves to no
// entry: Mutagen has no release for it.
const RELEASE_BY_GAME_NAME: ReadonlyMap<string, string> = new Map(
  Object.entries(GAME_PATHS).map(([release, info]) => [info.gameName, release]),
);

/** Mutagen's release name for a game's name as an instance's settings spell it, `undefined` when
 *  the table holds none. Never a guess: a wrong release has the backend answer about another game. */
export function gameReleaseForGame(gameName: string): string | undefined {
  return RELEASE_BY_GAME_NAME.get(gameName);
}

// Mutagen's release name for a game as a mod's metadata spells it: as the settings do, or as the release is named,
// which is the mod manager's short name for most. `undefined` when the table holds none.
function gameReleaseForMetaGame(gameName: string): string | undefined {
  return gameReleaseForGame(gameName) ?? Object.keys(GAME_PATHS).find((release) => release.toLowerCase() === gameName.toLowerCase());
}

/** The first release whose Nexus domain is `domain`; `undefined` when the table holds none. */
export function gameReleaseForNexusDomain(domain: string): string | undefined {
  return Object.keys(GAME_PATHS).find((release) => GAME_PATHS[release]?.nexusSlug === domain);
}

/** The Nexus domain of a game as a mod's or a downloaded file's metadata spells it; `undefined` when the table holds none.
 *  Never a guess from the name: a wrong domain opens another game's page. */
export function nexusDomainForMetaGame(gameName: string): string | undefined {
  const release = gameReleaseForMetaGame(gameName);
  return release === undefined ? undefined : GAME_PATHS[release]?.nexusSlug;
}

// The games a valid short name can name though Modbench supports none of their releases: short name to Nexus domain.
const NEXUS_DOMAINS_OF_UNSUPPORTED_SHORT_NAMES: Readonly<Record<string, string>> = { Skyrim: 'skyrim' };

const nexusDomainOfShortName = (shortName: string): string | undefined =>
  nexusDomainForMetaGame(shortName) ?? NEXUS_DOMAINS_OF_UNSUPPORTED_SHORT_NAMES[shortName];

/** The Nexus domains the mod manager asks about a file of the game `gameName` names, in its order: the game's own, then each valid short name's. */
export function nexusDomainsForGame(gameName: string): string[] {
  const release = gameReleaseForGame(gameName);
  if (release === undefined) return [];
  const domains = [release, ...(GAME_PATHS[release]?.validShortNames ?? [])].flatMap((name) => nexusDomainOfShortName(name) ?? []);
  return domains.filter((domain, i) => domains.indexOf(domain) === i);
}

/** The short name a downloaded file's metadata gives a game on Nexus's `domain`; `undefined` when the tables hold none. */
export function shortNameForNexusDomain(domain: string): string | undefined {
  return gameReleaseForNexusDomain(domain) ?? Object.keys(NEXUS_DOMAINS_OF_UNSUPPORTED_SHORT_NAMES).find((name) => NEXUS_DOMAINS_OF_UNSUPPORTED_SHORT_NAMES[name] === domain);
}

/** The install-location facts for a release, or `undefined` when the table holds none for it —
 *  the autodetector's signal to give up rather than guess a folder. */
export function gamePathInfoForRelease(release: string): GamePathInfo | undefined {
  return GAME_PATHS[release];
}

/** The game's programs in the game folder; none for no release, or a release the table holds no row for. */
export function programsOf(release: string | undefined): Programs | undefined {
  return release === undefined ? undefined : GAME_PATHS[release]?.programs;
}

/** The plugins the game loads with no line (ADR-0013): its masters in the order the game loads
 *  them, none for a release the table holds no row for, then those its Creation Club list names. */
export function loadedWithNoLineOf(release: string | undefined, creationClubList: readonly string[]): readonly string[] {
  const masters = (release === undefined ? undefined : GAME_PATHS[release])?.masters ?? [];
  return [...masters, ...creationClubList];
}

/** The release's Creation Club list in the game folder at `root`; undefined for a release with no
 *  Creation Club. */
export function creationClubListFile(root: string, release: string | undefined): string | undefined {
  const file = release === undefined ? undefined : GAME_PATHS[release]?.creationClubList;
  return file === undefined ? undefined : join(root, file);
}

/** Which names in a mod folder are the files the game names for a plugin: the ones at its root, and
 *  the ones in its strings folder. Names match without case. */
export interface PluginCompanionRule {
  readonly stringsFolder: string;
  /** With its period. */
  readonly archiveExtension: string;
  inRoot(plugin: string, name: string): boolean;
  /** The archives in the root the game loads with the plugin. */
  isArchiveOf(plugin: string, name: string): boolean;
  inStringsFolder(plugin: string, name: string): boolean;
  /** An archive the release loads, of any plugin or of none, at a folder's root. */
  readonly isArchive: (relativePath: string) => boolean;
  /** A strings file of any plugin, in any language, in the strings folder at a folder's root. */
  readonly isStringsFile: (relativePath: string) => boolean;
  /** One of `plugin`'s strings files, in the strings folder at a folder's root. */
  isStringsFileOf(plugin: string, relativePath: string): boolean;
}

const STRINGS_FOLDER = 'strings';
const STRINGS_EXTENSIONS = ['.strings', '.dlstrings', '.ilstrings'];
const ARCHIVE_PART_DELIMITER = ' - ';

const stemOf = (plugin: string): string => parse(plugin).name.toLowerCase();

// Mutagen's `CheckArchiveApplicability`: the archive's name, or its name cut at the last delimiter,
// is the plugin's name.
function isArchiveOf(stem: string, name: string, extension: string): boolean {
  const key = name.toLowerCase();
  if (!key.endsWith(extension)) return false;
  const bare = key.slice(0, key.length - extension.length);
  const cut = bare.lastIndexOf(ARCHIVE_PART_DELIMITER);
  return bare === stem || (cut !== -1 && bare.slice(0, cut) === stem);
}

/** The BA2 versions a build packs the release's archives as; none for a release the table names none for. */
export function ba2VersionsOf(release: string): Ba2Versions | undefined {
  return GAME_PATHS[release]?.ba2Versions;
}

/** The rule for what the release names for a plugin; none for a release the table holds no row for. */
export function pluginCompanionRule(release: string | undefined): PluginCompanionRule | undefined {
  const companions = release === undefined ? undefined : GAME_PATHS[release]?.pluginCompanions;
  if (companions === undefined) return undefined;
  const languages = companions.stringsLanguages.map((language) => language.toLowerCase());
  const isStringsFile = (relativePath: string): boolean => {
    const [folder, name, ...below] = relativePath.toLowerCase().split('/');
    return folder === STRINGS_FOLDER && below.length === 0 && STRINGS_EXTENSIONS.some((extension) => name?.endsWith(extension));
  };
  const inStringsFolder = (plugin: string, name: string): boolean => {
    const key = name.toLowerCase();
    const stem = stemOf(plugin);
    return languages.some((language) => STRINGS_EXTENSIONS.some((extension) => key === `${stem}_${language}${extension}`));
  };
  return {
    stringsFolder: STRINGS_FOLDER,
    archiveExtension: companions.archiveExtension,
    isArchiveOf: (plugin, name) => isArchiveOf(stemOf(plugin), name, companions.archiveExtension),
    isArchive: (relativePath) => !relativePath.includes('/') && relativePath.toLowerCase().endsWith(companions.archiveExtension),
    isStringsFile,
    isStringsFileOf: (plugin, relativePath) => isStringsFile(relativePath) && inStringsFolder(plugin, relativePath.slice(STRINGS_FOLDER.length + 1)),
    inRoot: (plugin, name) => {
      const stem = stemOf(plugin);
      return isArchiveOf(stem, name, companions.archiveExtension) || name.toLowerCase() === `${stem}.ini`;
    },
    inStringsFolder,
  };
}

/** Where the game's INIs list the archives it loads; none for no release, or a release the table
 *  holds no row for. */
export function archiveListsOf(release: string | undefined): ArchiveLists | undefined {
  return release === undefined ? undefined : GAME_PATHS[release]?.archiveLists;
}
