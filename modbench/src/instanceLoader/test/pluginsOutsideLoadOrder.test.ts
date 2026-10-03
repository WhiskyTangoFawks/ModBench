import { describe, it, expect } from 'vitest';
import { FileConflictLookup, type FileConflictIndex } from '../fileConflictIndex';
import type { OriginFile } from '../../instanceAdapter/instanceAdapter';
import { findPluginsOutsideLoadOrder } from '../pluginsOutsideLoadOrder';

function toFileMap(byMod: Record<string, string[]>): Map<string, OriginFile[]> {
  return new Map(
    Object.entries(byMod).map(([mod, paths]) => [
      mod,
      paths.map((relativePath) => ({ relativePath, path: `/mods/${mod}/${relativePath}`, sourcePath: `/mods/${mod}/${relativePath}`, excluded: false })),
    ]),
  );
}

function indexOf(filesByMod: Record<string, string[]>): FileConflictIndex {
  return { files: new FileConflictLookup(), filesByMod: toFileMap(filesByMod), foldersByMod: new Map() };
}

describe('findPluginsOutsideLoadOrder — the plugin files the effective load order does not point at: an overridden plugin, or a file plugins.txt never names', () => {
  it('finds the plugin a winning mod overrides', () => {
    const index = indexOf({ Winner: ['Shared.esp'], Loser: ['Shared.esp'] });

    const found = findPluginsOutsideLoadOrder(index, [{ name: 'Shared.esp', origin: 'Winner' }]);

    expect(found).toEqual([
      { name: 'Shared.esp', path: '/mods/Loser/Shared.esp', origin: 'Loser' },
    ]);
  });

  it('names a linked plugin by where it is read from, the link\'s target', () => {
    const linked = { relativePath: 'Linked.esp', path: '/mods/ModA/Linked.esp', sourcePath: '/shared/Real.esp', excluded: false };
    const index: FileConflictIndex = { files: new FileConflictLookup(), filesByMod: new Map([['ModA', [linked]]]), foldersByMod: new Map() };

    expect(findPluginsOutsideLoadOrder(index, [])).toEqual([{ name: 'Linked.esp', path: '/shared/Real.esp', origin: 'ModA' }]);
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

  it('ignores non-plugin files and nested files sharing a plugin name, plugins living at a mod\'s root only', () => {
    const index = indexOf({ ModA: ['readme.txt', 'Textures/Foo.dds', 'scripts/Nested.esp'] });

    expect(findPluginsOutsideLoadOrder(index, [])).toEqual([]);
  });

  it('matches the load order case-insensitively, since plugins.txt casing is not authoritative', () => {
    const index = indexOf({ ModA: ['Mixed.ESP'] });

    expect(findPluginsOutsideLoadOrder(index, [{ name: 'mixed.esp', origin: 'moda' }])).toEqual([]);
  });

  it('never mistakes one (origin, filename) pair for another whose halves join to the same text, with a character a Linux folder or file name may hold', () => {
    const index = indexOf({ 'A|B': ['C.esp'] });

    expect(findPluginsOutsideLoadOrder(index, [{ name: 'B|C.esp', origin: 'A' }]).map((p) => p.origin)).toEqual(['A|B']);
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
