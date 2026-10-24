import { describe, it, expect, vi } from 'vitest';
import { TreeItem } from '../../test/vscodeMock';
import { present } from '../../ports/present';

const { registerCommand } = vi.hoisted(() => ({
  registerCommand: vi.fn((_id: string, handler: (...args: unknown[]) => unknown) => ({ dispose: vi.fn(), handler })),
}));

vi.mock('vscode', () => ({ commands: { registerCommand }, TreeItem }));

import { gestureEntry, isClickedRow, pluralArgument, registerGesture, selectionArgument, singularArgument, type GestureEntry } from '../gestureEntry';

class Row extends TreeItem {
  constructor(readonly kind: 'a' | 'b', label: string) {
    super(label);
  }
}

const KEY_ARGS = { view: 'modbench.test' };
const alpha = new Row('a', 'Alpha');
const beta = new Row('a', 'Beta');
const gamma = new Row('a', 'Gamma');
const other = new Row('b', 'Other');

type Take = (entry: GestureEntry<Row>) => unknown;
const plural: Take = (entry) => pluralArgument(entry, 'a');
const singular: Take = (entry) => singularArgument(entry, 'a');

function entryWhenInvoked(viewSelection: readonly Row[], args: readonly unknown[]): GestureEntry<Row> {
  let received: GestureEntry<Row> | undefined;
  const disposable = registerGesture('modbench.test.gesture', () => viewSelection, (entry) => { received = entry; });
  present(registerCommand.mock.calls.at(-1), 'the gesture\'s command')[1](...args);
  disposable.dispose();
  return present(received, 'the gesture\'s entry');
}

describe('what VS Code hands a gesture becomes its entry', () => {
  it.each<[string, readonly Row[], readonly unknown[], Take, unknown]>([
    ['a right-click inside a multi-selection gives a plural gesture the selection', [alpha, beta], [beta, [alpha, beta]], plural, [alpha, beta]],
    ['a right-click outside the selection gives a plural gesture the right-clicked row alone', [alpha, beta], [gamma, undefined], plural, [gamma]],
    ['a right-click gives a singular gesture the right-clicked row', [alpha, beta], [beta, [alpha, beta]], singular, beta],
    ['the palette gives a plural gesture the view\'s selection', [alpha, gamma], [], plural, [alpha, gamma]],
    ['a key, which VS Code invokes with null when it has no args of its own, gives a plural gesture the view\'s selection', [beta, gamma], [null], plural, [beta, gamma]],
    ['a key with one row selected gives a plural gesture that one row', [beta], [null], plural, [beta]],
    ['a key\'s own args give a plural gesture the view\'s selection, not the args', [beta, gamma], [KEY_ARGS], plural, [beta, gamma]],
    ['a key\'s own args give a singular gesture the one selected row', [gamma], [KEY_ARGS], singular, gamma],
    ['the palette gives a singular gesture the one selected row', [alpha], [], singular, alpha],
    ['the palette gives a singular gesture nothing while several rows are selected', [alpha, beta], [], singular, undefined],
    ['the palette gives a plural gesture nothing with nothing selected', [], [], plural, []],
    ['the palette gives a singular gesture nothing with nothing selected', [], [], singular, undefined],
  ])('%s', (_case, viewSelection, args, take, expected) => {
    expect(take(entryWhenInvoked(viewSelection, args))).toEqual(expected);
  });

  it('hands the command\'s option to the gesture', () => {
    let option: unknown;
    registerGesture('modbench.test.option', () => [], (_entry, given) => { option = given; });
    registerCommand.mock.calls.at(-1)?.[1](undefined, undefined, 'picked');
    expect(option).toBe('picked');
  });
});

describe('the rows of the kinds a gesture takes', () => {
  it.each<[string, () => unknown, unknown]>([
    ['a plural gesture narrows a mixed selection to the right-clicked row\'s kind', () => pluralArgument({ clicked: alpha, selection: [alpha, other] }, 'a', 'b'), [alpha]],
    ['a plural gesture narrows a mixed selection to the focused row\'s kind', () => pluralArgument({ focused: other, selection: [alpha, other] }, 'a', 'b'), [other]],
    ['a plural gesture drops a selected row of a kind it does not take', () => pluralArgument({ clicked: alpha, selection: [other, alpha] }, 'a'), [alpha]],
    ['a plural gesture takes nothing when the right-clicked row is of a kind it does not take', () => pluralArgument({ clicked: other, selection: [alpha, other] }, 'a'), []],
    ['the whole selection keeps every kind given, whatever the right-clicked row\'s kind', () => selectionArgument({ clicked: alpha, selection: [alpha, other] }, 'a', 'b'), [alpha, other]],
    ['the whole selection keeps every kind given from the palette', () => selectionArgument({ selection: [alpha, other] }, 'a', 'b'), [alpha, other]],
    ['the whole selection still excludes a kind not requested', () => selectionArgument({ clicked: alpha, selection: [alpha, other] }, 'a'), [alpha]],
    ['a singular gesture takes nothing when the right-clicked row is of a kind it does not take', () => singularArgument({ clicked: other, selection: [alpha] }, 'a'), undefined],
  ])('%s', (_case, take, expected) => {
    expect(take()).toEqual(expected);
  });
});

describe('what a gesture that refuses unreadable rows aloud takes as clicked', () => {
  const selected = { argument: { kind: 'mod', name: 'ModA' } };
  const viewSelection = (): readonly unknown[] => [selected, selected];
  const bare = new TreeItem('Odd');
  const pluginContext = { argument: { kind: 'plugin', plugin: { name: 'A.esp', origin: 'Mod' } } };
  const recordContext = { argument: { kind: 'record', formKey: '000800:A.esp' } };

  it.each<[string, unknown, readonly unknown[]]>([
    ['a tree row that carries no Argument, for the gesture to refuse aloud', bare, [bare]],
    ['a webview context carrying a mod', selected, [selected]],
    ['a webview context carrying a plugin', pluginContext, [pluginContext]],
    ['a webview context carrying a record', recordContext, [recordContext]],
    ['not an object whose Argument names no kind, which leaves the view\'s selection', { argument: { name: 'ModA' } }, [selected, selected]],
    ['not a key\'s own args, which leave the view\'s selection', KEY_ARGS, [selected, selected]],
  ])('%s', (_case, clicked, expected) => {
    expect(gestureEntry(clicked, undefined, viewSelection, isClickedRow).selection).toEqual(expected);
  });
});
