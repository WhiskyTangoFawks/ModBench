import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { resolvePluginDestination } from './pluginDestination';

describe('resolvePluginDestination', () => {
  it('overwrite resolves to the instance\'s overwrite/ folder with the reserved origin', () => {
    expect(resolvePluginDestination('/instance', { kind: 'overwrite' })).toEqual({
      path: join('/instance', 'overwrite'),
      origin: 'overwrite',
    });
  });

  it('existingMod resolves under mods/<name>, origin is the mod name', () => {
    expect(resolvePluginDestination('/instance', { kind: 'existingMod', modName: 'My Mod' })).toEqual({
      path: join('/instance', 'mods', 'My Mod'),
      origin: 'My Mod',
    });
  });

  it('newMod resolves the same way as existingMod (the folder is Mod Management\'s to create, not this function\'s)', () => {
    expect(resolvePluginDestination('/instance', { kind: 'newMod', modName: 'Brand New' })).toEqual({
      path: join('/instance', 'mods', 'Brand New'),
      origin: 'Brand New',
    });
  });
});
