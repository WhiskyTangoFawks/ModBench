import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'node:fs/promises';

vi.mock('node:fs/promises');
vi.mock('node:child_process');

import { detectGamePaths, parseLibraryFoldersVdf } from '../GamePathDetector';

const FO4_APP_ID = '377160';

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
  it('returns library path when FO4 AppID present', () => {
    const result = parseLibraryFoldersVdf(VDF_WITH_FO4);
    expect(result).toBe('/mnt/games/steam');
  });

  it('returns null when FO4 AppID absent', () => {
    const result = parseLibraryFoldersVdf(VDF_WITHOUT_FO4);
    expect(result).toBeNull();
  });

  it('handles multiple libraries and returns the one containing FO4', () => {
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
    expect(parseLibraryFoldersVdf(vdf)).toBe('/mnt/games/steam');
  });
});

describe('detectGamePaths (Linux)', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('returns correct paths when FO4 library found', async () => {
    vi.mocked(fs.readFile).mockResolvedValue(VDF_WITH_FO4);
    vi.mocked(fs.access).mockResolvedValue(undefined);

    const result = await detectGamePaths();

    expect(result).not.toBeNull();
    expect(result!.dataFolder).toBe('/mnt/games/steam/steamapps/common/Fallout 4/Data');
    expect(result!.pluginsTxt).toContain('Fallout4/Plugins.txt');
    expect(result!.pluginsTxt).toContain('/mnt/games/steam/steamapps/compatdata');
  });

  it('returns null when VDF cannot be read', async () => {
    vi.mocked(fs.readFile).mockRejectedValue(new Error('ENOENT'));

    const result = await detectGamePaths();
    expect(result).toBeNull();
  });
});
