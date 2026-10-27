import { describe, it, expect, vi } from 'vitest';
import { TreeItem, TreeItemCollapsibleState, TreeItemCheckboxState, ThemeIcon, ThemeColor, Uri, EventEmitter } from '../../test/vscodeMock';
import { fakeVscodeModule } from '../../test/mo2/fakeVscodeWatcher';

vi.mock('vscode', () => ({
  ...fakeVscodeModule(),
  TreeItem, TreeItemCollapsibleState, TreeItemCheckboxState, ThemeIcon, ThemeColor, Uri, EventEmitter,
}));

import { mastersOfPlugins } from '../mastersOfPlugins';
import { PluginNode } from '../pluginRows';
import { instanceValueFixture } from '../../test/mo2/instanceValueFixture';
import type { LoadOrderPlugin } from '../../instanceLoader/loadOrderSnapshot';

const entry = (name: string, origin: string, winning = true): LoadOrderPlugin =>
  ({ name, path: `/fixture/${origin}/${name}`, origin, line: 0, enabled: true, winning });
const row = (name: string, origin: string) => new PluginNode({ name, enabled: true }, origin);
const mastersByName = (table: Record<string, string[]>) => ({ mastersOf: ({ name }: { name: string }) => table[name] ?? [] });

describe('the plugin rows a Plugins selection\'s masters are', () => {
  const value = instanceValueFixture({
    plugins: [entry('Dep.esp', 'Alpha'), entry('Base.esm', 'Gamma', false), entry('Base.esm', 'Beta')],
  });

  it('is the row the game loads for each master\'s file name, whatever its case', () => {
    expect(mastersOfPlugins(value, mastersByName({ 'Dep.esp': ['base.ESM'] }), [row('Dep.esp', 'Alpha')]))
      .toEqual([{ name: 'Base.esm', origin: 'Beta' }]);
  });

  it('is nothing for a master no row holds', () => {
    expect(mastersOfPlugins(value, mastersByName({ 'Dep.esp': ['Ghost.esm'] }), [row('Dep.esp', 'Alpha')])).toEqual([]);
  });

  it('is nothing for a plugin with no masters read yet', () => {
    expect(mastersOfPlugins(value, mastersByName({}), [row('Dep.esp', 'Alpha')])).toEqual([]);
  });

  it('is nothing for rows of any other kind', () => {
    expect(mastersOfPlugins(value, mastersByName({}), [{ kind: 'record' }, 'a string'])).toEqual([]);
  });

  it('includes a master the game loads with no line', () => {
    const loose = instanceValueFixture({
      plugins: [entry('Dep.esp', 'Alpha')],
      pluginsLoadedWithNoLine: [{ name: 'Fallout4.esm', origin: 'Data/', path: '/data/Fallout4.esm' }],
    });
    expect(mastersOfPlugins(loose, mastersByName({ 'Dep.esp': ['Fallout4.esm'] }), [row('Dep.esp', 'Alpha')]))
      .toEqual([{ name: 'Fallout4.esm', origin: 'Data/' }]);
  });
});
