// Where the game is: the setting first, then the instance's own ini, then Steam and Wine detection.
// The user's overrides arrive from the composition root as values; nothing here reads a setting itself.

import { dirname, join } from 'node:path';
import { readGameName, readGamePath } from '../mo2Codecs/modOrganizerIni';
import { gamePathInfoForRelease, gameReleaseForGame } from '../tables/gamePaths';
import { detectGamePaths, detectWinePrefix, type GameAutodetect, type GamePaths } from './gamePathDetector';
import { factsOf } from './files';
import { present } from '../ports/present';
import { errorMessage } from '../ports/errorMessage';

/** The setting that names the game folder outright, and so the one that fixes a folder not found. */
export const GAME_FOLDER_SETTING = 'modbench.mods.gameDirectory';

/** One place Modbench looked for the game folder, and what it found there. */
export interface GameFolderLook {
  readonly place: string;
  readonly answer: string;
}

/** Where the game is, or each place Modbench looked for it and why none answered. Not finding it
 *  is an answer, never a failed read: every row that does not need the game folder still shows. */
export type GameFolder =
  | {
    readonly kind: 'found';
    /** Folder containing the game executable and Data/. */
    readonly root: string;
    readonly dataFolder: string;
  }
  | {
    readonly kind: 'notFound';
    /** In the order Modbench looked; a place after one that refused to fall through is absent. */
    readonly looked: readonly GameFolderLook[];
    readonly setting: string;
  };

/** What the user set, read fresh on each resolve by whoever built the resolver. */
export interface GameDirectoryOverrides {
  /** The game folder outright (`GAME_FOLDER_SETTING`). */
  gameDirectory?: string;
}

/** Answers where the game is for one generation of ModOrganizer.ini's text — the Instance's own
 *  read, so a resolution can never come from a different generation than the value it lands in. */
export type GameDirectoryResolver = (iniText: string) => Promise<GameFolder>;

/** The Data folder of a game folder found, undefined when it was not. */
export function dataFolderOf(folder: GameFolder): string | undefined {
  return folder.kind === 'found' ? folder.dataFolder : undefined;
}

/** The Proton prefix root (`.../compatdata/<appid>/pfx`), or null if undeterminable. */
export type DetectWinePrefix = () => Promise<string | null>;

/** What Steam is asked, injectable so both fallbacks are testable without a Steam install. */
export interface GameDetectors {
  paths: (game: GameAutodetect) => Promise<GamePaths | null>;
  winePrefix: (steamAppId: string) => Promise<string | null>;
}

export const STEAM: GameDetectors = {
  paths: (game) => detectGamePaths(process.platform, game),
  winePrefix: detectWinePrefix,
};

/** Wine fixes `Z:` to the filesystem root and `C:` to the prefix's own `drive_c`; any other
 *  letter is a user-defined `dosdevices` mapping that can point anywhere, so it is surfaced as
 *  an error rather than guessed at. */
export async function normalizeGamePath(
  p: string,
  platform: NodeJS.Platform,
  detectPrefix: DetectWinePrefix,
): Promise<string> {
  if (platform === 'win32') return p;

  const match = /^([A-Za-z]):(.*)$/s.exec(p);
  if (!match) return p.replaceAll('\\', '/');

  const drive = present(match[1], 'drive letter in a Windows-style path');
  const rest = present(match[2], 'remainder in a Windows-style path');
  const posixRest = rest.replaceAll('\\', '/');
  if (drive.toUpperCase() === 'Z') return posixRest;

  if (drive.toUpperCase() !== 'C') {
    throw new Error(`Cannot translate Wine drive letter '${drive}:' in '${p}': only Z: and C: are translated`);
  }

  const prefix = await detectPrefix();
  if (!prefix) {
    throw new Error(`Cannot translate Wine path '${p}': the Proton prefix could not be determined`);
  }
  return join(prefix, 'drive_c', posixRest);
}

async function hasDataFolder(root: string): Promise<boolean> {
  try {
    return (await factsOf(join(root, 'Data'))).kind === 'directory';
  } catch {
    return false;
  }
}

