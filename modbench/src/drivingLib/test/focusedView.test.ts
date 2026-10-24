import { describe, it, expect } from 'vitest';
import { createFocusedView } from '../focusedView';
import { FakeTreeView } from './nameFilterViewHarness';

describe('the focused view', () => {
  it('is none until a view is selected in or entered', () => {
    expect(createFocusedView().id()).toBeUndefined();
  });

  it('is the followed view last selected in', () => {
    const focused = createFocusedView();
    const mods = new FakeTreeView();
    const plugins = new FakeTreeView();
    focused.follow('modbench.modList', mods);
    focused.follow('modbench.pluginListTree', plugins);
    mods.selectRows(['ModA']);
    expect(focused.id()).toBe('modbench.modList');
    plugins.selectRows(['First.esp']);
    expect(focused.id()).toBe('modbench.pluginListTree');
  });

  it('has the selection of the followed view last selected in, and none once a surface outside the trees is entered', () => {
    const focused = createFocusedView();
    const mods = new FakeTreeView();
    const plugins = new FakeTreeView();
    focused.follow('modbench.modList', mods);
    focused.follow('modbench.pluginListTree', plugins);
    expect(focused.selection()).toEqual([]);
    mods.selectRows(['ModA']);
    plugins.selectRows(['First.esp']);
    mods.selectRows(['ModB']);
    expect(focused.selection()).toEqual(['ModB']);
    focused.enter('modbench.recordGrid');
    expect(focused.selection()).toEqual([]);
  });

  it('has the selection of a followed view by its id, whichever view was selected in last', () => {
    const focused = createFocusedView();
    const mods = new FakeTreeView();
    const plugins = new FakeTreeView();
    focused.follow('modbench.modList', mods);
    focused.follow('modbench.pluginListTree', plugins);
    plugins.selectRows(['First.esp']);
    mods.selectRows(['ModB']);
    expect(focused.selectionOf('modbench.pluginListTree')).toEqual(['First.esp']);
    expect(focused.selectionOf('modbench.downloads')).toEqual([]);
  });

  it('tells a listener the focused view and its selection each time they change', () => {
    const focused = createFocusedView();
    const mods = new FakeTreeView();
    focused.follow('modbench.modList', mods);
    const told: [string | undefined, readonly unknown[]][] = [];
    focused.onDidChange((id) => told.push([id, focused.selection()]));

    mods.selectRows(['ModA']);
    focused.enter('modbench.recordGrid');

    expect(told).toEqual([['modbench.modList', ['ModA']], ['modbench.recordGrid', []]]);
  });

  it('is a surface outside the trees from the moment it is entered, until a tree is selected in again', () => {
    const focused = createFocusedView();
    const mods = new FakeTreeView();
    focused.follow('modbench.modList', mods);
    mods.selectRows(['ModA']);
    focused.enter('modbench.recordGrid');
    expect(focused.id()).toBe('modbench.recordGrid');
    mods.selectRows(['ModB']);
    expect(focused.id()).toBe('modbench.modList');
  });
});
