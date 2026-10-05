import { describe, it, expect, vi } from 'vitest';
import { TreeItem } from '../../test/vscodeMock';

const { registerCommand } = vi.hoisted(() => ({
  registerCommand: vi.fn((_id: string, handler: (...args: unknown[]) => unknown) => ({ dispose: vi.fn(), handler })),
}));

vi.mock('vscode', () => ({ commands: { registerCommand }, TreeItem }));

import { pluralArgument, registerGesture, selectionArgument, singularArgument, type GestureEntry } from '../gestureEntry';

class Row extends TreeItem {
  constructor(readonly kind: 'a' | 'b', label: string) {
    super(label);
  }
}

const KEY_ARGS = { view: 'modbench.test' };

function entryWhenInvoked(viewSelection: readonly Row[], ...args: unknown[]): GestureEntry<Row> {
  let received: GestureEntry<Row> | undefined;
  const disposable = registerGesture('modbench.test.gesture', () => viewSelection, (entry) => { received = entry; });
  const call = registerCommand.mock.calls.at(-1);
  if (!call || call[0] !== 'modbench.test.gesture') throw new Error('the gesture registered no command');
  call[1](...args);
  disposable.dispose();
  if (!received) throw new Error('the gesture was not run');
  return received;
}

describe('what VS Code hands a gesture becomes its entry', () => {
  const alpha = new Row('a', 'Alpha');
  const beta = new Row('a', 'Beta');
  const gamma = new Row('a', 'Gamma');

  it('a right-click inside a multi-selection gives a plural gesture the selection', () => {
    const entry = entryWhenInvoked([alpha, beta], beta, [alpha, beta]);
    expect(pluralArgument(entry, 'a')).toEqual([alpha, beta]);
  });

  it('a right-click outside the selection gives a plural gesture the right-clicked row alone', () => {
    const entry = entryWhenInvoked([alpha, beta], gamma, undefined);
    expect(pluralArgument(entry, 'a')).toEqual([gamma]);
  });

  it('a right-click gives a singular gesture the right-clicked row', () => {
    const entry = entryWhenInvoked([alpha, beta], beta, [alpha, beta]);
    expect(singularArgument(entry, 'a')).toBe(beta);
  });

  it('the palette gives a plural gesture the view\'s selection', () => {
    const entry = entryWhenInvoked([alpha, gamma]);
    expect(pluralArgument(entry, 'a')).toEqual([alpha, gamma]);
  });

  it('a key gives a plural gesture the view\'s selection, VS Code invoking a keybinding with no args of its own with null', () => {
    const entry = entryWhenInvoked([beta, gamma], null);
    expect(pluralArgument(entry, 'a')).toEqual([beta, gamma]);
  });

  it('the palette gives a singular gesture the one selected row', () => {
    const entry = entryWhenInvoked([alpha]);
    expect(singularArgument(entry, 'a')).toBe(alpha);
  });

  it('the palette gives a singular gesture nothing while several rows are selected', () => {
    const entry = entryWhenInvoked([alpha, beta]);
    expect(singularArgument(entry, 'a')).toBeUndefined();
  });

  it('a key\'s own args give a plural gesture the view\'s selection, not the args', () => {
    const entry = entryWhenInvoked([beta, gamma], KEY_ARGS);
    expect(pluralArgument(entry, 'a')).toEqual([beta, gamma]);
  });

  it('a key\'s own args give a singular gesture the one selected row', () => {
    const entry = entryWhenInvoked([gamma], KEY_ARGS);
    expect(singularArgument(entry, 'a')).toBe(gamma);
  });

  it('a key with one row selected gives a plural gesture that one row', () => {
    const entry = entryWhenInvoked([beta], null);
    expect(pluralArgument(entry, 'a')).toEqual([beta]);
  });

  it('hands the command\'s option to the gesture', () => {
    let option: unknown;
    registerGesture('modbench.test.option', () => [], (_entry, given) => { option = given; });
    registerCommand.mock.calls.at(-1)?.[1](undefined, undefined, 'picked');
    expect(option).toBe('picked');
  });
});

describe('a plural gesture\'s Argument', () => {
  const alpha = new Row('a', 'Alpha');
  const beta = new Row('a', 'Beta');
  const gamma = new Row('a', 'Gamma');

  it('is the whole selection from a context menu', () => {
    expect(pluralArgument({ clicked: beta, selection: [alpha, beta, gamma] }, 'a')).toEqual([alpha, beta, gamma]);
  });

  it('is the whole selection from a key', () => {
    expect(pluralArgument({ focused: gamma, selection: [alpha, beta, gamma] }, 'a')).toEqual([alpha, beta, gamma]);
  });

  it('is the whole selection from the palette', () => {
    expect(pluralArgument({ selection: [alpha, beta, gamma] }, 'a')).toEqual([alpha, beta, gamma]);
  });

  it('is nothing with no row and no selection', () => {
    expect(pluralArgument<Row, 'a'>({ selection: [] }, 'a')).toEqual([]);
  });

  it('narrows a mixed selection to the right-clicked or focused row\'s kind', () => {
    const other = new Row('b', 'Other');
    expect(pluralArgument({ clicked: alpha, selection: [alpha, other] }, 'a', 'b')).toEqual([alpha]);
    expect(pluralArgument({ focused: other, selection: [alpha, other] }, 'a', 'b')).toEqual([other]);
  });
});

describe('selectionArgument', () => {
  const alpha = new Row('a', 'Alpha');
  const other = new Row('b', 'Other');

  it('keeps every selected row of the kinds given, whatever the anchor row\'s kind', () => {
    expect(selectionArgument({ clicked: alpha, selection: [alpha, other] }, 'a', 'b')).toEqual([alpha, other]);
    expect(selectionArgument({ selection: [alpha, other] }, 'a', 'b')).toEqual([alpha, other]);
  });

  it('still excludes a kind not requested', () => {
    expect(selectionArgument({ clicked: alpha, selection: [alpha, other] }, 'a')).toEqual([alpha]);
  });
});

describe('a singular gesture\'s Argument', () => {
  const alpha = new Row('a', 'Alpha');
  const beta = new Row('a', 'Beta');
  const gamma = new Row('a', 'Gamma');
  const other = new Row('b', 'Other');

  it('is the right-clicked row, not the selection around it', () => {
    expect(singularArgument({ clicked: beta, selection: [alpha, beta, gamma] }, 'a')).toBe(beta);
  });

  it('is the focused row when reached by a key', () => {
    expect(singularArgument({ focused: gamma, selection: [alpha, beta, gamma] }, 'a')).toBe(gamma);
  });

  it('is nothing with no right-clicked or focused row', () => {
    expect(singularArgument<Row, 'a'>({ selection: [] }, 'a')).toBeUndefined();
  });

  it('is nothing when the right-clicked row is not of a kind the gesture takes', () => {
    expect(singularArgument({ clicked: other, selection: [alpha] }, 'a')).toBeUndefined();
  });
});
