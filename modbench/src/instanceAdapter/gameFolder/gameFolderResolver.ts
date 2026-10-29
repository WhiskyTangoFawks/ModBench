// Where the game is: the setting, then the manager's game path, then Steam and Wine detection.

import { exec } from 'node:child_process';
import { dirname, join, posix, win32 } from 'node:path';
import { promisify } from 'node:util';
import { gamePathInfoForRelease } from '../../tables/gamePaths';
import { detectGamePaths, detectWinePrefix, type GameAutodetect, type GamePaths } from './gamePathDetector';
import { documentsFolder } from './documentsFolder';
import { factsOf } from '../files';
import { present } from '../../ports/present';
import { errorMessage } from '../../ports/errorMessage';
import type { FoundGameFolder, GameFolder, GameFolderLook, GameFolderSetting, SteamInstall } from '../instanceAdapter';
import { installedDepots } from './steamAppManifest';

export const DATA_FOLDER = 'Data';

// What the mod manager says about where the game is, read by the manager from its own configuration.
export interface ManagerGamePath {
  // As the manager spells it, a Windows path under Wine; undefined when it names none.
  readonly path: string | undefined;
  readonly place: string;
  // The Mutagen release of the game the manager is for; undefined when it names none the tables know.
  readonly release: string | undefined;
}

/** Answers where the game is for one generation of the manager's configuration — the Instance's own
 *  read, so a resolution can never come from a different generation than the value it lands in. */
export type GameFolderResolver = (managed: ManagerGamePath) => Promise<GameFolder>;

export type SteamInstallResolver = (release: string | undefined) => Promise<SteamInstall | undefined>;

type DetectWinePrefix = () => Promise<string | null>;

/** What Steam is asked, injectable so both fallbacks are testable without a Steam install. */
export interface GameDetectors {
  paths: (game: GameAutodetect) => Promise<GamePaths | null>;
  winePrefix: (steamAppId: string) => Promise<string | null>;
  /** The user's Documents folder as Windows has it, wherever it was redirected to. */
  documents: () => Promise<string>;
}

const execAsync = promisify(exec);

export const STEAM: GameDetectors = {
  paths: (game) =>
    detectGamePaths(process.platform, game, () =>
      execAsync('reg query "HKCU\\Software\\Valve\\Steam" /v SteamPath').then((r) => r.stdout),
    ),
  winePrefix: detectWinePrefix,
  documents: () => documentsFolder(),
};

/** Wine fixes `Z:` to the filesystem root and `C:` to the prefix's own `drive_c`; any other
 *  letter is a user-defined `dosdevices` mapping that can point anywhere, so it is surfaced as
 *  an error rather than guessed at. */
export async function normalizeGamePath(
  p: string,
  platform: NodeJS.Platform,
  detectPrefix: DetectWinePrefix,
): Promise<string> {
  if (platform === 'win32') return win32.normalize(p);

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
  return posix.join(prefix, 'drive_c', posixRest);
}

async function hasDataFolder(root: string): Promise<boolean> {
  try {
    return (await factsOf(join(root, DATA_FOLDER))).kind === 'directory';
  } catch {
    return false;
  }
}

// `undefined` when no release is named, or the tables hold no Steam facts for it — either leaves
// autodetection nothing to go on.
function autodetectFacts(release: string | undefined): GameAutodetect | undefined {
  const paths = release === undefined ? undefined : gamePathInfoForRelease(release);
  if (!paths?.steamAppId || !paths.steamFolderName) return undefined;
  return { steamAppId: paths.steamAppId, steamFolderName: paths.steamFolderName };
}

/** The Wine prefix detector for a release — `normalizeGamePath`'s own translation, shared so a
 *  path other than the game path (the manager's downloads folder, set through the same native
 *  dialog under Wine) translates a `C:` drive the same way. */
