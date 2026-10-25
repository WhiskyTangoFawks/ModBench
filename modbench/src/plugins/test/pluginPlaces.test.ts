import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { pluginPlaces, placeFolder } from '../pluginPlaces';
import { instanceValueFixture } from '../../test/mo2/instanceValueFixture';
import type { LoadOrderPlugin } from '../../instanceLoader/loadOrderSnapshot';
import type { InstanceValue } from '../../instanceLoader/instance';

const plugin = (name: string, origin: string, path: string): LoadOrderPlugin =>
  ({ name, origin, path, line: null, enabled: false, winning: true });

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
    sourceDirs: new Map([['Winning Mod', join('/instance', 'source', 'Winning Mod')]]),
  },
});

describe('pluginPlaces', () => {
  it('leaves out only a place that already holds a plugin of that name, whatever its case', () => {
    expect(pluginPlaces(value, 'held.ESP').map((p) => p.name)).toEqual(['Winning Mod', 'overwrite/']);
    expect(pluginPlaces(value, 'Other.esp').map((p) => p.name)).toEqual(['Winning Mod', 'Losing Mod']);
  });
});

describe('placeFolder', () => {
  it("answers Overwrite's folder, an enabled mod's folder, and a source mod's source folder, as the value names them", () => {
    expect(placeFolder(value, 'overwrite/')).toEqual({ name: 'overwrite/', folder: join('/instance', 'overwrite') });
    expect(placeFolder(value, 'Winning Mod'))
      .toEqual({ name: 'Winning Mod', folder: join('/instance', 'mods', 'Winning Mod'), sourceFolder: join('/instance', 'source', 'Winning Mod') });
    expect(placeFolder(value, 'Losing Mod')).toEqual({ name: 'Losing Mod', folder: join('/instance', 'mods', 'Losing Mod') });
  });

  it('names a mod as the mod manager matches names', () => {
    expect(placeFolder(value, 'losing mod')).toEqual({ name: 'Losing Mod', folder: join('/instance', 'mods', 'Losing Mod') });
    expect(placeFolder(value, 'disabled mod')).toEqual({ lost: 'disabled' });
  });

  it.each<[string, InstanceValue, string, string]>([
    ['a mod the value does not list as gone', value, 'Uninstalled', 'gone'],
    ['a mod the value lists but does not enable as disabled', value, 'Disabled Mod', 'disabled'],
    ['Overwrite as unread while the value names no folder for it', instanceValueFixture({ paths: { ...value.paths, overwriteDir: undefined } }), 'overwrite/', 'unread'],
  ])('answers %s', (_case, instance, origin, lost) => {
    expect(placeFolder(instance, origin)).toEqual({ lost });
  });
});
