import { describe, it, expect, vi } from 'vitest';
import type { Mod } from '../../instanceLoader/instance';
import { TreeItem, TreeItemCollapsibleState, TreeItemCheckboxState, ThemeIcon, ThemeColor, Uri, EventEmitter } from '../../test/vscodeMock';
import { fakeVscodeModule } from '../../test/mo2/fakeVscodeWatcher';

vi.mock('vscode', () => ({
  ...fakeVscodeModule(),
  TreeItem, TreeItemCollapsibleState, TreeItemCheckboxState, ThemeIcon, ThemeColor, Uri, EventEmitter,
}));

import { modsOfPlugins } from '../modsOfPlugins';
import { PluginNode } from '../pluginRows';
import { DATA_DIRECTORY_ORIGIN, OVERWRITE_ORIGIN } from '../../wire/pluginAddress';
import { instanceValueFixture } from '../../test/mo2/instanceValueFixture';

const mod = (name: string): Mod => ({ kind: 'mod', name, enabled: true });
const row = (name: string, origin: string) => new PluginNode({ name, enabled: true }, origin);
const value = instanceValueFixture({ mods: [mod('Alpha'), mod('Beta')] });

describe('the mods and Overwrite a Plugins selection comes from', () => {
  it('is the mod each plugin comes from', () => {
    expect(modsOfPlugins(value, [row('A.esp', 'Alpha'), row('B.esp', 'Beta')])).toEqual([
      { kind: 'mod', name: 'Alpha' }, { kind: 'mod', name: 'Beta' },
    ]);
  });

  it('is the mod as the mod list spells it, whatever the origin\'s case', () => {
    expect(modsOfPlugins(value, [row('A.esp', 'alpha')])).toEqual([{ kind: 'mod', name: 'Alpha' }]);
  });

  it('is Overwrite for a plugin Overwrite holds', () => {
    expect(modsOfPlugins(value, [row('A.esp', OVERWRITE_ORIGIN)])).toEqual([{ kind: 'runtimeOutput' }]);
  });

  it('is nothing for a plugin from the game folder, or from no listed mod', () => {
    expect(modsOfPlugins(value, [row('A.esp', DATA_DIRECTORY_ORIGIN), row('B.esp', 'Gone')])).toEqual([]);
  });

  it('is nothing for rows of any other kind', () => {
    expect(modsOfPlugins(value, [{ kind: 'record' }, 'a string'])).toEqual([]);
  });
});
