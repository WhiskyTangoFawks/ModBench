import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  gameDirectoryResolver, normalizeGamePath, type GameDetectors,
} from '../gameDirectory';
import type { GameDirectoryOverrides } from '../instanceAdapter';

const noDetectPrefix = () => Promise.resolve(null);

const NO_DETECTORS: GameDetectors = {
  paths: () => Promise.resolve(null),
  winePrefix: () => Promise.resolve(null),
};

const iniOfTheCorpusGameSoTheTablesAnswerRealSteamFacts = (gamePath?: string): string =>
  `[General]\r\ngameName=Fallout 4\r\n${gamePath === undefined ? '' : `gamePath=@ByteArray(${gamePath})\r\n`}`;

const SETTING_PLACE = 'the game folder setting, modbench.mods.gameDirectory';
const GAME_PATH_PLACE = "ModOrganizer.ini's gamePath";
const STEAM_PLACE = 'the Steam install';

const resolverWith = (
  overrides: GameDirectoryOverrides = {}, detectors: GameDetectors = NO_DETECTORS,
) => gameDirectoryResolver(() => overrides, detectors);

describe('normalizeGamePath', () => {
  it('leaves a native Windows path untouched', async () => {
    expect(await normalizeGamePath('C:\\Games\\Fallout4', 'win32', noDetectPrefix)).toBe('C:\\Games\\Fallout4');
  });

  it('leaves a colon that is not a leading drive letter untouched (only the drive-letter prefix is stripped), a colon elsewhere in a path being legal on Linux — a folder named literally "A:B" — and an unanchored strip corrupting it', async () => {
    const path = '/home/user/mods/A:B/Fallout4';
    expect(await normalizeGamePath(path, 'linux', noDetectPrefix)).toBe(path);
  });

  it('maps a Z: drive path straight to the filesystem root, without consulting the prefix', async () => {
    let calledPrefix = false;
    const detectPrefix = () => {
      calledPrefix = true;
      return Promise.resolve(null);
    };

    const result = await normalizeGamePath('Z:\\home\\user\\Games\\Fallout4', 'linux', detectPrefix);

    expect(result).toBe('/home/user/Games/Fallout4');
    expect(calledPrefix).toBe(false);
  });

  it("maps a C: drive path inside the Proton prefix's drive_c", async () => {
    const prefix = '/home/user/.steam/steam/steamapps/compatdata/377160/pfx';
    const detectPrefix = () => Promise.resolve(prefix);

    const result = await normalizeGamePath('C:\\Games\\Fallout4', 'linux', detectPrefix);

    expect(result).toBe(join(prefix, 'drive_c', 'Games/Fallout4'));
  });

  it('surfaces (throws), rather than guesses, when a C: path\'s prefix cannot be determined', async () => {
    await expect(
      normalizeGamePath('C:\\Games\\Fallout4', 'linux', () => Promise.resolve(null)),
    ).rejects.toThrow(/prefix/i);
  });

  it('surfaces (throws) for a drive letter that is neither Z nor C, rather than silently stripping it to root', async () => {
    await expect(
      normalizeGamePath('D:\\Games\\Fallout4', 'linux', () => Promise.resolve('/some/prefix')),
    ).rejects.toThrow(/drive/i);
  });
});

