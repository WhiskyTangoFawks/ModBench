import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { pluginSyncArgumentsOf } from '../syncArguments';
import { instanceValueFixture } from '../../test/mo2/instanceValueFixture';

describe('pluginSyncArgumentsOf', () => {
  it('hands plugin sync the active profile, the plugins the instance provides, the Data folder and the plugins the game loads with no line', () => {
    const value = instanceValueFixture({
      activeProfile: 'Survival',
      gameName: 'Skyrim Special Edition',
      gameRelease: 'SkyrimSE',
      gameFolder: { kind: 'found', root: '/game', dataFolder: '/game/Data' },
      dataFolderPlugins: { kind: 'listed', names: new Set(['skyrim.esm']) },
      pluginsLoadedWithNoLine: [{ name: 'Skyrim.esm', origin: 'Data' }],
      plugins: [
        { name: 'Mine.esp', path: join('/instance', 'mods', 'My Mod', 'Mine.esp'), origin: 'My Mod', slot: 0, enabled: true, winning: true },
        { name: 'Skyrim.esm', path: join('/game', 'Data', 'Skyrim.esm'), origin: 'Data', slot: 1, enabled: true, winning: true },
      ],
    });

    expect(pluginSyncArgumentsOf(value)).toEqual({
      profile: 'Survival',
      provided: new Map([['mine.esp', 'Mine.esp']]),
      inData: { kind: 'listed', names: new Set(['skyrim.esm']) },
      loadedWithNoLine: ['Skyrim.esm'],
    });
  });
});
