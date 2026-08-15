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

const FO4_APP_ID = '377160';

// Parses Valve's VDF format just enough to find a library path that contains a given AppID.
export function parseLibraryFoldersVdf(content: string): string | null {
  // Each library block looks like:  "path"  "/some/path"  ...  "appid"  "value"
  // We split by library entry and look for one containing FO4_APP_ID.
  const libraryBlocks = content.split(/"\d+"\s*\{/);
  for (const block of libraryBlocks) {
    if (!block.includes(`"${FO4_APP_ID}"`)) continue;
    const match = block.match(/"path"\s+"([^"]+)"/);
    if (match) return match[1];
  }
  return null;
}

/** Takes `platform` explicitly (rather than reading `process.platform` itself) so tests can
 *  exercise both branches directly instead of stubbing global process state. */
export async function detectGamePaths(platform: NodeJS.Platform): Promise<GamePaths | null> {
  if (platform === 'win32') {
    return detectWindowsGamePaths(
      () => execAsync('reg query "HKCU\\Software\\Valve\\Steam" /v SteamPath').then((r) => r.stdout),
      process.env['LOCALAPPDATA'],
    );
  }
  return detectLinux();
}

async function detectLinux(): Promise<GamePaths | null> {
  const vdfPath = path.join(os.homedir(), '.steam', 'steam', 'config', 'libraryfolders.vdf');
  try {
    const content = await fs.readFile(vdfPath, 'utf-8');
    const library = parseLibraryFoldersVdf(content);
    if (!library) return null;

    const steamapps = path.join(library, 'steamapps');
    const dataFolder = path.join(steamapps, 'common', 'Fallout 4', 'Data');
    const pluginsTxt = path.join(
      steamapps, 'compatdata', FO4_APP_ID, 'pfx',
      'drive_c', 'users', 'steamuser', 'AppData', 'Local', 'Fallout4', 'Plugins.txt'
    );

    await fs.access(dataFolder);
    return { dataFolder, pluginsTxt };
  } catch {
    return null;
  }
}

// Parses `reg query "HKCU\Software\Valve\Steam" /v SteamPath` output for the SteamPath value.
export function parseRegQuerySteamPath(stdout: string): string | null {
  const match = stdout.match(/SteamPath\s+REG_SZ\s+(.+)/);
  return match ? match[1].trim() : null;
}

/** Exported (rather than kept private like `detectLinux`) purely as a test seam: `execAsync` is
 *  `promisify(exec)`, and `vi.mock`'s automock of `node:child_process` drops `promisify.custom`,
 *  which changes what `execAsync` resolves to and breaks the `{ stdout }` shape this function
 *  relies on. Injecting `runRegQuery`/`localAppData` lets a test pin the registry-output mapping
 *  directly instead of trying to mock the promisified call. */
export async function detectWindowsGamePaths(
  runRegQuery: () => Promise<string>,
  localAppData: string | undefined,
): Promise<GamePaths | null> {
  try {
    const stdout = await runRegQuery();
    const steamPath = parseRegQuerySteamPath(stdout);
    if (!steamPath) return null;

    const steamapps = path.join(steamPath, 'steamapps');
    const dataFolder = path.join(steamapps, 'common', 'Fallout 4', 'Data');
    const pluginsTxt = path.join(localAppData ?? '', 'Fallout4', 'Plugins.txt');

    await fs.access(dataFolder);
    return { dataFolder, pluginsTxt };
  } catch {
    return null;
  }
}
