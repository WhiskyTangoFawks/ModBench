import { describe, it, expect } from 'vitest';
import type { Mod, Separator } from '../../instanceLoader/instance';
import type { ModlistEntry } from '../../instanceAdapter/instanceAdapter';
import type { LoadOrderPlugin } from '../../instanceLoader/loadOrderSnapshot';
import { TreeItem, TreeItemCollapsibleState, TreeItemCheckboxState, ThemeIcon, ThemeColor, Uri, EventEmitter } from '../../test/vscodeMock';
import { vi } from 'vitest';
import { fakeVscodeModule } from '../../test/mo2/fakeVscodeWatcher';

vi.mock('vscode', () => ({
  ...fakeVscodeModule(),
  TreeItem, TreeItemCollapsibleState, TreeItemCheckboxState, ThemeIcon, ThemeColor, Uri, EventEmitter,
}));

import { pluginsHeld } from '../pluginsHeld';
import { ModNode, OverwriteNode, SeparatorNode } from '../ModListProvider';
import { FileNode } from '../modFiles';
import { instanceValueFixture } from '../../test/mo2/instanceValueFixture';
import { file } from './indexedValue';

const mod = (name: string, enabled = true): Mod => ({ kind: 'mod', name, enabled });
const sep = (name: string): Separator => ({ kind: 'separator', name, enabled: false });
const plugin = (name: string, origin: string, winning = true): LoadOrderPlugin =>
  ({ name, origin, path: `/${origin}/${name}`, line: 0, enabled: true, winning });

function scene(mods: ModlistEntry[], files: Record<string, string[]>, plugins: LoadOrderPlugin[], overwrite: string[] = []) {
  return instanceValueFixture({
    mods, plugins,
    filesByMod: new Map(Object.entries(files).map(([name, paths]) => [name, paths.map((p) => file(name, p))])),
    overwriteFiles: overwrite.map((p) => file('overwrite', p)),
  });
}

const addresses = (held: { name: string; origin: string }[]) => held.map(({ name, origin }) => `${name}@${origin}`);

describe('the plugins a Mods selection holds', () => {
  it('a mod holds each plugin its files hold', () => {
    const value = scene([mod('A')], { A: ['A.esp', 'textures/x.dds'] }, [plugin('A.esp', 'A')]);

    expect(addresses(pluginsHeld(value, [new ModNode(mod('A'))]))).toEqual(['A.esp@A']);
  });

  it('an overridden plugin highlights the row of the plugin that overrides it', () => {
    const value = scene([mod('Low'), mod('High')], { Low: ['Shared.esp'], High: ['Shared.esp'] },
      [plugin('Shared.esp', 'Low', false), plugin('Shared.esp', 'High')]);

    expect(addresses(pluginsHeld(value, [new ModNode(mod('Low'))]))).toEqual(['Shared.esp@High']);
  });

  it('a name matches whatever its case', () => {
    const value = scene([mod('A')], { A: ['a.ESP'] }, [plugin('A.esp', 'A')]);

    expect(addresses(pluginsHeld(value, [new ModNode(mod('A'))]))).toEqual(['A.esp@A']);
  });

  it('a disabled mod holds nothing', () => {
    const value = scene([mod('A', false)], { A: ['A.esp'] }, [plugin('A.esp', 'A', false)]);

    expect(pluginsHeld(value, [new ModNode(mod('A', false))])).toEqual([]);
  });

  it('a nested file named like a plugin is no plugin', () => {
    const value = scene([mod('A')], { A: ['meshes/A.esp'] }, [plugin('A.esp', 'B')]);

    expect(pluginsHeld(value, [new ModNode(mod('A'))])).toEqual([]);
  });

  it('Overwrite holds the plugins in its folder', () => {
    const value = scene([], {}, [plugin('Out.esp', 'overwrite/')], ['Out.esp']);

    expect(addresses(pluginsHeld(value, [new OverwriteNode(value.overwriteFiles, 'MO2')]))).toEqual(['Out.esp@overwrite/']);
  });

  it('a separator holds what its enabled mods hold, whether its row is open or collapsed', () => {
    const value = scene([mod('Off', false), mod('On'), sep('S'), mod('Elsewhere')], { Off: ['Off.esp'], On: ['On.esp'], Elsewhere: ['E.esp'] },
      [plugin('On.esp', 'On'), plugin('E.esp', 'Elsewhere')]);
    const separator = value.modGroups.groups[0]!;

    for (const shown of ['all', 'matching'] as const) {
      expect(addresses(pluginsHeld(value, [new SeparatorNode(separator.separator, [], shown)]))).toEqual(['On.esp@On']);
    }
  });

  it('rows of any other kind hold nothing', () => {
    const value = scene([mod('A')], { A: ['A.esp'] }, [plugin('A.esp', 'A')]);
    const fileRow = new FileNode(new ModNode(mod('A')), { kind: 'mod', name: 'A' }, file('A', 'A.esp'), 'A.esp');

    expect(pluginsHeld(value, [fileRow, { kind: 'plugin' }])).toEqual([]);
  });
});
