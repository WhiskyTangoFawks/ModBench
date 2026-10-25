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

const NO_REGISTRY = () => Promise.reject(new Error('Linux has no registry'));

describe('the game\'s Data folder Steam names on Linux', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('is under the library holding the app', async () => {
    vi.mocked(readFile).mockResolvedValue(VDF_WITH_FO4);
    vi.mocked(access).mockResolvedValue(undefined);

    const result = await detectGamePaths('linux', FALLOUT4_STEAM_FACTS_AS_A_FIXTURE_NEVER_A_PLATFORM_LOCK, NO_REGISTRY);

    expect(result).toEqual({ dataFolder: '/mnt/games/steam/steamapps/common/Fallout 4/Data' });
  });

  it('is not found when the VDF cannot be read', async () => {
    vi.mocked(readFile).mockRejectedValue(new Error('ENOENT'));

    expect(await detectGamePaths('linux', FALLOUT4_STEAM_FACTS_AS_A_FIXTURE_NEVER_A_PLATFORM_LOCK, NO_REGISTRY)).toBeNull();
  });
});

describe('the Proton prefix root for gameFolderResolver\'s Wine translation, found by reading Steam\'s library folders file', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('is the compatdata pfx root of the library holding the app', async () => {
    vi.mocked(readFile).mockResolvedValue(VDF_WITH_FO4);

    expect(await detectWinePrefix(FO4_APP_ID)).toBe('/mnt/games/steam/steamapps/compatdata/377160/pfx');
  });

  it.each([
    ['the VDF cannot be read', () => vi.mocked(readFile).mockRejectedValue(new Error('ENOENT'))],
    ['the VDF has no library holding the app', () => vi.mocked(readFile).mockResolvedValue(VDF_WITHOUT_FO4)],
  ])('is not found when %s', async (_, arrange) => {
    arrange();

    expect(await detectWinePrefix(FO4_APP_ID)).toBeNull();
  });

  it('is in the one of several libraries that holds the app', async () => {
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

    expect(await detectWinePrefix(FO4_APP_ID)).toBe('/mnt/games/steam/steamapps/compatdata/377160/pfx');
  });
});

describe('the game\'s Data folder Steam names on Windows', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('is under the SteamPath the registry names', async () => {
    vi.mocked(access).mockResolvedValue(undefined);
    const runRegQuery = () =>
      Promise.resolve(
        'HKEY_CURRENT_USER\\Software\\Valve\\Steam\r\n' +
          '    SteamPath    REG_SZ    C:/Program Files (x86)/Steam\r\n',
      );

    const result = await detectGamePaths('win32', FALLOUT4_STEAM_FACTS_AS_A_FIXTURE_NEVER_A_PLATFORM_LOCK, runRegQuery);

    expect(result).toEqual({ dataFolder: 'C:\\Program Files (x86)\\Steam\\steamapps\\common\\Fallout 4\\Data' });
  });

  it.each([
    ['the registry names no SteamPath', () => Promise.resolve('ERROR: The system was unable to find the specified registry key or value.\r\n')],
    ['the registry query itself fails (no reg.exe, no Steam)', () => Promise.reject(new Error('ENOENT: reg'))],
  ])('is not found when %s', async (_, runRegQuery) => {
    expect(await detectGamePaths('win32', FALLOUT4_STEAM_FACTS_AS_A_FIXTURE_NEVER_A_PLATFORM_LOCK, runRegQuery)).toBeNull();
  });
});

describe('the game\'s Data folder on Windows in a second Steam library', () => {
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
  const vdfOnlyAt = (ending: string, library: string) => (file: unknown) =>
    (typeof file === 'string' && file.endsWith(ending) ? Promise.resolve(vdfNaming(library)) : Promise.reject(new Error('ENOENT')));

  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(access).mockResolvedValue(undefined);
  });

  it.each([
    ['the steamapps vdf names', 'steamapps\\libraryfolders.vdf', 'D:/Games/SteamLibrary'],
    ['the older config vdf layout names', 'config\\libraryfolders.vdf', 'D:/Games/SteamLibrary'],
    ['the vdf names in the real Windows form, backslashes escaped', 'steamapps\\libraryfolders.vdf', 'D:\\\\Games\\\\SteamLibrary'],
  ])('is in the library %s', async (_, ending, library) => {
    vi.mocked(readFile).mockImplementation(vdfOnlyAt(ending, library));

    const result = await detectGamePaths('win32', FALLOUT4_STEAM_FACTS_AS_A_FIXTURE_NEVER_A_PLATFORM_LOCK, runRegQuery);

    expect(result).toEqual({ dataFolder: 'D:\\Games\\SteamLibrary\\steamapps\\common\\Fallout 4\\Data' });
  });
});
