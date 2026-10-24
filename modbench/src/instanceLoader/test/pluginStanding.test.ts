import { describe, it, expect } from 'vitest';
import { pluginOriginName, pluginStanding, type PluginStanding } from '../pluginStanding';
import type { LoadOrderPlugin } from '../loadOrderSnapshot';
import type { Mod } from '../instance';

const mod = (name: string, enabled = true): Mod => ({ kind: 'mod', name, enabled });
const row = (over: Partial<LoadOrderPlugin>): LoadOrderPlugin =>
  ({ name: 'A.esp', path: '/mods/ModA/A.esp', origin: 'ModA', line: 0, enabled: true, winning: true, ...over });
const A = { name: 'A.esp', origin: 'ModA' };

describe('a plugin\'s standing', () => {
  it.each<[string, Mod[], LoadOrderPlugin[], PluginStanding]>([
    ['overridden by the mod whose enabled file wins its filename', [mod('ModA'), mod('ModB')], [row({ winning: false }), row({ origin: 'ModB' })], { kind: 'overridden', by: 'ModB' }],
    ['overridden by Overwrite, named as the Mods view names it', [mod('ModA')], [row({ winning: false }), row({ origin: 'overwrite/' })], { kind: 'overridden', by: 'Overwrite' }],
    ['overridden by the game folder, named so, when the Data copy wins', [mod('ModA')], [row({ winning: false }), row({ origin: 'Data/' })], { kind: 'overridden', by: 'the game folder' }],
    ['enabled for the plugin that wins', [mod('ModA'), mod('ModB')], [row({}), row({ origin: 'ModB', winning: false })], { kind: 'enabled' }],
    ['enabled for a plugin the instance does not list', [], [], { kind: 'enabled' }],
    ['disabled when the filename\'s line is disabled, though a file wins it', [mod('ModA'), mod('ModB')], [row({ winning: false, enabled: false }), row({ origin: 'ModB', enabled: false })], { kind: 'disabled' }],
  ])('is %s', (_case, mods, plugins, expected) => {
    expect(pluginStanding({ mods, plugins, pluginsLoadedWithNoLine: [], entryKey: ({ name }) => name.toLowerCase() }, A)).toEqual(expected);
  });
});

describe('a plugin\'s origin as the user reads it', () => {
  it.each([
    ['Data/', 'the game folder'],
    ['overwrite/', 'Overwrite'],
    ['SomeMod', 'SomeMod'],
    ['Data', 'Data'],
    ['overwrite', 'overwrite'],
  ])('%s as %s', (origin, named) => {
    expect(pluginOriginName(origin)).toBe(named);
  });
});
