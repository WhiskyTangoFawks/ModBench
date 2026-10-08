import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { holdsPlugin, pluginPlaces, placeFolder } from '../pluginPlaces';
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
    plugin('Other.esp', 'overwrite/', join('/instance', 'overwrite', 'Other.esp')),
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
  it('lists the enabled mods first, then Overwrite, and no separator or disabled mod', () => {
    expect(pluginPlaces(value, 'New.esp').map((p) => p.origin)).toEqual(['Winning Mod', 'Losing Mod', 'overwrite/']);
  });

  it('leaves out only a place that already holds a plugin of that name, whatever its case', () => {
    expect(pluginPlaces(value, 'held.ESP').map((p) => p.origin)).toEqual(['Winning Mod', 'overwrite/']);
    expect(pluginPlaces(value, 'Other.esp').map((p) => p.origin)).toEqual(['Winning Mod', 'Losing Mod']);
  });
});

describe('holdsPlugin', () => {
  it('holds a plugin of that name in that origin, whatever its case, and not the same name in another origin', () => {
    expect(holdsPlugin(value, { name: 'held.ESP', origin: 'Losing Mod' })).toBe(true);
    expect(holdsPlugin(value, { name: 'Held.esp', origin: 'Winning Mod' })).toBe(false);
    expect(holdsPlugin(value, { name: 'Gone.esp', origin: 'Losing Mod' })).toBe(false);
  });
});

describe('placeFolder', () => {
  it("answers Overwrite's folder and an enabled mod's folder as the value names them", () => {
    expect(placeFolder(value, 'overwrite/')).toEqual({ folder: join('/instance', 'overwrite') });
    expect(placeFolder(value, 'Winning Mod')).toEqual({ folder: join('/instance', 'mods', 'Winning Mod') });
  });

  it('answers a mod the value does not list as gone', () => {
    expect(placeFolder(value, 'Uninstalled')).toEqual({ lost: 'gone' });
  });

  it('answers a mod the value lists but does not enable as disabled', () => {
    expect(placeFolder(value, 'Disabled Mod')).toEqual({ lost: 'disabled' });
  });

  it('answers Overwrite as unread while the value names no folder for it', () => {
    const unread = instanceValueFixture({ paths: { ...value.paths, overwriteDir: undefined } });
    expect(placeFolder(unread, 'overwrite/')).toEqual({ lost: 'unread' });
  });
});
