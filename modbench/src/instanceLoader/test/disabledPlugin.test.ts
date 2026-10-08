import { describe, it, expect } from 'vitest';
import { isDisabledOrInDisabledMod } from '../disabledPlugin';
import type { LoadOrderPlugin } from '../loadOrderSnapshot';
import type { Mod } from '../instance';

const mod = (name: string, enabled: boolean): Mod => ({ kind: 'mod', name, enabled });
const row = (over: Partial<LoadOrderPlugin>): LoadOrderPlugin =>
  ({ name: 'A.esp', path: '/mods/ModA/A.esp', origin: 'ModA', line: 0, enabled: true, winning: true, ...over });
const A = { name: 'A.esp', origin: 'ModA' };

const disabled = (mods: Mod[], plugins: LoadOrderPlugin[], pluginsLoadedWithNoLine: { name: string; origin: string }[] = []) =>
  isDisabledOrInDisabledMod({ mods, plugins, pluginsLoadedWithNoLine }, A);

describe('a plugin disabled, or in a disabled mod', () => {
  it('is one whose line is disabled', () => {
    expect(disabled([mod('ModA', true)], [row({ enabled: false })])).toBe(true);
  });

  it('is one no line names', () => {
    expect(disabled([mod('ModA', true)], [row({ line: null, enabled: false })])).toBe(true);
  });

  it('is one in a disabled mod, though an enabled line names its filename', () => {
    expect(disabled([mod('moda', false)], [row({ winning: false })])).toBe(true);
  });

  it('is not an overridden one, whose enabled line another mod\'s file of its name answers', () => {
    expect(disabled([mod('ModA', true)], [row({ winning: false })])).toBe(false);
  });

  it('is not an active one', () => {
    expect(disabled([mod('ModA', true)], [row({})])).toBe(false);
  });

  it('is not one the game loads with no line', () => {
    expect(disabled([mod('ModA', true)], [row({ line: null, enabled: false })], [A])).toBe(false);
  });

  it('is not one the instance does not list', () => {
    expect(disabled([], [])).toBe(false);
  });
});
