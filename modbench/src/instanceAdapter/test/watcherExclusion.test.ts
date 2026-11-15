import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { exclusionOf } from '../watcherExclusion';

const root = join('/', 'instances', 'litr');
const under = (...paths: string[]): string[] => paths.map((path) => join(root, path));

const MODS = ['mods', 'mods/Harder VATS', 'mods/Harder VATS/textures', 'mods/Harder VATS/textures/actors', 'mods/Patch Mod', 'mods/Patch Mod/textures'];
const FILES = ['mods/Harder VATS/textures/a.dds', 'mods/Harder VATS/Harder VATS.esp', 'mods/Patch Mod/textures/b.dds'];

describe('what the user excluded from VS Code\'s watch (files.watcherExclude)', () => {
  it.each([
    ['a folder-and-below pattern, the folder itself and so every folder below it', { '**/mods/**': true }, ['mods']],
    ['a pattern relative to the instance root', { 'mods/**': true }, ['mods']],
    ['a folder pattern', { '**/mods': true }, ['mods']],
    ['a pattern for one mod, that mod alone', { '**/mods/Harder VATS/**': true }, ['mods/Harder VATS']],
    ['a pattern for a folder name at any depth, each topmost folder of that name', { '**/textures/**': true }, ['mods/Harder VATS/textures', 'mods/Patch Mod/textures']],
    ['a pattern for a folder below one mod, that folder alone', { '**/mods/Harder VATS/textures/**': true }, ['mods/Harder VATS/textures']],
    ['an alternation of folder names', { '**/{actors,textures}': true }, ['mods/Harder VATS/textures', 'mods/Patch Mod/textures']],
    ['a pattern for files, no folder', { '**/*.dds': true }, []],
    ['a pattern for a folder name nothing listed has', { '**/a/**': true }, []],
    ['a pattern set false', { '**/mods/**': false }, []],
    ['a default pattern', { '**/.git/objects/**': true }, []],
  ])('names, for %s, the topmost excluded folders', (_what, patterns, topmost) => {
    expect(exclusionOf(patterns, root).topmostExcluded(under(...MODS))).toEqual(under(...topmost));
  });

  it.each([
    ['a pattern for files', { '**/*.dds': true }, ['**/*.dds']],
    ['a pattern for files under one extension in a folder', { '**/textures/*.dds': true }, ['**/textures/*.dds']],
    ['an alternation of extensions', { '**/*.{dds,png}': true }, ['**/*.{dds,png}']],
    ['a pattern for an extension nothing listed has', { '**/*.png': true }, []],
    ['a pattern for a folder, which names the folder and no file in it', { '**/textures/**': true }, []],
    ['a pattern set false', { '**/*.dds': false }, []],
    ['each of two patterns', { '**/*.dds': true, '**/*.esp': true }, ['**/*.dds', '**/*.esp']],
  ])('names, for %s, each pattern that excludes a listed file', (_what, patterns, named) => {
    expect(exclusionOf(patterns, root).patternsExcludingFiles(under(...FILES))).toEqual(named);
  });

  it('tells an absolute pattern for a folder outside the instance', () => {
    expect(exclusionOf({ '/games/fallout4/Data/**': true }, root).excludesFolder(join('/', 'games', 'fallout4', 'Data'))).toBe(true);
  });
});
