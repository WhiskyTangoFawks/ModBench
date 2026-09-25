import { describe, it, expect, vi } from 'vitest';
import { TreeItem, TreeItemCollapsibleState, TreeItemCheckboxState, ThemeIcon } from '../../test/vscodeMock';

const { registerCommand } = vi.hoisted(() => ({
  registerCommand: vi.fn((_id: string, handler: (...args: unknown[]) => unknown) => ({ dispose: vi.fn(), handler })),
}));

vi.mock('vscode', () => ({
  commands: { registerCommand },
  TreeItem, TreeItemCollapsibleState, TreeItemCheckboxState, ThemeIcon,
}));

import {
  PLUGINS_KEY_ARGS, pluralArgument, registerPluginsGesture, selectionArgument, singularArgument, type GestureEntry,
} from '../gestureEntry';
import { ImplicitMasterNode, PluginNode, type PluginsTreeNode } from '../PluginsTreeProvider';

const pluginRow = (name: string, origin?: string) => new PluginNode({ name, enabled: true }, origin);
const lockedRow = (name: string) => new ImplicitMasterNode(name);

// VS Code's own calling convention: a context menu passes the right-clicked row, and the
// selection only when several rows are selected and the right-clicked row is among them. A key
// and the palette pass nothing.
function entryWhenInvoked(viewSelection: readonly PluginsTreeNode[], ...args: unknown[]): GestureEntry {
  let received: GestureEntry | undefined;
  const disposable = registerPluginsGesture('modbench.test.gesture', () => viewSelection, (entry) => { received = entry; });
  const call = registerCommand.mock.calls.at(-1);
  if (!call || call[0] !== 'modbench.test.gesture') throw new Error('the gesture registered no command');
  call[1](...args);
  disposable.dispose();
  if (!received) throw new Error('the gesture was not run');
  return received;
}

describe('what VS Code hands a Plugins gesture becomes its entry', () => {
  const alpha = pluginRow('Alpha.esp');
  const beta = pluginRow('Beta.esp');
  const gamma = pluginRow('Gamma.esp');

  it('a right-click inside a multi-selection gives a plural gesture the selection', () => {
    const entry = entryWhenInvoked([alpha, beta], beta, [alpha, beta]);
    expect(pluralArgument(entry, 'plugin')).toEqual([alpha, beta]);
  });

  it('a right-click outside the selection gives a plural gesture the right-clicked row alone', () => {
    const entry = entryWhenInvoked([alpha, beta], gamma, undefined);
    expect(pluralArgument(entry, 'plugin')).toEqual([gamma]);
  });

  it('a right-click gives a singular gesture the right-clicked row', () => {
    const entry = entryWhenInvoked([alpha, beta], beta, [alpha, beta]);
    expect(singularArgument(entry, 'plugin')).toBe(beta);
  });

  it('the palette gives a plural gesture the view\'s selection', () => {
    const entry = entryWhenInvoked([alpha, gamma]);
    expect(pluralArgument(entry, 'plugin')).toEqual([alpha, gamma]);
  });

  // A keybinding with no args of its own is invoked with null (VS Code 1.24 release notes).
  it('a key gives a plural gesture the view\'s selection', () => {
    const entry = entryWhenInvoked([beta, gamma], null);
    expect(pluralArgument(entry, 'plugin')).toEqual([beta, gamma]);
  });

  it('the palette gives a singular gesture the one selected row', () => {
    const entry = entryWhenInvoked([alpha]);
    expect(singularArgument(entry, 'plugin')).toBe(alpha);
  });

  it('the palette gives a singular gesture nothing while several rows are selected', () => {
    const entry = entryWhenInvoked([alpha, beta]);
    expect(singularArgument(entry, 'plugin')).toBeUndefined();
  });

  it('a key\'s own args give a plural gesture the view\'s selection, not the args', () => {
    const entry = entryWhenInvoked([beta, gamma], PLUGINS_KEY_ARGS);
    expect(pluralArgument(entry, 'plugin')).toEqual([beta, gamma]);
  });

  it('a key\'s own args give a singular gesture the one selected row', () => {
    const entry = entryWhenInvoked([gamma], PLUGINS_KEY_ARGS);
    expect(singularArgument(entry, 'plugin')).toBe(gamma);
  });

  it('fired from a key with one row selected, gives a plural gesture that one row', () => {
    const entry = entryWhenInvoked([beta], null);
    expect(pluralArgument(entry, 'plugin')).toEqual([beta]);
  });
});

describe('a plural Plugins gesture\'s Argument', () => {
  const alpha = pluginRow('Alpha.esp');
  const beta = pluginRow('Beta.esp');
  const gamma = pluginRow('Gamma.esp');

  it('is the whole selection from a context menu', () => {
    expect(pluralArgument({ clicked: beta, selection: [alpha, beta, gamma] }, 'plugin')).toEqual([alpha, beta, gamma]);
  });

  it('is the whole selection from a key', () => {
    expect(pluralArgument({ focused: gamma, selection: [alpha, beta, gamma] }, 'plugin')).toEqual([alpha, beta, gamma]);
  });

  it('is the whole selection from the palette', () => {
    expect(pluralArgument({ selection: [alpha, beta, gamma] }, 'plugin')).toEqual([alpha, beta, gamma]);
  });

  it('is nothing with no row and no selection', () => {
    expect(pluralArgument({ selection: [] }, 'plugin')).toEqual([]);
  });
});

describe('the locked rows (a plugin the game loads with no line) never carry the Argument', () => {
  const alpha = pluginRow('Alpha.esp');
  const locked = lockedRow('Fallout4.esm');

  it('a plural gesture drops a locked row from a mixed selection', () => {
    expect(pluralArgument({ clicked: alpha, selection: [locked, alpha] }, 'plugin')).toEqual([alpha]);
  });

  it('selectionArgument drops a locked row from a mixed selection too', () => {
    expect(selectionArgument({ clicked: alpha, selection: [locked, alpha] }, 'plugin')).toEqual([alpha]);
  });

  it('a singular gesture right-clicked on a locked row takes nothing', () => {
    expect(singularArgument({ clicked: locked, selection: [locked] }, 'plugin')).toBeUndefined();
  });
});

describe('selectionArgument over a Plugins selection', () => {
  const alpha = pluginRow('Alpha.esp');
  const beta = pluginRow('Beta.esp');

  it('keeps every selected row of the kinds given, regardless of the right-clicked row\'s kind', () => {
    expect(selectionArgument({ clicked: beta, selection: [alpha, beta] }, 'plugin')).toEqual([alpha, beta]);
  });

  it('keeps every selected row of the kinds given for a key or the palette too', () => {
    expect(selectionArgument({ focused: beta, selection: [alpha, beta] }, 'plugin')).toEqual([alpha, beta]);
    expect(selectionArgument({ selection: [alpha, beta] }, 'plugin')).toEqual([alpha, beta]);
  });
});

describe('a singular Plugins gesture\'s Argument', () => {
  const alpha = pluginRow('Alpha.esp');
  const beta = pluginRow('Beta.esp');
  const gamma = pluginRow('Gamma.esp');

  it('is the right-clicked row, not the selection around it', () => {
    expect(singularArgument({ clicked: beta, selection: [alpha, beta, gamma] }, 'plugin')).toBe(beta);
  });

  it('is the focused row when reached by a key', () => {
    expect(singularArgument({ focused: gamma, selection: [alpha, beta, gamma] }, 'plugin')).toBe(gamma);
  });

  it('is nothing with no right-clicked or focused row', () => {
    expect(singularArgument({ selection: [] }, 'plugin')).toBeUndefined();
  });
});
