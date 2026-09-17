import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'node:fs/promises';

vi.mock('node:fs/promises');

import { detectGamePaths, detectWindowsGamePaths, detectWinePrefix, parseLibraryFoldersVdf, parseRegQuerySteamPath, type GameAutodetect } from '../gamePathDetector';

// A fixture, not a platform lock (CLAUDE.md): the real facts come from gamePaths.ts and
// loadOrderDestination.ts; this module takes them as data and names no game itself.
const FO4_APP_ID = '377160';
const FO4: GameAutodetect = {
  steamAppId: FO4_APP_ID,
  steamFolderName: 'Fallout 4',
  loadOrderAppDataFolder: 'Fallout4',
};

const VDF_WITH_FO4 = `
"libraryfolders"
{
  "1"
  {
    "path"    "/mnt/games/steam"
    "apps"
    {
      "${FO4_APP_ID}"    "12345"
      "220"    "67890"
    }
  }
}
`;

const VDF_WITHOUT_FO4 = `
"libraryfolders"
{
  "1"
  {
    "path"    "/mnt/games/steam"
    "apps"
    {
      "220"    "67890"
    }
  }
}
`;

describe('parseLibraryFoldersVdf', () => {
  it('returns library path when the app id is present', () => {
    const result = parseLibraryFoldersVdf(VDF_WITH_FO4, FO4_APP_ID);
    expect(result).toBe('/mnt/games/steam');
  });

  it('returns null when the app id is absent', () => {
    const result = parseLibraryFoldersVdf(VDF_WITHOUT_FO4, FO4_APP_ID);
    expect(result).toBeNull();
  });

  it('handles multiple libraries and returns the one containing the app id', () => {
    const vdf = `
"libraryfolders"
{
  "1"
  {
    "path"    "/default/steam"
    "apps"
    {
      "220"    "1"
    }
  }
  "2"
  {
    "path"    "/mnt/games/steam"
    "apps"
    {
      "${FO4_APP_ID}"    "2"
    }
  }
}
`;
    expect(parseLibraryFoldersVdf(vdf, FO4_APP_ID)).toBe('/mnt/games/steam');
  });
});

describe('detectGamePaths (Linux)', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('returns correct paths when the library is found', async () => {
    vi.mocked(fs.readFile).mockResolvedValue(VDF_WITH_FO4);
    vi.mocked(fs.access).mockResolvedValue(undefined);

    const result = await detectGamePaths('linux', FO4);
    if (result === null) throw new Error('detectGamePaths found the library, so it should not return null');

    expect(result.dataFolder).toBe('/mnt/games/steam/steamapps/common/Fallout 4/Data');
    expect(result.pluginsTxt).toContain('Fallout4/Plugins.txt');
    expect(result.pluginsTxt).toContain('/mnt/games/steam/steamapps/compatdata');
  });

  it('returns null when the VDF cannot be read', async () => {
    vi.mocked(fs.readFile).mockRejectedValue(new Error('ENOENT'));

    const result = await detectGamePaths('linux', FO4);
    expect(result).toBeNull();
  });
});

// The Proton prefix root, factored out of `detectLinux` so gameDirectory.ts's Wine drive-letter
// translation reuses the library lookup instead of re-deriving it.
describe('detectWinePrefix', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('returns the compatdata pfx root when the library is found', async () => {
    vi.mocked(fs.readFile).mockResolvedValue(VDF_WITH_FO4);

    const result = await detectWinePrefix(FO4_APP_ID);

    expect(result).toBe('/mnt/games/steam/steamapps/compatdata/377160/pfx');
  });

  it('returns null when the VDF cannot be read', async () => {
    vi.mocked(fs.readFile).mockRejectedValue(new Error('ENOENT'));

    const result = await detectWinePrefix(FO4_APP_ID);

    expect(result).toBeNull();
  });

  it('returns null when the VDF has no matching library', async () => {
    vi.mocked(fs.readFile).mockResolvedValue(VDF_WITHOUT_FO4);

    const result = await detectWinePrefix(FO4_APP_ID);

    expect(result).toBeNull();
  });
});

describe('parseRegQuerySteamPath', () => {
  it('extracts the SteamPath value from reg query output', () => {
    const stdout =
      'HKEY_CURRENT_USER\\Software\\Valve\\Steam\r\n' +
      '    SteamPath    REG_SZ    C:/Program Files (x86)/Steam\r\n' +
      '\r\n';

    expect(parseRegQuerySteamPath(stdout)).toBe('C:/Program Files (x86)/Steam');
  });

  it('returns null when the output has no SteamPath value', () => {
    const stdout = 'ERROR: The system was unable to find the specified registry key or value.\r\n';

    expect(parseRegQuerySteamPath(stdout)).toBeNull();
  });
});

describe('detectWindowsGamePaths', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('maps a known reg query SteamPath and LOCALAPPDATA to GamePaths', async () => {
    vi.mocked(fs.access).mockResolvedValue(undefined);
    const runRegQuery = () =>
      Promise.resolve(
        'HKEY_CURRENT_USER\\Software\\Valve\\Steam\r\n' +
          '    SteamPath    REG_SZ    C:/Program Files (x86)/Steam\r\n',
      );

    const result = await detectWindowsGamePaths(runRegQuery, 'C:/Users/Wayne/AppData/Local', FO4);

    expect(result).toEqual({
      dataFolder: 'C:/Program Files (x86)/Steam/steamapps/common/Fallout 4/Data',
      pluginsTxt: 'C:/Users/Wayne/AppData/Local/Fallout4/Plugins.txt',
    });
  });

  it('returns null when the reg query output has no SteamPath match', async () => {
    const runRegQuery = () =>
      Promise.resolve('ERROR: The system was unable to find the specified registry key or value.\r\n');

    const result = await detectWindowsGamePaths(runRegQuery, 'C:/Users/Wayne/AppData/Local', FO4);

    expect(result).toBeNull();
  });

  it('returns null when the registry query itself fails (no reg.exe, no Steam)', async () => {
    const runRegQuery = () => Promise.reject(new Error('ENOENT: reg'));

    const result = await detectWindowsGamePaths(runRegQuery, 'C:/Users/Wayne/AppData/Local', FO4);

    expect(result).toBeNull();
  });
});
