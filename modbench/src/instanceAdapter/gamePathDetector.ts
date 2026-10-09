import { access, readFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

export interface GamePaths {
  dataFolder: string;
}

/** The per-release facts autodetection needs, already looked up from `tables/gamePaths.ts` —
 *  this module names no game itself. */
export interface GameAutodetect {
  steamAppId: string;
  steamFolderName: string;
}

// Parses Valve's VDF format just enough to find a library path that contains a given AppID.
function parseLibraryFoldersVdf(content: string, appId: string): string | null {
  // A library block reads:  "path"  "/some/path"  ...  "appid"  "value"
  const libraryBlocks = content.split(/"\d+"\s*\{/);
  for (const block of libraryBlocks) {
    if (!block.includes(`"${appId}"`)) continue;
    const path = block.match(/"path"\s+"([^"]+)"/)?.[1];
    if (path !== undefined) return path.replaceAll('\\\\', '\\');
  }
  return null;
}

/** Takes `platform` explicitly (rather than reading `process.platform` itself) so tests can
 *  exercise both branches directly instead of stubbing global process state. */
export async function detectGamePaths(
  platform: NodeJS.Platform,
  game: GameAutodetect,
  runRegQuery: () => Promise<string>,
): Promise<GamePaths | null> {
  return platform === 'win32' ? detectWindows(runRegQuery, game) : detectLinux(game);
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
    path.join(steamPath, 'steamapps', 'libraryfolders.vdf'),
    path.join(steamPath, 'config', 'libraryfolders.vdf'),
  ];
}

function findSteamLibrary(steamAppId: string): Promise<string | null> {
  return findLibraryInVdfs([path.join(os.homedir(), '.steam', 'steam', 'config', 'libraryfolders.vdf')], steamAppId);
}

async function detectLinux(game: GameAutodetect): Promise<GamePaths | null> {
  const library = await findSteamLibrary(game.steamAppId);
  if (!library) return null;
  try {
    const dataFolder = path.join(library, 'steamapps', 'common', game.steamFolderName, 'Data');
    await access(dataFolder);
    return { dataFolder };
  } catch {
    return null;
  }
}

/** The Proton prefix root (`steamapps/compatdata/<appid>/pfx`) for the release's Steam library,
 *  so Wine drive-letter translation does not re-derive it. */
export async function detectWinePrefix(steamAppId: string): Promise<string | null> {
  const library = await findSteamLibrary(steamAppId);
  return library ? path.join(library, 'steamapps', 'compatdata', steamAppId, 'pfx') : null;
}

function parseRegQuerySteamPath(stdout: string): string | null {
  const path = stdout.match(/SteamPath\s+REG_SZ\s+(.+)/)?.[1];
  return path !== undefined ? path.trim() : null;
}

async function detectWindows(
  runRegQuery: () => Promise<string>,
  game: GameAutodetect,
): Promise<GamePaths | null> {
  try {
    const stdout = await runRegQuery();
    const steamPath = parseRegQuerySteamPath(stdout);
    if (!steamPath) return null;

    const library = (await findLibraryInVdfs(windowsVdfPaths(steamPath), game.steamAppId)) ?? steamPath;
    const dataFolder = path.join(library, 'steamapps', 'common', game.steamFolderName, 'Data');
    await access(dataFolder);
    return { dataFolder };
  } catch {
    return null;
  }
}
