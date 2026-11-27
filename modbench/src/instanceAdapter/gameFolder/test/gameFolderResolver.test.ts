import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fakeVscodeModule } from '../../../test/mo2/fakeVscodeWatcher';
import { adapterOver } from '../../../test/mo2/adapterOver';
import type { Machine } from '../../instanceAdapter';
import { INSTALLED_DEPOT, writeAppManifestOfDepot } from '../../../test/steamAppManifestFixture';
import { GAME_FOLDER_SETTING_ID } from '../../../test/gameFolderSetting';
import { onPosix, onWindows } from '../../../test/platform';
import { instanceOnDisk, qSettingsPath, settingsNaming } from '../../test/instanceOnDisk';
import { steamGameIn, steamIn, steamPrefixIn } from '../../test/steamOnDisk';

vi.mock('vscode', () => fakeVscodeModule());

const GAME_PATH_PLACE = "ModOrganizer.ini's gamePath";
const SETTING_PLACE = `the game folder setting, ${GAME_FOLDER_SETTING_ID}`;
const STEAM_PLACE = 'the Steam install';

/** A machine that notes each place it is asked where Steam is. */
const notingSteamAsked = (asked: string[]): Partial<Machine> => ({
  get homeFolder() { asked.push('the home folder'); return '/nowhere'; },
  registryValue: (key, name) => { asked.push(key); return Promise.reject(new Error(`${key} holds no ${name}`)); },
});

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
    { setting, gamePath, gameName, machine }: { setting?: string; gamePath?: string; gameName?: string; machine?: Partial<Machine> },
  ) => adapterOver(await instanceNaming(gamePath, gameName), { gameFolderSettingValue: setting, machine }).gameFolder();
  /** Steam holding the game in its one library: what the machine answers of it, and the game's folder. */
  const steamHoldingGame = async (): Promise<{ machine: Partial<Machine>; root: string }> => {
    const base = await temp();
    return { machine: await steamIn(base), root: steamGameIn(base) };
  };

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
      const asked: string[] = [];

      expect(await resolved({ gamePath: `Z:${root.replaceAll('/', '\\')}`, machine: notingSteamAsked(asked) })).toEqual({ kind: 'found', root, dataFolder: join(root, 'Data') });
      expect(asked).toEqual([]);
    });

    it("is in the Proton prefix's drive_c for a C:-drive game path", async () => {
      const base = await temp();
      const root = join(steamPrefixIn(base), 'drive_c', 'Games', 'Fallout4');
      await mkdir(join(root, 'Data'), { recursive: true });

      expect(await resolved({ gamePath: 'C:\\Games\\Fallout4', machine: await steamIn(base) })).toEqual({ kind: 'found', root, dataFolder: join(root, 'Data') });
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
      expect(await resolved({ gamePath })).toEqual({
        kind: 'notFound',
        setting: GAME_FOLDER_SETTING_ID,
        looked: [{ place: SETTING_PLACE, answer: 'not set' }, { place: GAME_PATH_PLACE, answer: expect.stringMatching(why) as unknown }],
      });
    });
  });

  it('is the one Steam holds when neither the setting nor the manager names one', async () => {
    const { machine, root } = await steamHoldingGame();

    expect(await resolved({ machine })).toEqual({ kind: 'found', root, dataFolder: join(root, 'Data') });
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

    expect(await resolved({ gamePath: stale, machine: (await steamHoldingGame()).machine })).toEqual({
      kind: 'notFound',
      setting: GAME_FOLDER_SETTING_ID,
      looked: [{ place: SETTING_PLACE, answer: 'not set' }, { place: GAME_PATH_PLACE, answer: `${stale} has no Data folder` }],
    });
  });

  it('is not found, asking Steam nothing, for a game the tables hold no Steam facts for, rather than guessing a folder', async () => {
    const asked: string[] = [];

    expect(await resolved({ gameName: 'Skyrim VR', machine: notingSteamAsked(asked) })).toMatchObject({
      kind: 'notFound',
      looked: [
        { place: SETTING_PLACE, answer: 'not set' },
        { place: GAME_PATH_PLACE, answer: 'not set' },
        { place: STEAM_PLACE, answer: 'not asked: Modbench has no Steam entry for this game' },
      ],
    });
    expect(asked).toEqual([]);
  });

  it.each([
    ['the setting', (root: string) => ({ setting: root })],
    ['the game path the manager names', (root: string) => ({ gamePath: root })],
  ])('asks Steam nothing when %s answers the root, a detection reading Steam\'s library file (and spawning `reg query` on Windows) on every recompute', async (_, naming) => {
    const root = await gameFolder();
    const asked: string[] = [];

    expect(await resolved({ ...naming(root), machine: notingSteamAsked(asked) })).toEqual({ kind: 'found', root, dataFolder: join(root, 'Data') });
    expect(asked).toEqual([]);
  });
});

describe('where the game is, beside the Steam install', () => {
  const dirs: string[] = [];
  afterEach(async () => {
    for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
  });
  const placeOf = async (machine: Partial<Machine>, gameName?: string) => {
    const root = await instanceOnDisk({ 'ModOrganizer.ini': settingsNaming(gameName) });
    const game = await mkdtemp(join(tmpdir(), 'medit-game-'));
    dirs.push(root, game);
    await mkdir(join(game, 'Data'));
    return { game, place: await adapterOver(root, { gameFolderSettingValue: game, machine }).gamePlace() };
  };

  it('holds the Steam install Steam holds, whatever folder the setting names, with the depots Steam installed of the game from the app manifest of its library', async () => {
    const base = await mkdtemp(join(tmpdir(), 'medit-steamlib-'));
    dirs.push(base);
    const machine = await steamIn(base);
    await writeAppManifestOfDepot(join(base, 'library'));

    const { game, place } = await placeOf(machine);

    expect(place).toEqual({ root: game, steamRoot: steamGameIn(base), steamApp: 377160, depots: [INSTALLED_DEPOT], depotProblems: [] });
  });

  it('holds no Steam install when Steam holds no such game', async () => {
    const { game, place } = await placeOf({});

    expect(place).toEqual({ root: game, depots: [], depotProblems: [] });
  });

  it('holds no Steam install when Modbench has no Steam entry for the game, asking Steam nothing', async () => {
    const asked: string[] = [];
    const { game, place } = await placeOf(notingSteamAsked(asked), 'Skyrim VR');

    expect([place, asked]).toEqual([{ root: game, depots: [], depotProblems: [] }, []]);
  });
});
