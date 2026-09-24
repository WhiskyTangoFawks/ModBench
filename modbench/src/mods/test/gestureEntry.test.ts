import { describe, it, expect, vi } from 'vitest';
import { TreeItem, TreeItemCollapsibleState, TreeItemCheckboxState, ThemeIcon } from '../../test/vscodeMock';

const { registerCommand } = vi.hoisted(() => ({
  registerCommand: vi.fn((_id: string, handler: (...args: unknown[]) => unknown) => ({ dispose: vi.fn(), handler })),
}));

vi.mock('vscode', () => ({
  commands: { registerCommand },
  TreeItem, TreeItemCollapsibleState, TreeItemCheckboxState, ThemeIcon,
}));

import { pluralArgument, registerModsGesture, singularArgument, type GestureEntry } from '../gestureEntry';
import { ModNode, SeparatorNode, type ModlistNode } from '../ModListProvider';

const modRow = (name: string) => new ModNode({ kind: 'mod', name, enabled: true });
const separatorRow = (name: string) => new SeparatorNode({ kind: 'separator', name, enabled: true }, []);

// VS Code's own calling convention: a context menu passes the right-clicked row, and the
// selection only when several rows are selected and the right-clicked row is among them. A key
// and the palette pass nothing.
function entryWhenInvoked(viewSelection: readonly ModlistNode[], ...args: unknown[]): GestureEntry {
  let received: GestureEntry | undefined;
  const disposable = registerModsGesture('modbench.test.gesture', () => viewSelection, (entry) => { received = entry; });
  const call = registerCommand.mock.calls.at(-1);
  if (!call || call[0] !== 'modbench.test.gesture') throw new Error('the gesture registered no command');
  call[1](...args);
  disposable.dispose();
  if (!received) throw new Error('the gesture was not run');
  return received;
}

describe('what VS Code hands a Mods gesture becomes its entry', () => {
  const alpha = modRow('Alpha');
  const beta = modRow('Beta');
  const gamma = modRow('Gamma');

  it('a right-click inside a multi-selection gives a plural gesture the selection', () => {
    const entry = entryWhenInvoked([alpha, beta], beta, [alpha, beta]);
    expect(pluralArgument(entry, 'mod')).toEqual([alpha, beta]);
  });

  it('a right-click outside the selection gives a plural gesture the right-clicked row alone', () => {
    const entry = entryWhenInvoked([alpha, beta], gamma, undefined);
    expect(pluralArgument(entry, 'mod')).toEqual([gamma]);
  });

  it('a right-click gives a singular gesture the right-clicked row', () => {
    const entry = entryWhenInvoked([alpha, beta], beta, [alpha, beta]);
    expect(singularArgument(entry, 'mod')).toBe(beta);
  });

  it('the palette gives a plural gesture the view\'s selection', () => {
    const entry = entryWhenInvoked([alpha, gamma]);
    expect(pluralArgument(entry, 'mod')).toEqual([alpha, gamma]);
  });

  // A keybinding with no args of its own is invoked with null (VS Code 1.24 release notes).
  it('a key gives a plural gesture the view\'s selection', () => {
    const entry = entryWhenInvoked([beta, gamma], null);
    expect(pluralArgument(entry, 'mod')).toEqual([beta, gamma]);
  });

  it('the palette gives a singular gesture nothing', () => {
    const entry = entryWhenInvoked([alpha]);
    expect(singularArgument(entry, 'mod')).toBeUndefined();
  });
});

describe('a plural Mods gesture\'s Argument', () => {
  const alpha = modRow('Alpha');
  const beta = modRow('Beta');
  const gamma = modRow('Gamma');

  it('is the whole selection from a context menu', () => {
    expect(pluralArgument({ clicked: beta, selection: [alpha, beta, gamma] }, 'mod')).toEqual([alpha, beta, gamma]);
  });

  it('is the whole selection from a key', () => {
    expect(pluralArgument({ focused: gamma, selection: [alpha, beta, gamma] }, 'mod')).toEqual([alpha, beta, gamma]);
  });

  it('is the whole selection from the palette', () => {
    expect(pluralArgument({ selection: [alpha, beta, gamma] }, 'mod')).toEqual([alpha, beta, gamma]);
  });

  it('is nothing with no row and no selection', () => {
    expect(pluralArgument({ selection: [] }, 'mod')).toEqual([]);
  });
});

describe('a selection mixing mods and separators', () => {
  const alpha = modRow('Alpha');
  const groupA = separatorRow('Group A');
  const beta = modRow('Beta');
  const groupB = separatorRow('Group B');
  const mixed = [alpha, groupA, beta, groupB];

  it('gives the rows of the right-clicked row\'s kind', () => {
    expect(pluralArgument({ clicked: beta, selection: mixed }, 'mod', 'separator')).toEqual([alpha, beta]);
    expect(pluralArgument({ clicked: groupB, selection: mixed }, 'mod', 'separator')).toEqual([groupA, groupB]);
  });

  it('gives the rows of the focused row\'s kind for a key', () => {
    expect(pluralArgument({ focused: groupA, selection: mixed }, 'mod', 'separator')).toEqual([groupA, groupB]);
    expect(pluralArgument({ focused: alpha, selection: mixed }, 'mod', 'separator')).toEqual([alpha, beta]);
  });

  it('gives nothing to a gesture that does not take the right-clicked row\'s kind', () => {
    expect(pluralArgument({ clicked: groupA, selection: mixed }, 'mod')).toEqual([]);
  });
});

describe('a singular Mods gesture\'s Argument', () => {
  const groupA = separatorRow('Group A');
  const groupB = separatorRow('Group B');
  const groupC = separatorRow('Group C');

  it('is the right-clicked row, not the selection around it', () => {
    expect(singularArgument({ clicked: groupB, selection: [groupA, groupB, groupC] }, 'separator')).toBe(groupB);
  });

  it('is the focused row when reached by a key', () => {
    expect(singularArgument({ focused: groupC, selection: [groupA, groupB, groupC] }, 'separator')).toBe(groupC);
  });

  it('is nothing with no right-clicked or focused row', () => {
    expect(singularArgument({ selection: [] }, 'separator')).toBeUndefined();
  });

  it('is nothing when the right-clicked row is not of a kind the gesture takes', () => {
    expect(singularArgument({ clicked: modRow('Alpha'), selection: [groupA] }, 'separator')).toBeUndefined();
  });
});
