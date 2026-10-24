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

import { nexusRowInFocusedView, selectionInFocusedView } from '../inFocusedView';
import { createFocusedView } from '../focusedView';
import { FakeTreeView } from './nameFilterViewHarness';

const own = () => undefined;

beforeEach(() => { contextKeys.clear(); });

describe('view on Nexus from the palette: the row it opens and the view the palette offers it on', () => {
  const KEY = 'modbench.mod.nexusRowIn';

  it('offers it on the view whose one selected row it opens, and nowhere while that row has no Nexus id', () => {
    const focused = createFocusedView();
    const mods = new FakeTreeView();
    const downloads = new FakeTreeView();
    focused.follow('modbench.modList', mods);
    focused.follow('modbench.downloads', downloads);
    const nexusRow = nexusRowInFocusedView(own, focused, ['modbench.modList', 'modbench.downloads'], KEY);
    const nexusMod = { nexusModId: '42' };
    const nexusFile = { nexusModId: '7' };

    expect([contextKeys.get(KEY), nexusRow()]).toEqual([undefined, undefined]);
    mods.selectRows([nexusMod]);
    expect([contextKeys.get(KEY), nexusRow()]).toEqual(['modbench.modList', nexusMod]);
    downloads.selectRows([{}]);
    expect([contextKeys.get(KEY), nexusRow()]).toEqual([undefined, undefined]);
    downloads.selectRows([nexusFile]);
    expect([contextKeys.get(KEY), nexusRow()]).toEqual(['modbench.downloads', nexusFile]);
    mods.selectRows([nexusMod, { nexusModId: '43' }]);
    expect([contextKeys.get(KEY), nexusRow()]).toEqual([undefined, undefined]);
  });

  it('offers it on no view the focus has left for one it does not name', () => {
    const focused = createFocusedView();
    const mods = new FakeTreeView();
    const plugins = new FakeTreeView();
    focused.follow('modbench.modList', mods);
    focused.follow('modbench.pluginListTree', plugins);
    const nexusRow = nexusRowInFocusedView(own, focused, ['modbench.modList'], KEY);

    mods.selectRows([{ nexusModId: '42' }]);
    plugins.selectRows([{ nexusModId: '9' }]);

    expect([contextKeys.get(KEY), nexusRow()]).toEqual([undefined, undefined]);
  });
});

describe('a palette gesture two views offer: the selection of the focused view', () => {
  const KEY = 'modbench.mod.sourceGestureRowsIn';
  const VIEWS = ['modbench.modList', 'modbench.pluginListTree'];

  it('takes the selection of the view last selected in, and names that view in its key', () => {
    const focused = createFocusedView();
    const mods = new FakeTreeView();
    const plugins = new FakeTreeView();
    focused.follow('modbench.modList', mods);
    focused.follow('modbench.pluginListTree', plugins);
    const selection = selectionInFocusedView(own, focused, VIEWS, KEY);

    expect([contextKeys.get(KEY), selection()]).toEqual([undefined, []]);
    mods.selectRows(['ModA', 'ModB']);
    expect([contextKeys.get(KEY), selection()]).toEqual(['modbench.modList', ['ModA', 'ModB']]);
    plugins.selectRows(['First.esp']);
    expect([contextKeys.get(KEY), selection()]).toEqual(['modbench.pluginListTree', ['First.esp']]);
  });

  it('has no selection and names no view while the focus is in a view it is not offered on', () => {
    const focused = createFocusedView();
    const mods = new FakeTreeView();
    const downloads = new FakeTreeView();
    focused.follow('modbench.modList', mods);
    focused.follow('modbench.downloads', downloads);
    const selection = selectionInFocusedView(own, focused, VIEWS, KEY);

    mods.selectRows(['ModA']);
    downloads.selectRows(['archive.7z']);

    expect([contextKeys.get(KEY), selection()]).toEqual([undefined, []]);
  });
});