describe('the game directory resolver', () => {
  const dirs: string[] = [];

  afterEach(async () => {
    for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
  });

  async function gameFolder(name = 'Stock Game Folder'): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'medit-gamedir-'));
    dirs.push(dir);
    const root = join(dir, name);
    await mkdir(join(root, 'Data'), { recursive: true });
    return root;
  }

  it('resolves an explicit modbench.mods.gameDirectory setting directly', async () => {
    const gameRoot = await gameFolder();

    const resolved = await resolverWith({ gameDirectory: gameRoot })(iniOfTheCorpusGameSoTheTablesAnswerRealSteamFacts());

    expect(resolved).toMatchObject({ root: gameRoot, dataFolder: join(gameRoot, 'Data') });
  });

  it('trims whitespace accidentally pasted around an explicit setting value', async () => {
    const gameRoot = await gameFolder();

    const resolved = await resolverWith({ gameDirectory: `  ${gameRoot}  ` })(iniOfTheCorpusGameSoTheTablesAnswerRealSteamFacts());

    expect(resolved).toMatchObject({ root: gameRoot, dataFolder: join(gameRoot, 'Data') });
  });

  it('reads a setting left at its empty default as unset, not as an empty path', async () => {
    const gameRoot = await gameFolder();

    const resolved = await resolverWith({ gameDirectory: '   ' })(iniOfTheCorpusGameSoTheTablesAnswerRealSteamFacts(gameRoot));

    expect(resolved).toMatchObject({ root: gameRoot });
  });

  it('answers not found, naming only the setting, when the explicit setting has no Data/ subfolder, not falling through to the ini gamePath, which would resolve a folder the user did not name', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'medit-gamedir-'));
    dirs.push(dir);
    const gameRoot = join(dir, 'Stock Game Folder');
    await mkdir(gameRoot, { recursive: true });
    const iniGameRoot = await gameFolder();

    const resolved = await resolverWith({ gameDirectory: gameRoot })(iniOfTheCorpusGameSoTheTablesAnswerRealSteamFacts(iniGameRoot));

    expect(resolved).toEqual({
      kind: 'notFound',
      setting: 'modbench.mods.gameDirectory',
      looked: [{ place: SETTING_PLACE, answer: `${gameRoot} has no Data folder` }],
    });
  });

  it('falls back to the ini gamePath of the text it was handed when the setting is unset', async () => {
    const gameRoot = await gameFolder();

    const resolved = await resolverWith()(iniOfTheCorpusGameSoTheTablesAnswerRealSteamFacts(gameRoot));

    expect(resolved).toMatchObject({ root: gameRoot, dataFolder: join(gameRoot, 'Data') });
  });

  it('normalizes a Z:-drive ini gamePath, as MO2 under Proton writes it, to its POSIX path', async () => {
    const gameRoot = await gameFolder();
    const winePath = 'Z:' + gameRoot.replaceAll('/', '\\');

    const resolved = await resolverWith()(iniOfTheCorpusGameSoTheTablesAnswerRealSteamFacts(winePath));

    expect(resolved).toMatchObject({ root: gameRoot, dataFolder: join(gameRoot, 'Data') });
  });

  it("normalizes a C: drive-mapped ini gamePath into the Proton prefix's drive_c", async () => {
    const prefixDir = await mkdtemp(join(tmpdir(), 'medit-prefix-'));
    dirs.push(prefixDir);
    const gameRoot = join(prefixDir, 'drive_c', 'Games', 'Fallout4');
    await mkdir(join(gameRoot, 'Data'), { recursive: true });
    const detectors: GameDetectors = { paths: () => Promise.resolve(null), winePrefix: () => Promise.resolve(prefixDir) };

    const resolved = await resolverWith({}, detectors)(iniOfTheCorpusGameSoTheTablesAnswerRealSteamFacts('C:\\Games\\Fallout4'));

    expect(resolved).toMatchObject({ root: gameRoot, dataFolder: join(gameRoot, 'Data') });
  });

  it('answers not found, with the reason, and does not answer with the detected folder when a C: ini path has no determinable prefix', async () => {
    const detectors: GameDetectors = {
      paths: () => Promise.resolve({ dataFolder: '/steam/Fallout 4/Data' }),
      winePrefix: () => Promise.resolve(null),
    };

    const resolved = await resolverWith({}, detectors)(iniOfTheCorpusGameSoTheTablesAnswerRealSteamFacts('C:\\Games\\Fallout4'));

    expect(resolved).toMatchObject({
      kind: 'notFound',
      looked: [
        { place: SETTING_PLACE, answer: 'not set' },
        { place: GAME_PATH_PLACE, answer: expect.stringMatching(/prefix could not be determined/) as unknown },
      ],
    });
  });

  it('falls back to Steam autodetection when the setting and the ini gamePath are both absent', async () => {
    const detectors: GameDetectors = {
      paths: () => Promise.resolve({ dataFolder: '/steam/Fallout 4/Data' }),
      winePrefix: noDetectPrefix,
    };

    const resolved = await resolverWith({}, detectors)(iniOfTheCorpusGameSoTheTablesAnswerRealSteamFacts());

    expect(resolved).toEqual({ kind: 'found', root: '/steam/Fallout 4', dataFolder: '/steam/Fallout 4/Data' });
  });

  it('answers not found, naming each place looked, when nothing resolves — setting unset, no gamePath, autodetect finds nothing', async () => {
    expect(await resolverWith()(iniOfTheCorpusGameSoTheTablesAnswerRealSteamFacts())).toEqual({
      kind: 'notFound',
      setting: 'modbench.mods.gameDirectory',
      looked: [
        { place: SETTING_PLACE, answer: 'not set' },
        { place: GAME_PATH_PLACE, answer: 'not set' },
        { place: STEAM_PLACE, answer: 'the game is in no Steam library' },
      ],
    });
  });

  it('refuses, naming the folder, when the ini names a game folder with no Data/, rather than falling through to a Steam install', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'medit-gamedir-'));
    dirs.push(dir);
    const staleGameRoot = join(dir, 'Stale Game Folder');
    await mkdir(staleGameRoot, { recursive: true });
    const detectors: GameDetectors = {
      paths: () => Promise.resolve({ dataFolder: '/steam/Fallout 4/Data' }),
      winePrefix: noDetectPrefix,
    };

    const resolved = await resolverWith({}, detectors)(iniOfTheCorpusGameSoTheTablesAnswerRealSteamFacts(staleGameRoot));

    expect(resolved).toEqual({
      kind: 'notFound',
      setting: 'modbench.mods.gameDirectory',
      looked: [
        { place: SETTING_PLACE, answer: 'not set' },
        { place: GAME_PATH_PLACE, answer: `${staleGameRoot} has no Data folder` },
      ],
    });
  });

  it('answers not found for a game the tables hold no Steam facts for, rather than guessing a folder', async () => {
    const unknownGame = `[General]\r\ngameName=Morrowind\r\n`;
    let asked = false;
    const detectors: GameDetectors = {
      paths: () => { asked = true; return Promise.resolve(null); },
      winePrefix: noDetectPrefix,
    };

    expect(await resolverWith({}, detectors)(unknownGame)).toMatchObject({
      kind: 'notFound',
      looked: [
        { place: SETTING_PLACE, answer: 'not set' },
        { place: GAME_PATH_PLACE, answer: 'not set' },
        { place: STEAM_PLACE, answer: 'not asked: Modbench has no Steam entry for this game' },
      ],
    });
    expect(asked).toBe(false);
  });

  it('asks Steam nothing when the setting answers the root, not detecting up front on every branch, which reads Steam\'s library file (and spawns `reg query` on Windows) on every recompute', async () => {
    const gameRoot = await gameFolder();
    let asked = 0;
    const detectors: GameDetectors = {
      paths: () => { asked += 1; return Promise.resolve(null); },
      winePrefix: noDetectPrefix,
    };

    const resolved = await resolverWith({ gameDirectory: gameRoot }, detectors)(iniOfTheCorpusGameSoTheTablesAnswerRealSteamFacts());

    expect(resolved).toEqual({ kind: 'found', root: gameRoot, dataFolder: join(gameRoot, 'Data') });
    expect(asked).toBe(0);
  });

  it('asks Steam nothing when the ini gamePath answers the root', async () => {
    const gameRoot = await gameFolder();
    let asked = 0;
    const detectors: GameDetectors = {
      paths: () => { asked += 1; return Promise.resolve(null); },
      winePrefix: noDetectPrefix,
    };

    const resolved = await resolverWith({}, detectors)(iniOfTheCorpusGameSoTheTablesAnswerRealSteamFacts(gameRoot));

    expect(resolved).toEqual({ kind: 'found', root: gameRoot, dataFolder: join(gameRoot, 'Data') });
    expect(asked).toBe(0);
  });
});
