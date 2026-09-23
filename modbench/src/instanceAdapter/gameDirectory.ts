// Where the game is: the instance's own ini first, then Steam and Wine detection. The user's
// overrides arrive from the composition root as values; nothing here reads a setting itself.

import { dirname, join } from 'node:path';
import { readGameName, readGamePath } from '../mo2Codecs/modOrganizerIni';
import { gamePathInfoForRelease, gameReleaseForGame } from '../tables/gamePaths';
import { detectGamePaths, detectWinePrefix, type GameAutodetect, type GamePaths } from './gamePathDetector';
import { factsOf } from './files';
import { present } from '../ports/present';

export interface GameDirectory {
  /** Folder containing the game executable and Data/. */
  root: string;
  dataFolder: string;
}

/** What the user set, read fresh on each resolve by whoever built the resolver. */
export interface GameDirectoryOverrides {
  /** The game folder outright (`modbench.mods.gameDirectory`). */
  gameDirectory?: string;
}

/** Answers where the game is for one generation of ModOrganizer.ini's text — the Instance's own
 *  read, so a resolution can never come from a different generation than the value it lands in.
 *  `undefined` when nothing resolves. */
export type GameDirectoryResolver = (iniText: string) => Promise<GameDirectory | undefined>;

/** The Proton prefix root (`.../compatdata/<appid>/pfx`), or null if undeterminable. */
export type DetectWinePrefix = () => Promise<string | null>;

/** What Steam is asked, injectable so both fallbacks are testable without a Steam install. */
export interface GameDetectors {
  paths: (game: GameAutodetect) => Promise<GamePaths | null>;
  winePrefix: (steamAppId: string) => Promise<string | null>;
}

const STEAM: GameDetectors = {
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

// A setting left at its empty default is not set: every branch below reads absence as undefined.
function set(value: string | undefined): string | undefined {
  const trimmed = (value ?? '').trim();
  return trimmed === '' ? undefined : trimmed;
}

// Only the ini's own read/parse is tolerated as "not found"; a translation failure must propagate.
async function iniGamePath(
  iniText: string, facts: GameAutodetect | undefined, detectors: GameDetectors,
): Promise<string | null> {
  let raw: string;
  try {
    raw = readGamePath(iniText);
  } catch {
    return null;
  }
  const prefix: DetectWinePrefix = () => (facts ? detectors.winePrefix(facts.steamAppId) : Promise.resolve(null));
  return normalizeGamePath(raw, process.platform, prefix);
}

/** Explicit setting, then MO2's `gamePath`, then autodetect. A translation failure rejects
 *  rather than falling through to autodetect, because resolving a different game directory
 *  entirely would hide the real problem. */
export function gameDirectoryResolver(
  overridesOf: () => GameDirectoryOverrides, detectors: GameDetectors = STEAM,
): GameDirectoryResolver {
  return async (iniText: string): Promise<GameDirectory | undefined> => {
    const facts = autodetectFacts(iniText);
    const at = (root: string): GameDirectory => ({ root, dataFolder: join(root, 'Data') });

    const explicit = set(overridesOf().gameDirectory);
    if (explicit !== undefined) {
      if (!(await hasDataFolder(explicit))) {
        throw new Error(`modbench.mods.gameDirectory has no Data/ subfolder: ${explicit}`);
      }
      return at(explicit);
    }

    const fromIni = await iniGamePath(iniText, facts, detectors);
    if (fromIni && (await hasDataFolder(fromIni))) return at(fromIni);

    // Last, because a detection reads Steam's library file and runs `reg query` on Windows.
    const found = facts ? await detectors.paths(facts) : null;
    return found ? { root: dirname(found.dataFolder), dataFolder: found.dataFolder } : undefined;
  };
}
