import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { PLUGIN_DESTINATION_OPTIONS, resolvePluginDestination } from './pluginDestination';
import { instanceValueFixture } from './test/instanceValueFixture';
import { present } from '../ports/present';

const value = instanceValueFixture({
  paths: {
    overwriteDir: join('/instance', 'overwrite'),
    downloadsDir: join('/instance', 'downloads'),
    modDirs: new Map([['My Mod', join('/instance', 'mods', 'My Mod')]]),
  },
});

describe('resolvePluginDestination', () => {
  it('overwrite resolves to the value\'s overwrite/ folder with the reserved origin', () => {
    expect(resolvePluginDestination(value, { kind: 'overwrite' })).toEqual({
      path: join('/instance', 'overwrite'),
      origin: 'overwrite',
    });
  });

  it('existingMod resolves to the folder the value names for that mod, origin is the mod name', () => {
    expect(resolvePluginDestination(value, { kind: 'existingMod', modName: 'My Mod' })).toEqual({
      path: join('/instance', 'mods', 'My Mod'),
      origin: 'My Mod',
    });
  });

  // Rival: joining mods/<name> here, which answers a folder for a mod the value does not list —
  // a plugin landing in a directory nothing owns.
  it('answers nothing for a mod the value names no folder for', () => {
    expect(resolvePluginDestination(value, { kind: 'existingMod', modName: 'Uninstalled' })).toBeUndefined();
  });
});

describe('PLUGIN_DESTINATION_OPTIONS (New Plugin\'s destination QuickPick)', () => {
  it('offers exactly two destinations: overwrite/ and Existing mod…', () => {
    expect(PLUGIN_DESTINATION_OPTIONS.map((o) => o.label)).toEqual(['overwrite/', 'Existing mod…']);
  });

  it('lists overwrite/ first, so it is the pre-highlighted default', () => {
    expect(present(PLUGIN_DESTINATION_OPTIONS[0], 'the first destination option').choice).toBe('overwrite');
  });
});
