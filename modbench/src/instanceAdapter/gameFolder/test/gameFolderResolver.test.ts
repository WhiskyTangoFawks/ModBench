import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fakeVscodeModule } from '../../../test/mo2/fakeVscodeWatcher';
import { adapterOver, type AdapterAnswers } from '../../../test/mo2/adapterOver';
import { NO_DETECTORS } from '../../../test/noDetectors';
import { INSTALLED_DEPOT, writeAppManifestOfDepot } from '../../../test/steamAppManifestFixture';
import { GAME_FOLDER_SETTING_ID } from '../../../test/gameFolderSetting';
import { onPosix, onWindows } from '../../../test/platform';
import { instanceOnDisk, qSettingsPath, settingsNaming } from '../../test/instanceOnDisk';

vi.mock('vscode', () => fakeVscodeModule());

type GameDetectors = NonNullable<AdapterAnswers['detectors']>;

const GAME_PATH_PLACE = "ModOrganizer.ini's gamePath";
const SETTING_PLACE = `the game folder setting, ${GAME_FOLDER_SETTING_ID}`;
const STEAM_PLACE = 'the Steam install';
const STEAM_DATA = '/steam/Fallout 4/Data';
const steamHolding = (dataFolder: string): GameDetectors => ({ ...NO_DETECTORS, paths: () => Promise.resolve({ dataFolder }) });

describe('the game folder', () => {
  const dirs: string[] = [];
  afterEach(async () => {
    for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
  });

  const temp = async (): Promise<string> => {
    const dir = await mkdtemp(join(tmpdir(), 'medit-gamefolder-'));
    dirs.push(dir);
    return dir;
  };
  async function gameFolder(name = 'Stock Game Folder'): Promise<string> {
    const root = join(await temp(), name);
    await mkdir(join(root, 'Data'), { recursive: true });
    return root;
  }
  const instanceNaming = async (gamePath?: string, gameName?: string): Promise<string> => {
    const root = await instanceOnDisk({ 'ModOrganizer.ini': settingsNaming(gameName, ...(gamePath === undefined ? [] : [`gamePath=${qSettingsPath(gamePath)}`])) });
    dirs.push(root);
    return root;
  };
  const resolved = async (
    { setting, gamePath, gameName, detectors = NO_DETECTORS }: { setting?: string; gamePath?: string; gameName?: string; detectors?: GameDetectors },
  ) => adapterOver(await instanceNaming(gamePath, gameName), { gameFolderSettingValue: setting, detectors }).gameFolder();

  it.each<[string, (root: string) => { setting?: string; gamePath?: string }]>([
    ['the game folder setting names', (root) => ({ setting: root })],
    ['the setting names, the whitespace pasted around it trimmed', (root) => ({ setting: `  ${root}  ` })],
    ['the manager names, the setting left at its empty default being unset and not an empty path', (root) => ({ setting: '   ', gamePath: root })],
    ['the manager names when the setting is unset', (root) => ({ gamePath: root })],
  ])('is the folder %s, with its Data folder', async (_, naming) => {
    const root = await gameFolder();

    expect(await resolved(naming(root))).toEqual({ kind: 'found', root, dataFolder: join(root, 'Data') });
  });

  onPosix.describe('(a colon is legal in a Linux folder name)', () => {
    it('is a folder the manager names with a colon inside it, only a leading drive letter being Wine\'s', async () => {
      const root = await gameFolder('A:B');

      expect(await resolved({ gamePath: root })).toEqual({ kind: 'found', root, dataFolder: join(root, 'Data') });
    });
  });

  onPosix.describe('(Wine translates a drive letter only on Linux)', () => {
    it('is the POSIX path of a Z:-drive game path, as a Windows manager under Proton writes it, without asking Steam for the prefix', async () => {
      const root = await gameFolder();
      const detectors: GameDetectors = { ...NO_DETECTORS, winePrefix: () => Promise.reject(new Error('the prefix was asked')) };

      expect(await resolved({ gamePath: `Z:${root.replaceAll('/', '\\')}`, detectors })).toEqual({ kind: 'found', root, dataFolder: join(root, 'Data') });
    });
  });

  onPosix.describe("(Wine translates a drive letter only on Linux)", () => {
    it("is in the Proton prefix's drive_c for a C:-drive game path", async () => {
      const prefix = await temp();
      const root = join(prefix, 'drive_c', 'Games', 'Fallout4');
      await mkdir(join(root, 'Data'), { recursive: true });
      const detectors: GameDetectors = { ...NO_DETECTORS, winePrefix: () => Promise.resolve(prefix) };

      expect(await resolved({ gamePath: 'C:\\Games\\Fallout4', detectors })).toEqual({ kind: 'found', root, dataFolder: join(root, 'Data') });
    });
  });

  onWindows.describe('on Windows', () => {
    it.each([
      ['as it is when native', (root: string) => root],
      ['in its native form when MO2 wrote it with forward slashes', (root: string) => root.replaceAll('\\', '/')],
    ])('is the Windows folder the manager names, %s', async (_, spelled) => {
      const root = await gameFolder();

      expect(await resolved({ gamePath: spelled(root) })).toEqual({ kind: 'found', root, dataFolder: join(root, 'Data') });
    });
  });

  onPosix.describe('(Wine translates a drive letter only on Linux)', () => {
    it.each([
      ['a C: game path whose prefix cannot be determined', 'C:\\Games\\Fallout4', /prefix could not be determined/],
      ['a game path on a drive that is neither Z: nor C:, rather than stripped to the root', 'D:\\Games\\Fallout4', /only Z: and C: are translated/],
    ])('is not found, saying why and never asking Steam, for %s', async (_, gamePath, why) => {
      const detectors: GameDetectors = { ...steamHolding(STEAM_DATA), winePrefix: () => Promise.resolve(null) };

      expect(await resolved({ gamePath, detectors })).toEqual({
        kind: 'notFound',
        setting: GAME_FOLDER_SETTING_ID,
        looked: [{ place: SETTING_PLACE, answer: 'not set' }, { place: GAME_PATH_PLACE, answer: expect.stringMatching(why) as unknown }],
      });
    });
  });

  it('is the one Steam holds when neither the setting nor the manager names one', async () => {
    expect(await resolved({ detectors: steamHolding(STEAM_DATA) })).toEqual({ kind: 'found', root: '/steam/Fallout 4', dataFolder: STEAM_DATA });
  });

  it('is not found, naming each place looked, when nothing resolves', async () => {
    expect(await resolved({})).toEqual({
      kind: 'notFound',
      setting: GAME_FOLDER_SETTING_ID,
      looked: [{ place: SETTING_PLACE, answer: 'not set' }, { place: GAME_PATH_PLACE, answer: 'not set' }, { place: STEAM_PLACE, answer: 'the game is in no Steam library' }],
    });
  });

  it('is not found, naming only the setting, when the setting names a folder with no Data folder, not falling through to the folder the manager names, which the user did not name', async () => {
    const named = join(await temp(), 'Stock Game Folder');
    await mkdir(named);

    expect(await resolved({ setting: named, gamePath: await gameFolder() })).toEqual({
      kind: 'notFound', setting: GAME_FOLDER_SETTING_ID, looked: [{ place: SETTING_PLACE, answer: `${named} has no Data folder` }],
    });
  });

  it('is not found, naming the folder, when the manager names a folder with no Data folder, rather than falling through to a Steam install', async () => {
    const stale = join(await temp(), 'Stale Game Folder');
    await mkdir(stale);

    expect(await resolved({ gamePath: stale, detectors: steamHolding(STEAM_DATA) })).toEqual({
      kind: 'notFound',
      setting: GAME_FOLDER_SETTING_ID,
      looked: [{ place: SETTING_PLACE, answer: 'not set' }, { place: GAME_PATH_PLACE, answer: `${stale} has no Data folder` }],
    });
  });

  it('is not found, asking Steam nothing, for a game the tables hold no Steam facts for, rather than guessing a folder', async () => {
    const detectors: GameDetectors = { ...NO_DETECTORS, paths: () => Promise.reject(new Error('Steam was asked')) };

    expect(await resolved({ gameName: 'Skyrim VR', detectors })).toMatchObject({
      kind: 'notFound',
      looked: [
        { place: SETTING_PLACE, answer: 'not set' },
        { place: GAME_PATH_PLACE, answer: 'not set' },
        { place: STEAM_PLACE, answer: 'not asked: Modbench has no Steam entry for this game' },
      ],
    });
  });

  it.each([
    ['the setting', (root: string) => ({ setting: root })],
    ['the game path the manager names', (root: string) => ({ gamePath: root })],
  ])('asks Steam nothing when %s answers the root, a detection reading Steam\'s library file (and spawning `reg query` on Windows) on every recompute', async (_, naming) => {
    const root = await gameFolder();
    const detectors: GameDetectors = { ...NO_DETECTORS, paths: () => Promise.reject(new Error('Steam was asked')) };

    expect(await resolved({ ...naming(root), detectors })).toEqual({ kind: 'found', root, dataFolder: join(root, 'Data') });
  });
});

