import { describe, expect, it } from 'vitest';
import { pluginsTxtPlace, type PrefixOf } from '../pluginsTxtPlace';

const LOCAL = 'C:\\Users\\me\\AppData\\Local';
const SETUP_PAGE = 'https://github.com/WhiskyTangoFawks/ModBench/blob/main/docs/wiki/deployment-on-linux.md';
const NO_FOLDER_KNOWN = 'Modbench knows no folder where this game reads plugins.txt';

describe('the folder the game reads plugins.txt from on Windows', () => {
  const place = (release: string | undefined, env: NodeJS.ProcessEnv) => pluginsTxtPlace('win32', env, () => Promise.resolve({ why: 'unused' }))(release, 'D:\\deploy');

  it.each([
    ['Fallout4', 'Fallout4'],
    ['Fallout4VR', 'Fallout4VR'],
    ['SkyrimSE', 'Skyrim Special Edition'],
    ['SkyrimVR', 'Skyrim VR'],
    ['Starfield', 'Starfield'],
  ])('for %s is %s in the local application data', async (release, name) => {
    expect(await place(release, { LOCALAPPDATA: LOCAL })).toEqual({ folder: `${LOCAL}\\${name}`, shared: true });
  });

  it.each([
    ['a release the tables hold no row for', 'Morrowind', { LOCALAPPDATA: LOCAL }, NO_FOLDER_KNOWN],
    ['no release', undefined, { LOCALAPPDATA: LOCAL }, NO_FOLDER_KNOWN],
    ['no local application data', 'Fallout4', {}, 'LOCALAPPDATA is not set'],
  ])('for %s is none, and says why', async (_case, release, env, why) => {
    expect(await place(release, env)).toEqual({ why });
  });
});

describe('the folder the game reads plugins.txt from on Linux', () => {
  const place = (prefixOf: PrefixOf, release = 'Fallout4') => pluginsTxtPlace('linux', {}, prefixOf)(release, '/deployments/survival');

  it('is the game folder in the prefix of the non-Steam game that runs a program in the deployment folder', async () => {
    const asked: string[] = [];

    const where = await place((folder) => { asked.push(folder); return Promise.resolve({ prefix: '/steam/compatdata/1/pfx' }); });

    expect([where, asked]).toEqual([{ folder: '/steam/compatdata/1/pfx/drive_c/users/steamuser/AppData/Local/Fallout4', shared: false }, ['/deployments/survival']]);
  });

  it('is none when there is no prefix, and says why and names the page', async () => {
    expect(await place(() => Promise.resolve({ why: 'no prefix yet' }))).toEqual({ why: `no prefix yet; the page that sets it up: ${SETUP_PAGE}` });
  });

  it('is none for a release the tables hold no row for', async () => {
    expect(await place(() => Promise.resolve({ prefix: '/p' }), 'Morrowind')).toEqual({ why: NO_FOLDER_KNOWN });
  });
});
