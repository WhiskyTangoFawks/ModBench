import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { readOrAbsent } from '../files';
import type { Machine } from '../instanceAdapter';

export interface GamePaths {
  dataFolder: string;
}

/** The per-release facts autodetection needs, already looked up from `tables/gamePaths.ts` —
 *  this module names no game itself. */
export interface GameAutodetect {
  steamAppId: string;
  steamFolderName: string;
}

// Parses Valve's VDF format just enough to find the libraries, and the library that contains a given AppID.
function libraryEntries(content: string): { path: string; block: string }[] {
  // A library block reads:  "path"  "/some/path"  ...  "appid"  "value"
  return content.split(/"\d+"\s*\{/).flatMap((block) => {
    const path = block.match(/"path"\s+"([^"]+)"/)?.[1];
    return path === undefined ? [] : [{ path: path.replaceAll('\\\\', '\\'), block }];
  });
}

const parseLibraryFoldersVdf = (content: string, appId: string): string | null =>
  libraryEntries(content).find(({ block }) => block.includes(`"${appId}"`))?.path ?? null;

export async function detectGamePaths(machine: Machine, game: GameAutodetect): Promise<GamePaths | null> {
  return machine.platform === 'win32' ? detectWindows(machine, game) : detectLinux(machine, game);
}

async function findLibraryInVdfs(vdfPaths: string[], steamAppId: string): Promise<string | null> {
  for (const vdfPath of vdfPaths) {
    try {
      const library = parseLibraryFoldersVdf(await readFile(vdfPath, 'utf-8'), steamAppId);
      if (library !== null) return library;
    } catch {
      continue;
    }
  }
  return null;
}

function windowsVdfPaths(steamPath: string): string[] {
  return [
    join(steamPath, 'steamapps', 'libraryfolders.vdf'),
    join(steamPath, 'config', 'libraryfolders.vdf'),
  ];
}

const linuxSteamRoot = ({ homeFolder }: Machine): string => join(homeFolder, '.steam', 'steam');

/** Where Steam is on `machine`, when Modbench looks for its prefixes there. */
export const steamRootOn = (machine: Machine): string | undefined => (machine.platform === 'linux' ? linuxSteamRoot(machine) : undefined);

/** Steam's root, then every other library its libraryfolders.vdf names. A libraryfolders.vdf that cannot be read rejects. */
export async function steamLibraries(steamRoot: string): Promise<string[]> {
  const content = await readOrAbsent(() => readFile(join(steamRoot, 'config', 'libraryfolders.vdf'), 'utf-8'), '');
  return [...new Set([steamRoot, ...libraryEntries(content).map(({ path }) => path)])];
}

function findSteamLibrary(machine: Machine, steamAppId: string): Promise<string | null> {
  return findLibraryInVdfs([join(linuxSteamRoot(machine), 'config', 'libraryfolders.vdf')], steamAppId);
}

async function detectLinux(machine: Machine, game: GameAutodetect): Promise<GamePaths | null> {
  const library = await findSteamLibrary(machine, game.steamAppId);
  if (!library) return null;
  try {
    const dataFolder = join(library, 'steamapps', 'common', game.steamFolderName, 'Data');
    await access(dataFolder);
    return { dataFolder };
  } catch {
    return null;
  }
}

/** The Proton prefix root (`steamapps/compatdata/<appid>/pfx`) for the release's Steam library,
 *  so Wine drive-letter translation does not re-derive it. */
export async function detectWinePrefix(machine: Machine, steamAppId: string): Promise<string | null> {
  const library = await findSteamLibrary(machine, steamAppId);
  return library ? join(library, 'steamapps', 'compatdata', steamAppId, 'pfx') : null;
}

const STEAM_KEY = 'HKCU\\Software\\Valve\\Steam';

async function detectWindows(machine: Machine, game: GameAutodetect): Promise<GamePaths | null> {
  try {
    const steamPath = await machine.registryValue(STEAM_KEY, 'SteamPath');
    if (!steamPath) return null;

    const library = (await findLibraryInVdfs(windowsVdfPaths(steamPath), game.steamAppId)) ?? steamPath;
    const dataFolder = join(library, 'steamapps', 'common', game.steamFolderName, 'Data');
    await access(dataFolder);
    return { dataFolder };
  } catch {
    return null;
  }
}
