import { describe, expect, it } from 'vitest';
import { pluginsTxtPlace } from '../pluginsTxtPlace';

const LOCAL = 'C:\\Users\\me\\AppData\\Local';

describe('the folder the game reads plugins.txt from', () => {
  it.each([
    ['Fallout4', 'Fallout4'],
    ['Fallout4VR', 'Fallout4VR'],
    ['SkyrimSE', 'Skyrim Special Edition'],
    ['SkyrimVR', 'Skyrim VR'],
    ['Starfield', 'Starfield'],
  ])('on Windows, for %s, is %s in the local application data', (release, name) => {
    expect(pluginsTxtPlace('win32', { LOCALAPPDATA: LOCAL })(release)).toEqual({ folder: `${LOCAL}\\${name}` });
  });

  it.each([
    ['a release the tables hold no row for', 'Morrowind', { LOCALAPPDATA: LOCAL }, 'Modbench knows no folder where this game reads plugins.txt'],
    ['no release', undefined, { LOCALAPPDATA: LOCAL }, 'Modbench knows no folder where this game reads plugins.txt'],
    ['no local application data', 'Fallout4', {}, 'LOCALAPPDATA is not set'],
  ])('on Windows, for %s, is none, and says why', (_case, release, env, why) => {
    expect(pluginsTxtPlace('win32', env)(release)).toEqual({ why });
  });

  it('on Linux is none, and says why', () => {
    expect(pluginsTxtPlace('linux', { LOCALAPPDATA: LOCAL })('Fallout4')).toEqual({ why: 'deploy does not yet write plugins.txt on linux' });
  });
});
