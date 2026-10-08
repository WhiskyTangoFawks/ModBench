import { describe, it, expect } from 'vitest';
import type { OriginFile } from '../../instanceAdapter/instanceAdapter';
import { findPluginsOutsideLoadOrder } from '../pluginsOutsideLoadOrder';

function toFileMap(byMod: Record<string, string[]>): Map<string, OriginFile[]> {
  return new Map(
    Object.entries(byMod).map(([mod, paths]) => [
      mod,
      paths.map((relativePath) => ({ relativePath, path: `/mods/${mod}/${relativePath}`, sourcePath: `/mods/${mod}/${relativePath}`, excluded: false, excludedByName: false })),
    ]),
  );
}

describe('findPluginsOutsideLoadOrder — the plugin files the effective load order does not point at: an overridden plugin, or a file plugins.txt never names', () => {
  it('finds the plugin a winning mod overrides', () => {
    const index = toFileMap({ Winner: ['Shared.esp'], Loser: ['Shared.esp'] });

    const found = findPluginsOutsideLoadOrder(index, [{ name: 'Shared.esp', origin: 'Winner' }]);

    expect(found).toEqual([
      { name: 'Shared.esp', path: '/mods/Loser/Shared.esp', origin: 'Loser' },
    ]);
  });

  it('names a linked plugin by where it is read from, the link\'s target', () => {
    const linked = { relativePath: 'Linked.esp', path: '/mods/ModA/Linked.esp', sourcePath: '/shared/Real.esp', excluded: false, excludedByName: false };
    const index = new Map([['ModA', [linked]]]);

    expect(findPluginsOutsideLoadOrder(index, [])).toEqual([{ name: 'Linked.esp', path: '/shared/Real.esp', origin: 'ModA' }]);
  });

  it('finds a plugin file the load order never names, including every plugin that shares its filename', () => {
    const index = toFileMap({ ModA: ['Optional.esp'], ModB: ['Optional.esp'] });

    const found = findPluginsOutsideLoadOrder(index, []);

    expect(found.map((p) => p.origin).sort()).toEqual(['ModA', 'ModB']);
  });

  it('ignores a plugin the load order already holds from that same mod', () => {
    const index = toFileMap({ ModA: ['Loaded.esp'] });

    expect(findPluginsOutsideLoadOrder(index, [{ name: 'Loaded.esp', origin: 'ModA' }])).toEqual([]);
  });

  it('ignores non-plugin files and nested files sharing a plugin name, plugins living at a mod\'s root only', () => {
    const index = toFileMap({ ModA: ['readme.txt', 'Textures/Foo.dds', 'scripts/Nested.esp'] });

    expect(findPluginsOutsideLoadOrder(index, [])).toEqual([]);
  });

  it('finds a file whose name differs only in case from a loaded plugin of its mod, a second plugin', () => {
    const index = toFileMap({ ModA: ['Foo.esp', 'foo.esp'] });

    expect(findPluginsOutsideLoadOrder(index, [{ name: 'Foo.esp', origin: 'ModA' }]).map((p) => p.name)).toEqual(['foo.esp']);
  });

  it('finds a file of a mod whose name differs only in case from the loaded plugin\'s mod', () => {
    const index = toFileMap({ ModA: ['Foo.esp'], moda: ['Foo.esp'] });

    expect(findPluginsOutsideLoadOrder(index, [{ name: 'Foo.esp', origin: 'ModA' }]).map((p) => p.origin)).toEqual(['moda']);
  });

  it('never mistakes one (origin, filename) pair for another whose halves join to the same text, with a character a Linux folder or file name may hold', () => {
    const index = toFileMap({ 'A|B': ['C.esp'] });

    expect(findPluginsOutsideLoadOrder(index, [{ name: 'B|C.esp', origin: 'A' }]).map((p) => p.origin)).toEqual(['A|B']);
  });

  it('finds .esm and .esl plugins too', () => {
    const index = toFileMap({ ModA: ['Master.esm', 'Light.esl'] });

    expect(findPluginsOutsideLoadOrder(index, []).map((p) => p.name).sort()).toEqual(['Light.esl', 'Master.esm']);
  });

  it('does not treat a bare ".esp" (no basename) as a plugin, matching isPluginFile\'s extname-based classification', () => {
    const index = toFileMap({ ModA: ['.esp'] });

    expect(findPluginsOutsideLoadOrder(index, [])).toEqual([]);
  });
});
