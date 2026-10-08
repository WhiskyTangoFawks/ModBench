import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { pluginSyncArgumentsOf } from '../syncArguments';
import { FileConflictLookup, modOrigin, type ConflictEntry } from '../fileConflictIndex';
import { instanceValueFixture } from '../../test/mo2/instanceValueFixture';

const winners = (...entries: ConflictEntry[]): FileConflictLookup => {
  const lookup = new FileConflictLookup();
  for (const entry of entries) lookup.set(entry);
  return lookup;
};

describe('pluginSyncArgumentsOf', () => {
  it('hands plugin sync the active profile, the plugin order read, the plugins the instance provides, the Data folder and the plugins the game loads with no line', () => {
    const pluginOrder = [{ name: 'Mine.esp', enabled: true }];
    const value = instanceValueFixture({
      activeProfile: 'Survival',
      gameName: 'Skyrim Special Edition',
      gameRelease: 'SkyrimSE',
      gameFolder: { kind: 'found', root: '/game', dataFolder: '/game/Data' },
      dataFolderPlugins: { kind: 'listed', names: new Set(['skyrim.esm']) },
      pluginsLoadedWithNoLine: [{ name: 'Skyrim.esm', origin: 'Data/' }],
      files: winners({
        relativePath: 'Mine.esp', winner: join('/instance', 'mods', 'My Mod', 'Mine.esp'), winnerOrigin: modOrigin('My Mod'),
        providers: [modOrigin('My Mod')],
      }),
    });

    expect(pluginSyncArgumentsOf({ ...value, pluginOrder })).toEqual({
      profile: 'Survival',
      pluginOrder: [{ name: 'Mine.esp', enabled: true }],
      provided: new Map([['mine.esp', 'Mine.esp']]),
      inData: { kind: 'listed', names: new Set(['skyrim.esm']) },
      loadedWithNoLine: ['Skyrim.esm'],
    });
  });
});
