// Every per-game fact needed to find an install, speak to Nexus and name the plugins the game loads
// with no line, keyed by Mutagen's GameRelease, and where a plugin sits in an install.

import { join, parse } from 'node:path';

export interface GamePathInfo {
  /** The game's name as an instance's settings spell it. */
  readonly gameName: string;
  /** The Nexus slug — the {game} segment of nexusmods.com/{game}/mods/{id}. */
  readonly nexusSlug: string;
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
  readonly pluginCompanions: PluginCompanions;
}

/** What the game names for a plugin, besides the plugin. */
interface PluginCompanions {
  /** With its period: Mutagen's `ArchiveExtensionProvider` for the release. */
  readonly archiveExtension: string;
  /** As Mutagen's `StringsLanguageFormat` for the release spells them in `<plugin>_<language>.STRINGS`;
   *  which of them the game ships is this table's own. None for a game with no strings. */
  readonly stringsLanguages: readonly string[];
  /** Whether the game ties `<plugin>.ini` to the plugin. No reference defines this: it is the
   *  Creation Engine's convention, which Oblivion and the Fallout 3 engine do not share. */
  readonly pluginIni: boolean;
}

const FALLOUT4_MASTERS = [
  'Fallout4.esm', 'DLCRobot.esm', 'DLCworkshop01.esm', 'DLCCoast.esm', 'DLCworkshop02.esm', 'DLCworkshop03.esm',
  'DLCNukaWorld.esm',
];
const SKYRIM_MASTERS = ['Skyrim.esm', 'Update.esm', 'Dawnguard.esm', 'HearthFires.esm', 'Dragonborn.esm'];
const FALLOUT4_COMPANIONS: PluginCompanions = {
  archiveExtension: '.ba2',
  stringsLanguages: ['en', 'de', 'it', 'es', 'esmx', 'fr', 'pl', 'cn', 'zhhans', 'ja', 'ptbr', 'ru'],
  pluginIni: true,
};
const SKYRIM_COMPANIONS: PluginCompanions = {
  archiveExtension: '.bsa',
  stringsLanguages: ['English', 'German', 'Italian', 'Spanish', 'French', 'Polish', 'Russian', 'Japanese', 'Czech', 'Chinese'],
  pluginIni: true,
};
const NO_STRINGS_COMPANIONS: PluginCompanions = { archiveExtension: '.bsa', stringsLanguages: [], pluginIni: false };

// Only Fallout 4 carries Steam autodetection facts today — a fixture choice, not a platform lock.
const GAME_PATHS: Record<string, GamePathInfo> = {
  Fallout4: {
    gameName: 'Fallout 4', nexusSlug: 'fallout4', steamAppId: '377160', steamFolderName: 'Fallout 4',
    masters: FALLOUT4_MASTERS, creationClubList: 'Fallout4.ccc',
    scriptExtenderFolder: 'f4se', pluginCompanions: FALLOUT4_COMPANIONS,
  },
  Fallout4VR: {
    gameName: 'Fallout 4 VR', nexusSlug: 'fallout4', masters: [...FALLOUT4_MASTERS, 'Fallout4_VR.esm'],
    creationClubList: 'Fallout4.ccc',
    scriptExtenderFolder: 'f4se', pluginCompanions: FALLOUT4_COMPANIONS,
  },
  Fallout3: { gameName: 'Fallout 3', nexusSlug: 'fallout3', masters: ['Fallout3.esm'], scriptExtenderFolder: 'fose', pluginCompanions: NO_STRINGS_COMPANIONS },
  FalloutNV: { gameName: 'Fallout New Vegas', nexusSlug: 'newvegas', masters: ['FalloutNV.esm'], scriptExtenderFolder: 'nvse', pluginCompanions: NO_STRINGS_COMPANIONS },
  SkyrimLE: { gameName: 'Skyrim', nexusSlug: 'skyrim', masters: SKYRIM_MASTERS, creationClubList: 'Skyrim.ccc', scriptExtenderFolder: 'skse', pluginCompanions: SKYRIM_COMPANIONS },
  SkyrimSE: {
    gameName: 'Skyrim Special Edition', nexusSlug: 'skyrimspecialedition', masters: SKYRIM_MASTERS,
    creationClubList: 'Skyrim.ccc',
    scriptExtenderFolder: 'skse', pluginCompanions: SKYRIM_COMPANIONS,
  },
  SkyrimVR: {
    gameName: 'Skyrim VR', nexusSlug: 'skyrimspecialedition', masters: [...SKYRIM_MASTERS, 'SkyrimVR.esm'],
    creationClubList: 'Skyrim.ccc',
    scriptExtenderFolder: 'skse', pluginCompanions: SKYRIM_COMPANIONS,
  },
  EnderalLE: { gameName: 'Enderal', nexusSlug: 'enderal', masters: SKYRIM_MASTERS, creationClubList: 'Skyrim.ccc', scriptExtenderFolder: 'skse', pluginCompanions: SKYRIM_COMPANIONS },
  Oblivion: { gameName: 'Oblivion', nexusSlug: 'oblivion', masters: ['Oblivion.esm'], scriptExtenderFolder: 'obse', pluginCompanions: NO_STRINGS_COMPANIONS },
};

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

