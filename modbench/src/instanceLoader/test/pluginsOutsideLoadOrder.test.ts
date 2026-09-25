import { describe, it, expect } from 'vitest';
import { FileConflictLookup, type FileConflictIndex } from '../fileConflictIndex';
import { findPluginsOutsideLoadOrder } from '../pluginsOutsideLoadOrder';

// The plugin files the effective load order does not point at (ADR-0013): an overridden plugin,
// or a file plugins.txt never names.

// Discovery reads filesByMod only; the load-order set is passed in already resolved.
function indexOf(filesByMod: Record<string, string[]>): FileConflictIndex {
  return {
    files: new FileConflictLookup(),
    filesByMod: new Map(
      Object.entries(filesByMod).map(([mod, paths]) => [
        mod,
        paths.map((relativePath) => ({ relativePath, absolutePath: `/mods/${mod}/${relativePath}` })),
      ]),
    ),
  };
}

describe('findPluginsOutsideLoadOrder', () => {
  it('finds the plugin a winning mod overrides', () => {
    const index = indexOf({ Winner: ['Shared.esp'], Loser: ['Shared.esp'] });

    const found = findPluginsOutsideLoadOrder(index, [{ name: 'Shared.esp', origin: 'Winner' }]);

    expect(found).toEqual([
      { name: 'Shared.esp', path: '/mods/Loser/Shared.esp', origin: 'Loser' },
    ]);
  });

  it('finds a plugin file the load order never names, including every plugin that shares its filename', () => {
    const index = indexOf({ ModA: ['Optional.esp'], ModB: ['Optional.esp'] });

    const found = findPluginsOutsideLoadOrder(index, []);

    expect(found.map((p) => p.origin).sort()).toEqual(['ModA', 'ModB']);
  });

  it('ignores a plugin the load order already holds from that same mod', () => {
    const index = indexOf({ ModA: ['Loaded.esp'] });

    expect(findPluginsOutsideLoadOrder(index, [{ name: 'Loaded.esp', origin: 'ModA' }])).toEqual([]);
  });

  it('ignores non-plugin files and nested files sharing a plugin name', () => {
    // Root-level only, mirroring rootLevelWinners' own reasoning: plugins live at a mod's root, so
    // a nested file with a plugin's name is not a plugin.
    const index = indexOf({ ModA: ['readme.txt', 'Textures/Foo.dds', 'scripts/Nested.esp'] });

    expect(findPluginsOutsideLoadOrder(index, [])).toEqual([]);
  });

  it('matches the load order case-insensitively, since plugins.txt casing is not authoritative', () => {
    const index = indexOf({ ModA: ['Mixed.ESP'] });

    expect(findPluginsOutsideLoadOrder(index, [{ name: 'mixed.esp', origin: 'moda' }])).toEqual([]);
  });

  it('finds .esm and .esl plugins too', () => {
    const index = indexOf({ ModA: ['Master.esm', 'Light.esl'] });

    expect(findPluginsOutsideLoadOrder(index, []).map((p) => p.name).sort()).toEqual(['Light.esl', 'Master.esm']);
  });

  it('does not treat a bare ".esp" (no basename) as a plugin, matching isPluginFile\'s extname-based classification', () => {
    const index = indexOf({ ModA: ['.esp'] });

    expect(findPluginsOutsideLoadOrder(index, [])).toEqual([]);
  });
});
