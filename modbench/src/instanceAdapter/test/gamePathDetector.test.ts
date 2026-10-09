import { describe, it, expect, vi, beforeEach } from 'vitest';
import { access, readFile } from 'node:fs/promises';

vi.mock('node:fs/promises');

import { detectGamePaths, detectWinePrefix, type GameAutodetect } from '../gamePathDetector';

const FO4_APP_ID = '377160';
const FALLOUT4_STEAM_FACTS_AS_A_FIXTURE_NEVER_A_PLATFORM_LOCK: GameAutodetect = { steamAppId: FO4_APP_ID, steamFolderName: 'Fallout 4' };

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

describe('detectGamePaths (Linux)', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('returns the Data folder under the library holding the app', async () => {
    vi.mocked(readFile).mockResolvedValue(VDF_WITH_FO4);
    vi.mocked(access).mockResolvedValue(undefined);

    const result = await detectGamePaths('linux', FALLOUT4_STEAM_FACTS_AS_A_FIXTURE_NEVER_A_PLATFORM_LOCK, () => Promise.reject(new Error('Linux has no registry')));

    expect(result).toEqual({ dataFolder: '/mnt/games/steam/steamapps/common/Fallout 4/Data' });
  });

  it('returns null when the VDF cannot be read', async () => {
    vi.mocked(readFile).mockRejectedValue(new Error('ENOENT'));

    const result = await detectGamePaths('linux', FALLOUT4_STEAM_FACTS_AS_A_FIXTURE_NEVER_A_PLATFORM_LOCK, () => Promise.reject(new Error('Linux has no registry')));
    expect(result).toBeNull();
  });
});

describe('detectWinePrefix, the Proton prefix root for gameDirectory.ts\'s Wine translation found by reading Steam\'s library folders file', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('returns the compatdata pfx root when the library is found', async () => {
    vi.mocked(readFile).mockResolvedValue(VDF_WITH_FO4);

    const result = await detectWinePrefix(FO4_APP_ID);

    expect(result).toBe('/mnt/games/steam/steamapps/compatdata/377160/pfx');
  });

  it('returns null when the VDF cannot be read', async () => {
    vi.mocked(readFile).mockRejectedValue(new Error('ENOENT'));

    const result = await detectWinePrefix(FO4_APP_ID);

    expect(result).toBeNull();
  });

  it('returns null when the VDF has no matching library', async () => {
    vi.mocked(readFile).mockResolvedValue(VDF_WITHOUT_FO4);

    const result = await detectWinePrefix(FO4_APP_ID);

    expect(result).toBeNull();
  });

  it('handles multiple libraries and returns the one containing the app id', async () => {
    vi.mocked(readFile).mockResolvedValue(`
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
`);

    const result = await detectWinePrefix(FO4_APP_ID);

    expect(result).toBe('/mnt/games/steam/steamapps/compatdata/377160/pfx');
  });
});

describe('detectGamePaths (Windows)', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('maps a known reg query SteamPath to the Data folder under it', async () => {
    vi.mocked(access).mockResolvedValue(undefined);
    const runRegQuery = () =>
      Promise.resolve(
        'HKEY_CURRENT_USER\\Software\\Valve\\Steam\r\n' +
          '    SteamPath    REG_SZ    C:/Program Files (x86)/Steam\r\n',
      );

    const result = await detectGamePaths('win32', FALLOUT4_STEAM_FACTS_AS_A_FIXTURE_NEVER_A_PLATFORM_LOCK, runRegQuery);

    expect(result).toEqual({ dataFolder: 'C:/Program Files (x86)/Steam/steamapps/common/Fallout 4/Data' });
  });

  it('returns null when the reg query output has no SteamPath match', async () => {
    const runRegQuery = () =>
      Promise.resolve('ERROR: The system was unable to find the specified registry key or value.\r\n');

    const result = await detectGamePaths('win32', FALLOUT4_STEAM_FACTS_AS_A_FIXTURE_NEVER_A_PLATFORM_LOCK, runRegQuery);

    expect(result).toBeNull();
  });

  it('returns null when the registry query itself fails (no reg.exe, no Steam)', async () => {
    const runRegQuery = () => Promise.reject(new Error('ENOENT: reg'));

    const result = await detectGamePaths('win32', FALLOUT4_STEAM_FACTS_AS_A_FIXTURE_NEVER_A_PLATFORM_LOCK, runRegQuery);

    expect(result).toBeNull();
  });
});

describe('detectGamePaths (Windows) in a second Steam library', () => {
  const runRegQuery = () => Promise.resolve('    SteamPath    REG_SZ    C:/Steam\r\n');
  const vdfNaming = (library: string) => `"libraryfolders"
{
  "0"
  {
    "path"    "C:\\\\Steam"
    "apps"
    {
      "220"    "1"
    }
  }
  "1"
  {
    "path"    "${library}"
    "apps"
    {
      "${FO4_APP_ID}"    "2"
    }
  }
}
`;

  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(access).mockResolvedValue(undefined);
  });

  it('finds the game in the library the steamapps vdf names', async () => {
    vi.mocked(readFile).mockImplementation((file) =>
      typeof file === 'string' && file.endsWith('steamapps/libraryfolders.vdf')
        ? Promise.resolve(vdfNaming('D:/Games/SteamLibrary'))
        : Promise.reject(new Error('ENOENT')),
    );

    const result = await detectGamePaths('win32', FALLOUT4_STEAM_FACTS_AS_A_FIXTURE_NEVER_A_PLATFORM_LOCK, runRegQuery);

    expect(result).toEqual({ dataFolder: 'D:/Games/SteamLibrary/steamapps/common/Fallout 4/Data' });
  });

  it('finds the game through the older config vdf layout', async () => {
    vi.mocked(readFile).mockImplementation((file) =>
      typeof file === 'string' && file.endsWith('config/libraryfolders.vdf')
        ? Promise.resolve(vdfNaming('D:/Games/SteamLibrary'))
        : Promise.reject(new Error('ENOENT')),
    );

    const result = await detectGamePaths('win32', FALLOUT4_STEAM_FACTS_AS_A_FIXTURE_NEVER_A_PLATFORM_LOCK, runRegQuery);

    expect(result).toEqual({ dataFolder: 'D:/Games/SteamLibrary/steamapps/common/Fallout 4/Data' });
  });

  it('reads a library path in the real Windows form, backslashes escaped in the vdf', async () => {
    vi.mocked(readFile).mockImplementation((file) =>
      typeof file === 'string' && file.endsWith('steamapps/libraryfolders.vdf')
        ? Promise.resolve(vdfNaming('D:\\\\Games\\\\SteamLibrary'))
        : Promise.reject(new Error('ENOENT')),
    );

    const result = await detectGamePaths('win32', FALLOUT4_STEAM_FACTS_AS_A_FIXTURE_NEVER_A_PLATFORM_LOCK, runRegQuery);

    expect(result).toEqual({ dataFolder: 'D:\\Games\\SteamLibrary/steamapps/common/Fallout 4/Data' });
  });
});