/** Nexus slug for a release; a game with none falls back to its lowercased, space-stripped name
 *  (a best guess that matches most Nexus domains). */
export function nexusSlugFor(gameRelease: string | undefined, gameName: string): string {
  const info = gameRelease === undefined ? undefined : GAME_PATHS[gameRelease];
  return info?.nexusSlug ?? gameName.toLowerCase().replace(/\s+/g, '');
}

/** The install-location facts for a release, or `undefined` when the table holds none for it —
 *  the autodetector's signal to give up rather than guess a folder. */
export function gamePathInfoForRelease(release: string): GamePathInfo | undefined {
  return GAME_PATHS[release];
}

/** The game's masters for a release, in the order the game loads them; none for a release the
 *  table holds no row for. */
export function gameMastersOf(release: string | undefined): readonly string[] {
  return (release === undefined ? undefined : GAME_PATHS[release])?.masters ?? [];
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
  inRoot(plugin: string, name: string): boolean;
  inStringsFolder(plugin: string, name: string): boolean;
}

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

/** The rule for what the release names for a plugin; none for a release the table holds no row for. */
export function pluginCompanionRule(release: string | undefined): PluginCompanionRule | undefined {
  const companions = release === undefined ? undefined : GAME_PATHS[release]?.pluginCompanions;
  if (companions === undefined) return undefined;
  const languages = companions.stringsLanguages.map((language) => language.toLowerCase());
  return {
    stringsFolder: 'strings',
    inRoot: (plugin, name) => {
      const stem = stemOf(plugin);
      return isArchiveOf(stem, name, companions.archiveExtension) || (companions.pluginIni && name.toLowerCase() === `${stem}.ini`);
    },
    inStringsFolder: (plugin, name) => {
      const key = name.toLowerCase();
      const stem = stemOf(plugin);
      return languages.some((language) => STRINGS_EXTENSIONS.some((extension) => key === `${stem}_${language}${extension}`));
    },
  };
}

/** A game folder as plain data: found, with its Data folder, or not found. */
export type GameFolderData = { readonly kind: 'found'; readonly dataFolder: string } | { readonly kind: 'notFound' };

/** The Data folder of a game folder found, undefined when it was not. */
export function dataFolderOf(folder: GameFolderData): string | undefined {
  return folder.kind === 'found' ? folder.dataFolder : undefined;
}

/** A file at the root of the Data folder of a game folder found, undefined when it was not. */
export function dataFolderFile(folder: GameFolderData, name: string): string | undefined {
  const dataFolder = dataFolderOf(folder);
  return dataFolder === undefined ? undefined : join(dataFolder, name);
}
