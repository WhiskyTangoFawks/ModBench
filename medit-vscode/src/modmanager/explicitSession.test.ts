import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import type { FileConflictIndex, ConflictEntry } from './fileConflictIndex';
import { buildExplicitPlugins } from './explicitSession';

function index(files: Record<string, string>): FileConflictIndex {
  const map = new Map<string, ConflictEntry>();
  for (const [rel, winner] of Object.entries(files)) {
    map.set(rel, { winner, winnerMod: 'x', providers: ['x'] });
  }
  return { files: map, filesByMod: new Map() };
}

const dataFolder = '/game/Data';

describe('buildExplicitPlugins', () => {
  it('maps enabled plugins in load order to winner paths (case-insensitive), falling back to dataFolder', async () => {
    const source = {
      readEnabledPlugins: () => Promise.resolve(['Foo.esp', 'Bar.esp', 'Fallout4.esm']),
      readModlist: () => Promise.resolve([]),
    };
    // 'bar.esp' differs in case from the plugins.txt 'Bar.esp'; a nested file of
    // the same basename must NOT be mistaken for the root plugin.
    const fakeIndex = index({
      'Foo.esp': '/mods/A/Foo.esp',
      'bar.esp': '/mods/B/bar.esp',
      'textures/Foo.esp': '/mods/C/textures/Foo.esp',
    });

    const result = await buildExplicitPlugins(source, '/instance', dataFolder, () => Promise.resolve(fakeIndex));

    expect(result).toEqual([
      { name: 'Foo.esp', path: '/mods/A/Foo.esp' },
      { name: 'Bar.esp', path: '/mods/B/bar.esp' },
      { name: 'Fallout4.esm', path: join(dataFolder, 'Fallout4.esm') },
    ]);
  });
});
