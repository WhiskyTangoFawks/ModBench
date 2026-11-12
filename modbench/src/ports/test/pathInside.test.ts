import { describe, expect, it } from 'vitest';
import { isInside } from '../pathInside';

describe('a path inside a folder', () => {
  it.each([
    ['linux', '/instance', '/instance', true],
    ['linux', '/instance/mods/Mod/a.dds', '/instance', true],
    ['linux', '/instance-game/Data/a.dds', '/instance', false],
    ['linux', '/Instance/a.dds', '/instance', false],
    ['linux', '/games/a.dds', '/instance/', false],
    ['win32', 'C:\\Games\\Fallout 4', 'c:\\games\\fallout 4', true],
    ['win32', 'C:/Games/Fallout 4/Data', 'c:\\games\\fallout 4', true],
    ['win32', 'C:\\Games-Old\\Data', 'c:\\games', false],
  ] as const)('on %s, %s in %s is %s', (platform, path, folder, inside) => {
    expect(isInside(path, folder, platform)).toBe(inside);
  });
});
