import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';

const execAsync = promisify(exec);

export interface GamePaths {
  dataFolder: string;
  pluginsTxt: string;
}

/** The per-release facts autodetection needs, already looked up from the two tables
 *  (`tables/gamePaths.ts`, `tables/loadOrderDestination.ts`) — this module names
 *  no game itself. */
export interface GameAutodetect {
  steamAppId: string;
  steamFolderName: string;
  loadOrderAppDataFolder: string;
}

// Parses Valve's VDF format just enough to find a library path that contains a given AppID.
function parseLibraryFoldersVdf(content: string, appId: string): string | null {
  // A library block reads:  "path"  "/some/path"  ...  "appid"  "value"
  const libraryBlocks = content.split(/"\d+"\s*\{/);
  for (const block of libraryBlocks) {
    if (!block.includes(`"${appId}"`)) continue;
    const path = block.match(/"path"\s+"([^"]+)"/)?.[1];
    if (path !== undefined) return path;
  }
  return null;
}

/** Takes `platform` explicitly (rather than reading `process.platform` itself) so tests can
 *  exercise both branches directly instead of stubbing global process state. */
export async function detectGamePaths(platform: NodeJS.Platform, game: GameAutodetect): Promise<GamePaths | null> {
  if (platform === 'win32') {
    return detectWindowsGamePaths(
      () => execAsync('reg query "HKCU\\Software\\Valve\\Steam" /v SteamPath').then((r) => r.stdout),
      process.env['LOCALAPPDATA'],
      game,
    );
  }
  return detectLinux(game);
}

async function findSteamLibrary(steamAppId: string): Promise<string | null> {
  const vdfPath = path.join(os.homedir(), '.steam', 'steam', 'config', 'libraryfolders.vdf');
  try {
    return parseLibraryFoldersVdf(await fs.readFile(vdfPath, 'utf-8'), steamAppId);
  } catch {
    return null;
  }
}

async function detectLinux(game: GameAutodetect): Promise<GamePaths | null> {
  const library = await findSteamLibrary(game.steamAppId);
  if (!library) return null;
  try {
    const steamapps = path.join(library, 'steamapps');
    const dataFolder = path.join(steamapps, 'common', game.steamFolderName, 'Data');
    const pluginsTxt = path.join(
      steamapps, 'compatdata', game.steamAppId, 'pfx',
      'drive_c', 'users', 'steamuser', 'AppData', 'Local', game.loadOrderAppDataFolder, 'Plugins.txt'
    );

    await fs.access(dataFolder);
    return { dataFolder, pluginsTxt };
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

export function parseRegQuerySteamPath(stdout: string): string | null {
  const path = stdout.match(/SteamPath\s+REG_SZ\s+(.+)/)?.[1];
  return path !== undefined ? path.trim() : null;
}

/** Exported and injected purely as a test seam: `vi.mock`'s automock of `node:child_process`
 *  drops `promisify.custom`, which changes what `promisify(exec)` resolves to and breaks the
 *  `{ stdout }` shape this relies on. */
export async function detectWindowsGamePaths(
  runRegQuery: () => Promise<string>,
  localAppData: string | undefined,
  game: GameAutodetect,
): Promise<GamePaths | null> {
  try {
    const stdout = await runRegQuery();
    const steamPath = parseRegQuerySteamPath(stdout);
    if (!steamPath) return null;

    const steamapps = path.join(steamPath, 'steamapps');
    const dataFolder = path.join(steamapps, 'common', game.steamFolderName, 'Data');
    const pluginsTxt = path.join(localAppData ?? '', game.loadOrderAppDataFolder, 'Plugins.txt');

    await fs.access(dataFolder);
    return { dataFolder, pluginsTxt };
  } catch {
    return null;
  }
}
