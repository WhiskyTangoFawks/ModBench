import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, posix } from 'node:path';
import {
  gameFolderResolver, normalizeGamePath, type GameDetectors, type ManagerGamePath,
} from '../gameFolderResolver';
import { NO_DETECTORS } from '../../../test/noDetectors';
import { documentsFolder } from '../documentsFolder';
import { fixedGameFolderSetting, GAME_FOLDER_SETTING_ID } from '../../../test/gameFolderSetting';

const noDetectPrefix = () => Promise.resolve(null);

const RELEASE_WITH_STEAM_FACTS = 'Fallout4';
const GAME_PATH_PLACE = "the manager's game path";

const managerNaming = (path?: string, ...release: [] | [string | undefined]): ManagerGamePath =>
  ({ path, place: GAME_PATH_PLACE, release: release.length === 0 ? RELEASE_WITH_STEAM_FACTS : release[0] });

const SETTING_PLACE = `the game folder setting, ${GAME_FOLDER_SETTING_ID}`;
const STEAM_PLACE = 'the Steam install';

const resolverWith = (
  settingValue?: string, detectors: GameDetectors = NO_DETECTORS,
) => gameFolderResolver(fixedGameFolderSetting(settingValue), detectors);

describe('the Documents folder Windows names', () => {
  it('reads a non-ASCII Documents path as UTF-8, having told PowerShell to write it so', async () => {
    const commands: string[] = [];

    const documents = await documentsFolder((command) => {
      commands.push(command);
      return Promise.resolve(Buffer.from('C:\\Users\\José\\Документы\r\n', 'utf8'));
    });

    expect(documents).toBe('C:\\Users\\José\\Документы');
    expect(commands[0]).toMatch(/^\[Console\]::OutputEncoding=\[Text\.Encoding\]::UTF8;/);
  });
});

