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
    ['a release the tables hold no row for', 'Morrowind', { LOCALAPPDATA: LOCAL }],
    ['no release', undefined, { LOCALAPPDATA: LOCAL }],
    ['no local application data', 'Fallout4', {}],
  ])('on Windows, for %s, is none, and says why', (_case, release, env) => {
    expect(pluginsTxtPlace('win32', env)(release)).toHaveProperty('why');
  });

  it('on Linux is none, and says why', () => {
    expect(pluginsTxtPlace('linux', { LOCALAPPDATA: LOCAL })('Fallout4')).toHaveProperty('why');
  });
});
