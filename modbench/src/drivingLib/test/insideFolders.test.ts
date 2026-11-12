import { describe, expect, it } from 'vitest';
import { isInsideAny } from '../insideFolders';

describe('a path inside the folders that are open', () => {
  it.each([
    ['a folder itself', '/instance', true],
    ['a file below a folder', '/instance/mods/Mod/a.dds', true],
    ['a sibling that shares the folder name as a prefix', '/instance-game/Data/a.dds', false],
    ['a path elsewhere', '/games/Fallout 4/Data/a.dds', false],
  ])('%s', (_case, path, inside) => {
    expect(isInsideAny(['/other', '/instance'], path)).toBe(inside);
  });

  it('is inside none when no folder is open', () => {
    expect(isInsideAny([], '/instance/a.dds')).toBe(false);
  });
});