// `undefined` when the ini names no game, names no release the tables know, or the tables hold
// no Steam facts for it — any of which leaves autodetection nothing to go on.
function autodetectFacts(iniText: string): GameAutodetect | undefined {
  let release: string | undefined;
  try {
    release = gameReleaseForGame(readGameName(iniText));
  } catch {
    return undefined;
  }
  if (!release) return undefined;
  const paths = gamePathInfoForRelease(release);
  if (!paths?.steamAppId || !paths.steamFolderName) return undefined;
  return { steamAppId: paths.steamAppId, steamFolderName: paths.steamFolderName };
}

/** The Wine prefix detector for the game the ini names — `normalizeGamePath`'s own translation,
 *  shared so a path other than `gamePath` (`download_directory`, set through the same native
 *  dialog under Wine) translates a `C:` drive the same way. */
export function winePrefixDetectorFor(iniText: string, detectors: GameDetectors = STEAM): DetectWinePrefix {
  const facts = autodetectFacts(iniText);
  return () => (facts ? detectors.winePrefix(facts.steamAppId) : Promise.resolve(null));
}

// A setting left at its empty default is not set: every branch below reads absence as undefined.
function set(value: string | undefined): string | undefined {
  const trimmed = (value ?? '').trim();
  return trimmed === '' ? undefined : trimmed;
}

const SETTING_PLACE = `the game folder setting, ${GAME_FOLDER_SETTING}`;
const GAME_PATH_PLACE = "ModOrganizer.ini's gamePath";
const STEAM_PLACE = 'the Steam install';
const NOT_SET = 'not set';

type Looked = { found: string } | { look: GameFolderLook; fallThrough: boolean };

const noDataFolder = (place: string, root: string): Looked =>
  ({ look: { place, answer: `${root} has no Data folder` }, fallThrough: true });

// A translation failure refuses to fall through to Steam: resolving a different game folder
// entirely would hide the real problem.
async function iniGamePath(iniText: string, detectors: GameDetectors): Promise<Looked> {
  let raw: string;
  try {
    raw = readGamePath(iniText);
  } catch {
    return { look: { place: GAME_PATH_PLACE, answer: NOT_SET }, fallThrough: true };
  }
  let root: string;
  try {
    root = await normalizeGamePath(raw, process.platform, winePrefixDetectorFor(iniText, detectors));
  } catch (err) {
    return { look: { place: GAME_PATH_PLACE, answer: errorMessage(err) }, fallThrough: false };
  }
  return (await hasDataFolder(root)) ? { found: root } : noDataFolder(GAME_PATH_PLACE, root);
}

/** The setting, then MO2's `gamePath`, then autodetect. A set setting with no Data folder refuses
 *  to fall through, because it names the folder the user chose. */
export function gameDirectoryResolver(
  overridesOf: () => GameDirectoryOverrides, detectors: GameDetectors = STEAM,
): GameDirectoryResolver {
  return async (iniText: string): Promise<GameFolder> => {
    const facts = autodetectFacts(iniText);
    const at = (root: string): GameFolder => ({ kind: 'found', root, dataFolder: join(root, 'Data') });
    const looked: GameFolderLook[] = [];
    const notFound = (): GameFolder => ({ kind: 'notFound', looked, setting: GAME_FOLDER_SETTING });

    const explicit = set(overridesOf().gameDirectory);
    if (explicit !== undefined) {
      if (await hasDataFolder(explicit)) return at(explicit);
      looked.push({ place: SETTING_PLACE, answer: `${explicit} has no Data folder` });
      return notFound();
    }
    looked.push({ place: SETTING_PLACE, answer: NOT_SET });

    const fromIni = await iniGamePath(iniText, detectors);
    if ('found' in fromIni) return at(fromIni.found);
    looked.push(fromIni.look);
    if (!fromIni.fallThrough) return notFound();

    if (!facts) {
      looked.push({ place: STEAM_PLACE, answer: 'not asked: Modbench has no Steam entry for this game' });
      return notFound();
    }
    // Last, because a detection reads Steam's library file and runs `reg query` on Windows.
    const detected = await detectors.paths(facts);
    if (detected) return { kind: 'found', root: dirname(detected.dataFolder), dataFolder: detected.dataFolder };
    looked.push({ place: STEAM_PLACE, answer: 'the game is in no Steam library' });
    return notFound();
  };
}