describe('where the game is, beside the Steam install', () => {
  const dirs: string[] = [];
  afterEach(async () => {
    for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
  });
  const placeOf = async (detectors: GameDetectors, gameName?: string) => {
    const root = await instanceOnDisk({ 'ModOrganizer.ini': settingsNaming(gameName) });
    const game = await mkdtemp(join(tmpdir(), 'medit-game-'));
    dirs.push(root, game);
    await mkdir(join(game, 'Data'));
    return { game, place: await adapterOver(root, { gameFolderSettingValue: game, detectors }).gamePlace() };
  };

  it('holds the Steam install Steam holds, whatever folder the setting names, with the depots Steam installed of the game from the app manifest of its library', async () => {
    const library = await mkdtemp(join(tmpdir(), 'medit-steamlib-'));
    dirs.push(library);
    const dataFolder = join(library, 'steamapps', 'common', 'Fallout 4', 'Data');
    await mkdir(dataFolder, { recursive: true });
    await writeAppManifestOfDepot(library);

    const { game, place } = await placeOf(steamHolding(dataFolder));

    expect(place).toEqual({ root: game, steamRoot: join(library, 'steamapps', 'common', 'Fallout 4'), steamApp: 377160, depots: [INSTALLED_DEPOT], depotProblems: [] });
  });

  it.each([
    ['Steam holds no such game', 'Fallout 4', NO_DETECTORS],
    ['Modbench has no Steam entry for the game, asking Steam nothing', 'Skyrim VR', { ...NO_DETECTORS, paths: () => Promise.reject(new Error('Steam was asked')) }],
  ])('holds no Steam install when %s', async (_, gameName, detectors) => {
    const { game, place } = await placeOf(detectors, gameName);

    expect(place).toEqual({ root: game, depots: [], depotProblems: [] });
  });
});
