import { describe, it, expect } from 'vitest';
import { pluginStanding } from '../pluginStanding';
import type { LoadOrderPlugin } from '../loadOrderSnapshot';
import { OVERWRITE_ORIGIN } from '../loadOrderSnapshot';
import type { Mod } from '../instance';

const mod = (name: string, enabled = true): Mod => ({ kind: 'mod', name, enabled });
const row = (over: Partial<LoadOrderPlugin>): LoadOrderPlugin =>
  ({ name: 'A.esp', path: '/mods/ModA/A.esp', origin: 'ModA', line: 0, enabled: true, winning: true, ...over });
const A = { name: 'A.esp', origin: 'ModA' };
const standing = (mods: Mod[], plugins: LoadOrderPlugin[]) => pluginStanding({ mods, plugins, pluginsLoadedWithNoLine: [] }, A);

describe('a plugin\'s standing', () => {
  it('is overridden by the mod, named as the instance spells it, whose enabled file wins its filename', () => {
    expect(standing([mod('ModA'), mod('Mod B')], [row({ winning: false }), row({ origin: 'mod b' })])).toEqual({ kind: 'overridden', by: 'Mod B' });
  });

  it('is overridden by Overwrite, named as the Mods view names it, not by its origin key', () => {
    expect(standing([mod('ModA')], [row({ winning: false }), row({ origin: OVERWRITE_ORIGIN })])).toEqual({ kind: 'overridden', by: 'Overwrite' });
  });

  it('is enabled for the plugin that wins', () => {
    expect(standing([mod('ModA'), mod('ModB')], [row({}), row({ origin: 'ModB', winning: false })])).toEqual({ kind: 'enabled' });
  });

  it('is enabled for a plugin the instance does not list', () => {
    expect(standing([], [])).toEqual({ kind: 'enabled' });
  });

  it('is disabled when the filename\'s line is disabled, though a file wins it', () => {
    expect(standing([mod('ModA'), mod('ModB')], [row({ winning: false, enabled: false }), row({ origin: 'ModB', enabled: false })]))
      .toEqual({ kind: 'disabled' });
  });

  it('is disabled in a disabled mod, though another mod\'s file wins its filename', () => {
    expect(standing([mod('ModA', false), mod('ModB')], [row({ winning: false }), row({ origin: 'ModB' })])).toEqual({ kind: 'disabled' });
  });
});