describe('a game path in the platform\'s own form', () => {
  it('leaves a native Windows path untouched', async () => {
    expect(await normalizeGamePath('C:\\Games\\Fallout4', 'win32', noDetectPrefix)).toBe('C:\\Games\\Fallout4');
  });

  it('spells a Windows path MO2 wrote with forward slashes in its native form, as %BASE_DIR%/downloads reads once substituted', async () => {
    expect(await normalizeGamePath('C:\\MO2/downloads', 'win32', noDetectPrefix)).toBe('C:\\MO2\\downloads');
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

    expect(result).toBe(posix.join(prefix, 'drive_c', 'Games/Fallout4'));
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

describe('the game folder resolver', () => {
  const dirs: string[] = [];

  afterEach(async () => {
    for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
  });

  async function gameFolder(name = 'Stock Game Folder'): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'medit-gamefolder-'));
    dirs.push(dir);
    const root = join(dir, name);
    await mkdir(join(root, 'Data'), { recursive: true });
    return root;
  }

  it('resolves an explicit game folder setting directly', async () => {
    const gameRoot = await gameFolder();

    const resolved = await resolverWith(gameRoot)(managerNaming());

    expect(resolved).toMatchObject({ root: gameRoot, dataFolder: join(gameRoot, 'Data') });
  });

  it('trims whitespace accidentally pasted around an explicit setting value', async () => {
    const gameRoot = await gameFolder();

    const resolved = await resolverWith(`  ${gameRoot}  `)(managerNaming());

    expect(resolved).toMatchObject({ root: gameRoot, dataFolder: join(gameRoot, 'Data') });
  });

  it('reads a setting left at its empty default as unset, not as an empty path', async () => {
    const gameRoot = await gameFolder();

    const resolved = await resolverWith('   ')(managerNaming(gameRoot));

    expect(resolved).toMatchObject({ root: gameRoot });
  });

  it('answers not found, naming only the setting, when the explicit setting has no Data/ subfolder, not falling through to the game path the manager names, which would resolve a folder the user did not name', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'medit-gamefolder-'));
    dirs.push(dir);
    const gameRoot = join(dir, 'Stock Game Folder');
    await mkdir(gameRoot, { recursive: true });
    const iniGameRoot = await gameFolder();

    const resolved = await resolverWith(gameRoot)(managerNaming(iniGameRoot));

    expect(resolved).toEqual({
      kind: 'notFound',
      setting: GAME_FOLDER_SETTING_ID,
      looked: [{ place: SETTING_PLACE, answer: `${gameRoot} has no Data folder` }],
    });
  });

  it('falls back to the game path the manager names when the setting is unset', async () => {
    const gameRoot = await gameFolder();

    const resolved = await resolverWith()(managerNaming(gameRoot));

    expect(resolved).toMatchObject({ root: gameRoot, dataFolder: join(gameRoot, 'Data') });
  });

  it.skipIf(process.platform === 'win32')('(Wine translates a drive letter only on Linux) normalizes a Z:-drive game path, as a Windows manager under Proton writes it, to its POSIX path', async () => {
    const gameRoot = await gameFolder();
    const winePath = 'Z:' + gameRoot.replaceAll('/', '\\');

    const resolved = await resolverWith()(managerNaming(winePath));

    expect(resolved).toMatchObject({ root: gameRoot, dataFolder: join(gameRoot, 'Data') });
  });

  it.skipIf(process.platform === 'win32')("(Wine translates a drive letter only on Linux) normalizes a C: drive-mapped game path into the Proton prefix's drive_c", async () => {
    const prefixDir = await mkdtemp(join(tmpdir(), 'medit-prefix-'));
    dirs.push(prefixDir);
    const gameRoot = join(prefixDir, 'drive_c', 'Games', 'Fallout4');
    await mkdir(join(gameRoot, 'Data'), { recursive: true });
    const detectors: GameDetectors = { ...NO_DETECTORS, winePrefix: () => Promise.resolve(prefixDir) };

    const resolved = await resolverWith(undefined, detectors)(managerNaming('C:\\Games\\Fallout4'));

    expect(resolved).toMatchObject({ root: gameRoot, dataFolder: join(gameRoot, 'Data') });
  });

  it.skipIf(process.platform === 'win32')('(Wine translates a drive letter only on Linux) answers not found, with the reason, and does not answer with the detected folder when a C: game path has no determinable prefix', async () => {
    const detectors: GameDetectors = {
      ...NO_DETECTORS,
      paths: () => Promise.resolve({ dataFolder: '/steam/Fallout 4/Data' }),
      winePrefix: () => Promise.resolve(null),
    };

    const resolved = await resolverWith(undefined, detectors)(managerNaming('C:\\Games\\Fallout4'));

    expect(resolved).toMatchObject({
      kind: 'notFound',
      looked: [
        { place: SETTING_PLACE, answer: 'not set' },
        { place: GAME_PATH_PLACE, answer: expect.stringMatching(/prefix could not be determined/) as unknown },
      ],
    });
  });

  it('falls back to Steam autodetection when the setting and the game path the manager names are both absent', async () => {
    const detectors: GameDetectors = {
      ...NO_DETECTORS,
      paths: () => Promise.resolve({ dataFolder: '/steam/Fallout 4/Data' }),
      winePrefix: noDetectPrefix,
    };

    const resolved = await resolverWith(undefined, detectors)(managerNaming());

    expect(resolved).toEqual({ kind: 'found', root: '/steam/Fallout 4', dataFolder: '/steam/Fallout 4/Data' });
  });

  it('answers not found, naming each place looked, when nothing resolves — setting unset, no gamePath, autodetect finds nothing', async () => {
    expect(await resolverWith()(managerNaming())).toEqual({
      kind: 'notFound',
      setting: GAME_FOLDER_SETTING_ID,
      looked: [
        { place: SETTING_PLACE, answer: 'not set' },
        { place: GAME_PATH_PLACE, answer: 'not set' },
        { place: STEAM_PLACE, answer: 'the game is in no Steam library' },
      ],
    });
  });

  it('refuses, naming the folder, when the manager names a game folder with no Data/, rather than falling through to a Steam install', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'medit-gamefolder-'));
    dirs.push(dir);
    const staleGameRoot = join(dir, 'Stale Game Folder');
    await mkdir(staleGameRoot, { recursive: true });
    const detectors: GameDetectors = {
      ...NO_DETECTORS,
      paths: () => Promise.resolve({ dataFolder: '/steam/Fallout 4/Data' }),
      winePrefix: noDetectPrefix,
    };

    const resolved = await resolverWith(undefined, detectors)(managerNaming(staleGameRoot));

    expect(resolved).toEqual({
      kind: 'notFound',
      setting: GAME_FOLDER_SETTING_ID,
      looked: [
        { place: SETTING_PLACE, answer: 'not set' },
        { place: GAME_PATH_PLACE, answer: `${staleGameRoot} has no Data folder` },
      ],
    });
  });

  it('answers not found for a game the tables hold no Steam facts for, rather than guessing a folder', async () => {
    const unknownGame = managerNaming(undefined, undefined);
    let asked = false;
    const detectors: GameDetectors = {
      ...NO_DETECTORS,
      paths: () => { asked = true; return Promise.resolve(null); },
      winePrefix: noDetectPrefix,
    };

    expect(await resolverWith(undefined, detectors)(unknownGame)).toMatchObject({
      kind: 'notFound',
      looked: [
        { place: SETTING_PLACE, answer: 'not set' },
        { place: GAME_PATH_PLACE, answer: 'not set' },
        { place: STEAM_PLACE, answer: 'not asked: Modbench has no Steam entry for this game' },
      ],
    });
    expect(asked).toBe(false);
  });

  it.each([
    ['the setting', (root: string) => [root, undefined]],
    ['the game path the manager names', (root: string) => [undefined, root]],
  ] as const)('asks Steam nothing when %s answers the root, not detecting up front on every branch, which reads Steam\'s library file (and spawns `reg query` on Windows) on every recompute', async (_, sources) => {
    const gameRoot = await gameFolder();
    const [setting, managerPath] = sources(gameRoot);
    let asked = 0;
    const detectors: GameDetectors = {
      ...NO_DETECTORS,
      paths: () => { asked += 1; return Promise.resolve(null); },
      winePrefix: noDetectPrefix,
    };

    const resolved = await resolverWith(setting, detectors)(managerNaming(managerPath));

    expect(resolved).toEqual({ kind: 'found', root: gameRoot, dataFolder: join(gameRoot, 'Data') });
    expect(asked).toBe(0);
  });
});
