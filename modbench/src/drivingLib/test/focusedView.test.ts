import { describe, it, expect } from 'vitest';
import { createFocusedView } from '../focusedView';
import { fakeView } from './selectableViewDouble';

describe('the focused view', () => {
  it('is none until a view is selected in or entered', () => {
    expect(createFocusedView().id()).toBeUndefined();
  });

  it('is the followed view last selected in', () => {
    const focused = createFocusedView();
    const mods = fakeView();
    const plugins = fakeView();
    focused.follow('modbench.modList', mods);
    focused.follow('modbench.pluginListTree', plugins);
    mods.select(['ModA']);
    expect(focused.id()).toBe('modbench.modList');
    plugins.select(['First.esp']);
    expect(focused.id()).toBe('modbench.pluginListTree');
  });

  it('has the selection of the followed view last selected in, and none once a surface outside the trees is entered', () => {
    const focused = createFocusedView();
    const mods = fakeView();
    const plugins = fakeView();
    focused.follow('modbench.modList', mods);
    focused.follow('modbench.pluginListTree', plugins);
    expect(focused.selection()).toEqual([]);
    mods.select(['ModA']);
    plugins.select(['First.esp']);
    mods.select(['ModB']);
    expect(focused.selection()).toEqual(['ModB']);
    focused.enter('modbench.recordGrid');
    expect(focused.selection()).toEqual([]);
  });

  it('tells a listener the focused view and its selection each time they change', () => {
    const focused = createFocusedView();
    const mods = fakeView();
    focused.follow('modbench.modList', mods);
    const told: [string | undefined, readonly unknown[]][] = [];
    focused.onDidChange((id) => told.push([id, focused.selection()]));

    mods.select(['ModA']);
    focused.enter('modbench.recordGrid');

    expect(told).toEqual([['modbench.modList', ['ModA']], ['modbench.recordGrid', []]]);
  });

  it('is a surface outside the trees from the moment it is entered, until a tree is selected in again', () => {
    const focused = createFocusedView();
    const mods = fakeView();
    focused.follow('modbench.modList', mods);
    mods.select(['ModA']);
    focused.enter('modbench.recordGrid');
    expect(focused.id()).toBe('modbench.recordGrid');
    mods.select(['ModB']);
    expect(focused.id()).toBe('modbench.modList');
  });
});
