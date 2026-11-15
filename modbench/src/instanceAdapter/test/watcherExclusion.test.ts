import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { excludesFolder } from '../watcherExclusion';

const root = join('/', 'instances', 'litr');

describe('a folder the user excluded from VS Code\'s watch', () => {
  it.each([
    ['a folder-and-below pattern, for a folder below', { '**/mods/**': true }, 'mods/Harder VATS', true],
    ['a folder-and-below pattern, for the folder itself', { '**/mods/**': true }, 'mods', true],
    ['a pattern relative to the instance root', { 'mods/**': true }, 'mods/Harder VATS', true],
    ['a folder pattern, for a folder below it', { '**/mods': true }, 'mods/Harder VATS', true],
    ['a folder pattern, for the folder itself', { '**/mods': true }, 'mods', true],
    ['a pattern for one mod, for that mod', { '**/mods/Harder VATS/**': true }, 'mods/Harder VATS', true],
    ['a pattern for one mod, not for another', { '**/mods/Harder VATS/**': true }, 'mods/Patch Mod', false],
    ['a pattern for one mod, not for the mods', { '**/mods/Harder VATS/**': true }, 'mods', false],
    ['a pattern for files, for no folder', { '**/*.dds': true }, 'mods/Harder VATS', false],
    ['a pattern for another folder name, though a folder of that name could sit below', { '**/a/**': true }, 'mods/Harder VATS', false],
    ['a pattern set false', { '**/mods/**': false }, 'mods/Harder VATS', false],
    ['a pattern of the default exclusions', { '**/.git/objects/**': true }, 'mods/Harder VATS', false],
  ])('is told by %s', (_what, patterns, folder, excluded) => {
    expect(excludesFolder(patterns, join(root, folder), root)).toBe(excluded);
  });

  it('is told by an absolute pattern, for a folder outside the instance', () => {
    expect(excludesFolder({ '/games/fallout4/Data/**': true }, join('/', 'games', 'fallout4', 'Data'), root)).toBe(true);
  });
});
