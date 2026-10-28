import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { pluginsTxtPlace, SETUP_PAGE } from '../pluginsTxtPlace';

const LOCAL = 'C:\\Users\\me\\AppData\\Local';
const NO_ROW = 'Modbench knows no folder where this game reads plugins.txt';

describe('the folder the game reads plugins.txt from on Windows', () => {
  const place = (release: string | undefined, env: NodeJS.ProcessEnv) => pluginsTxtPlace('win32', env, undefined)(release, 'D:\\deploy');

  it.each([
    ['Fallout4', 'Fallout4'],
    ['Fallout4VR', 'Fallout4VR'],
    ['SkyrimSE', 'Skyrim Special Edition'],
    ['SkyrimVR', 'Skyrim VR'],
    ['Starfield', 'Starfield'],
  ])('for %s is %s in the local application data', async (release, name) => {
    expect(await place(release, { LOCALAPPDATA: LOCAL })).toEqual({ folder: `${LOCAL}\\${name}` });
  });

  it.each([
    ['a release the tables hold no row for', 'Morrowind', { LOCALAPPDATA: LOCAL }, NO_ROW],
    ['no release', undefined, { LOCALAPPDATA: LOCAL }, NO_ROW],
    ['no local application data', 'Fallout4', {}, 'LOCALAPPDATA is not set'],
  ])('for %s is none, and says why', async (_case, release, env, why) => {
    expect(await place(release, env)).toEqual({ why });
  });
});

const binaryText = (key: string, value: string): Buffer => Buffer.concat([Buffer.from([1]), Buffer.from(`${key}\0${value}\0`)]);
const binaryUint = (key: string, value: number): Buffer => {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32LE(value);
  return Buffer.concat([Buffer.from([2]), Buffer.from(`${key}\0`), bytes]);
};
const shortcutsFile = (entries: readonly { appid: number; exe: string }[]): Buffer => Buffer.concat([
  Buffer.from('\0shortcuts\0'),
  ...entries.flatMap(({ appid, exe }, n) => [
    Buffer.from(`\0${n}\0`), binaryUint('appid', appid), binaryText('AppName', 'Fallout 4'), binaryText('Exe', exe), Buffer.from([8]),
  ]),
  Buffer.from([8, 8]),
]);

describe('the folder the game reads plugins.txt from on Linux', () => {
  const APP_ID = 3_000_000_001;
  let steam: string;
  let deployment: string;
  const place = (release: string | undefined = 'Fallout4') => pluginsTxtPlace('linux', {}, steam)(release, deployment);
  const prefix = () => join(steam, 'steamapps', 'compatdata', String(APP_ID), 'pfx');
  const gameFolderInPrefix = () => join(prefix(), 'drive_c', 'users', 'steamuser', 'AppData', 'Local', 'Fallout4');
  const shortcutsOf = async (user: string, entries: readonly { appid: number; exe: string }[]) => {
    await mkdir(join(steam, 'userdata', user, 'config'), { recursive: true });
    await writeFile(join(steam, 'userdata', user, 'config', 'shortcuts.vdf'), shortcutsFile(entries));
  };

  beforeEach(async () => {
    const root = await mkdtemp(join(tmpdir(), 'place-'));
    steam = join(root, 'steam');
    deployment = join(root, 'deployments', 'survival');
    await mkdir(deployment, { recursive: true });
  });
  afterEach(() => rm(join(steam, '..'), { recursive: true, force: true }));

  it('is the game folder in the prefix of the non-Steam game whose program is in the deployment folder', async () => {
    await shortcutsOf('1', [{ appid: 7, exe: '"/elsewhere/f4se_loader.exe"' }, { appid: APP_ID, exe: `"${join(deployment, 'f4se_loader.exe')}"` }]);
    await mkdir(prefix(), { recursive: true });
    expect(await place()).toEqual({ folder: gameFolderInPrefix() });
  });

  it('finds the shortcut in any Steam user\'s file', async () => {
    await shortcutsOf('1', []);
    await shortcutsOf('2', [{ appid: APP_ID, exe: join(deployment, 'Fallout4.exe') }]);
    await mkdir(prefix(), { recursive: true });
    expect(await place()).toEqual({ folder: gameFolderInPrefix() });
  });

  it('is none when no Steam is known, and says why and names the page', async () => {
    expect(await pluginsTxtPlace('linux', {}, undefined)('Fallout4', deployment)).toEqual({ why: `Modbench found no Steam; set one up: ${SETUP_PAGE}` });
  });

  it('is none when Steam holds no shortcuts, and says why and names the page', async () => {
    expect(await place()).toEqual({ why: `no non-Steam game in Steam runs a program in ${deployment}; set one up: ${SETUP_PAGE}` });
  });

  it('is none when no non-Steam game runs a program in the deployment folder', async () => {
    await shortcutsOf('1', [{ appid: APP_ID, exe: join(deployment, '..', 'other', 'f4se_loader.exe') }]);
    await mkdir(prefix(), { recursive: true });
    expect(await place()).toEqual({ why: `no non-Steam game in Steam runs a program in ${deployment}; set one up: ${SETUP_PAGE}` });
  });

  it('is none when the game has no prefix yet', async () => {
    await shortcutsOf('1', [{ appid: APP_ID, exe: join(deployment, 'f4se_loader.exe') }]);
    expect(await place()).toEqual({ why: `Steam has made no prefix at ${prefix()} yet; launch the game once: ${SETUP_PAGE}` });
  });

  it('is none for a release the tables hold no row for', async () => {
    expect(await place('Morrowind')).toEqual({ why: NO_ROW });
  });
});
