import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { PLUGIN_DESTINATION_OPTIONS, resolvePluginDestination } from './pluginDestination';

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
});

describe('PLUGIN_DESTINATION_OPTIONS (New Plugin\'s destination QuickPick)', () => {
  it('offers exactly two destinations: overwrite/ and Existing mod…', () => {
    expect(PLUGIN_DESTINATION_OPTIONS.map((o) => o.label)).toEqual(['overwrite/', 'Existing mod…']);
  });

  it('lists overwrite/ first, so it is the pre-highlighted default', () => {
    expect(PLUGIN_DESTINATION_OPTIONS[0]!.choice).toBe('overwrite');
  });
});
