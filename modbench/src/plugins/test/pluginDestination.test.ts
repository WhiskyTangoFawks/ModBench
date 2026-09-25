import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { pluginPlaces, placeFolder } from '../pluginDestination';
import { instanceValueFixture } from '../../test/mo2/instanceValueFixture';
import type { LoadOrderPlugin } from '../../instanceLoader/loadOrderSnapshot';

const plugin = (name: string, origin: string, path: string): LoadOrderPlugin =>
  ({ name, origin, path, slot: null, enabled: false, winning: true });

const value = instanceValueFixture({
  mods: [
    { kind: 'mod', name: 'Winning Mod', enabled: true },
    { kind: 'separator', name: 'Patches', enabled: true },
    { kind: 'mod', name: 'Disabled Mod', enabled: false },
    { kind: 'mod', name: 'Losing Mod', enabled: true },
  ],
  plugins: [
    plugin('Held.esp', 'Losing Mod', join('/instance', 'mods', 'Losing Mod', 'Held.esp')),
    plugin('Other.esp', 'overwrite', join('/instance', 'overwrite', 'Other.esp')),
  ],
  paths: {
    overwriteDir: join('/instance', 'overwrite'),
    downloadsDir: join('/instance', 'downloads'),
    modDirs: new Map([
      ['Winning Mod', join('/instance', 'mods', 'Winning Mod')],
      ['Disabled Mod', join('/instance', 'mods', 'Disabled Mod')],
      ['Losing Mod', join('/instance', 'mods', 'Losing Mod')],
    ]),
  },
});

describe('pluginPlaces', () => {
  it('lists Overwrite first, then the enabled mods, and no separator or disabled mod', () => {
    expect(pluginPlaces(value, 'New.esp').map((p) => p.origin)).toEqual(['overwrite', 'Winning Mod', 'Losing Mod']);
  });

  // Rival: checking the name across the whole load order, which would leave out every place once
  // any of them held it.
  it('leaves out only a place that already holds a plugin of that name, whatever its case', () => {
    expect(pluginPlaces(value, 'held.ESP').map((p) => p.origin)).toEqual(['overwrite', 'Winning Mod']);
    expect(pluginPlaces(value, 'Other.esp').map((p) => p.origin)).toEqual(['Winning Mod', 'Losing Mod']);
  });
});

describe('placeFolder', () => {
  it("answers Overwrite's folder and an enabled mod's folder as the value names them", () => {
    expect(placeFolder(value, 'overwrite')).toBe(join('/instance', 'overwrite'));
    expect(placeFolder(value, 'Winning Mod')).toBe(join('/instance', 'mods', 'Winning Mod'));
  });

  // Rival: joining mods/<name> here, which answers a folder for a mod the value does not list.
  it('answers nothing for a mod the value does not list, or does not enable', () => {
    expect(placeFolder(value, 'Uninstalled')).toBeUndefined();
    expect(placeFolder(value, 'Disabled Mod')).toBeUndefined();
  });
});
