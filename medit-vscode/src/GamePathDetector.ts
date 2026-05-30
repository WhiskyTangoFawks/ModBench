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

export async function detectGamePaths(): Promise<GamePaths | null> {
  if (process.platform === 'win32') {
    return detectWindows();
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

async function detectWindows(): Promise<GamePaths | null> {
  try {
    const { stdout } = await execAsync(
      'reg query "HKCU\\Software\\Valve\\Steam" /v SteamPath'
    );
    const match = stdout.match(/SteamPath\s+REG_SZ\s+(.+)/);
    if (!match) return null;

    const steamPath = match[1].trim();
    const steamapps = path.join(steamPath, 'steamapps');
    const dataFolder = path.join(steamapps, 'common', 'Fallout 4', 'Data');
    const pluginsTxt = path.join(
      process.env['LOCALAPPDATA'] ?? '',
      'Fallout4', 'Plugins.txt'
    );

    await fs.access(dataFolder);
    return { dataFolder, pluginsTxt };
  } catch {
    return null;
  }
}
