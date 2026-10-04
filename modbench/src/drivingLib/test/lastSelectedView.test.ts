import { describe, it, expect, vi, beforeEach } from 'vitest';

const { contextKeys } = vi.hoisted(() => ({ contextKeys: new Map<string, unknown>() }));

vi.mock('vscode', () => ({
  commands: {
    executeCommand: (command: string, ...args: unknown[]) => {
      if (command === 'setContext' && typeof args[0] === 'string') contextKeys.set(args[0], args[1]);
      return Promise.resolve();
    },
  },
}));

import { lastSelectedViewSelection, nexusRowInLastSelectedView } from '../lastSelectedView';
import { fakeView } from './selectableViewDouble';

const own = () => undefined;

beforeEach(() => { contextKeys.clear(); });

describe('view on Nexus from the palette: the row it opens and the view the palette offers it on', () => {
  const KEY = 'modbench.mod.nexusRowIn';

  it('offers it on the view whose one selected row it opens, and nowhere while that row has no Nexus id', () => {
    const mods = fakeView();
    const downloads = fakeView();
    const nexusRow = nexusRowInLastSelectedView(own, [
      { id: 'modbench.modList', view: mods }, { id: 'modbench.downloads', view: downloads },
    ]);
    const nexusMod = { nexusModId: '42' };
    const nexusFile = { nexusModId: '7' };

    expect([contextKeys.get(KEY), nexusRow()]).toEqual([undefined, undefined]);
    mods.select([nexusMod]);
    expect([contextKeys.get(KEY), nexusRow()]).toEqual(['modbench.modList', nexusMod]);
    downloads.select([{}]);
    expect([contextKeys.get(KEY), nexusRow()]).toEqual([undefined, undefined]);
    downloads.select([nexusFile]);
    expect([contextKeys.get(KEY), nexusRow()]).toEqual(['modbench.downloads', nexusFile]);
    mods.select([nexusMod, { nexusModId: '43' }]);
    expect([contextKeys.get(KEY), nexusRow()]).toEqual([undefined, undefined]);
  });
});

describe('a palette gesture two views offer: the selection of the view last selected in', () => {
  const KEY = 'modbench.mod.trackRowsIn';

  it('takes the selection of the view last selected in, and names that view in its key', () => {
    const mods = fakeView();
    const plugins = fakeView();
    const selection = lastSelectedViewSelection(own, [
      { id: 'modbench.modList', view: mods }, { id: 'modbench.pluginListTree', view: plugins },
    ], KEY);

    expect([contextKeys.get(KEY), selection()]).toEqual([undefined, []]);
    mods.select(['ModA', 'ModB']);
    expect([contextKeys.get(KEY), selection()]).toEqual(['modbench.modList', ['ModA', 'ModB']]);
    plugins.select(['First.esp']);
    expect([contextKeys.get(KEY), selection()]).toEqual(['modbench.pluginListTree', ['First.esp']]);
  });
});