export function winePrefixDetectorFor(release: string | undefined, detectors: GameDetectors = STEAM): DetectWinePrefix {
  const facts = autodetectFacts(release);
  return () => (facts ? detectors.winePrefix(facts.steamAppId) : Promise.resolve(null));
}

// A setting left at its empty default is not set: every branch below reads absence as undefined.
function set(value: string | undefined): string | undefined {
  const trimmed = (value ?? '').trim();
  return trimmed === '' ? undefined : trimmed;
}

const STEAM_PLACE = 'the Steam install';
const NOT_SET = 'not set';

type Looked = { found: string } | { look: GameFolderLook; fallThrough: boolean };

const noDataFolder = (place: string, root: string): Looked =>
  ({ look: { place, answer: `${root} has no Data folder` }, fallThrough: false });

// A configured folder that cannot be used refuses to fall through to Steam: resolving a different
// game folder entirely would hide the real problem. Only a manager naming no folder falls through.
async function managerGamePath(managed: ManagerGamePath, detectors: GameDetectors): Promise<Looked> {
  const { path: raw, place, release } = managed;
  if (raw === undefined) return { look: { place, answer: NOT_SET }, fallThrough: true };
  let root: string;
  try {
    root = await normalizeGamePath(raw, process.platform, winePrefixDetectorFor(release, detectors));
  } catch (err) {
    return { look: { place, answer: errorMessage(err) }, fallThrough: false };
  }
  return (await hasDataFolder(root)) ? { found: root } : noDataFolder(place, root);
}

async function steamInstall(facts: GameAutodetect, detectors: GameDetectors): Promise<FoundGameFolder | undefined> {
  const detected = await detectors.paths(facts);
  return detected ? { kind: 'found', root: dirname(detected.dataFolder), dataFolder: detected.dataFolder } : undefined;
}

/** The game's install in Steam's library, wherever the game folder is. */
export function steamInstallResolver(detectors: GameDetectors = STEAM): SteamInstallResolver {
  return async (release) => {
    const facts = autodetectFacts(release);
    const install = facts ? await steamInstall(facts, detectors) : undefined;
    if (facts === undefined || install === undefined) return undefined;
    const { depots, problems } = await installedDepots(dirname(dirname(install.root)), facts.steamAppId);
    return { ...install, depots, depotProblems: problems };
  };
}

/** The setting, then the manager's game path, then autodetect. A folder the setting or the manager
 *  names that has no Data folder refuses to fall through: the user chose that folder. */
export function gameFolderResolver(setting: GameFolderSetting, detectors: GameDetectors = STEAM): GameFolderResolver {
  const settingPlace = `the game folder setting, ${setting.id}`;
  return async (managed: ManagerGamePath): Promise<GameFolder> => {
    const facts = autodetectFacts(managed.release);
    const at = (root: string): GameFolder => ({ kind: 'found', root, dataFolder: join(root, DATA_FOLDER) });
    const looked: GameFolderLook[] = [];
    const notFound = (): GameFolder => ({ kind: 'notFound', looked, setting: setting.id });

    const explicit = set(setting.value());
    if (explicit !== undefined) {
      if (await hasDataFolder(explicit)) return at(explicit);
      looked.push({ place: settingPlace, answer: `${explicit} has no Data folder` });
      return notFound();
    }
    looked.push({ place: settingPlace, answer: NOT_SET });

    const fromManager = await managerGamePath(managed, detectors);
    if ('found' in fromManager) return at(fromManager.found);
    looked.push(fromManager.look);
    if (!fromManager.fallThrough) return notFound();
    if (!facts) {
      looked.push({ place: STEAM_PLACE, answer: 'not asked: Modbench has no Steam entry for this game' });
      return notFound();
    }
    // Last, because a detection reads Steam's library file and runs `reg query` on Windows.
    const detected = await steamInstall(facts, detectors);
    if (detected) return detected;
    looked.push({ place: STEAM_PLACE, answer: 'the game is in no Steam library' });
    return notFound();
  };
}
