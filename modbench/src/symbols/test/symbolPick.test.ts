import { describe, it, expect, vi } from 'vitest';
import { Range, Uri } from '../../test/vscodeMock';

type Listener<Value> = (value: Value) => unknown;

const { quickPick } = vi.hoisted(() => {
  const state = {
    change: undefined as Listener<string> | undefined, accept: undefined as (() => void) | undefined, hide: undefined as (() => void) | undefined,
    items: [] as { label: string; description?: string; symbol: unknown }[], selectedItems: [] as { symbol: unknown }[], hidden: 0, disposed: 0,
  };
  return { quickPick: state };
});

vi.mock('vscode', () => ({
  Uri, Range,
  Location: class { constructor(readonly uri: unknown, readonly range: unknown) {} },
  window: {
    createQuickPick: () => ({
      onDidChangeValue: (listener: Listener<string>) => { quickPick.change = listener; },
      onDidAccept: (listener: () => void) => { quickPick.accept = listener; },
      onDidHide: (listener: () => void) => { quickPick.hide = listener; },
      show: () => undefined,
      hide: () => { quickPick.hidden++; quickPick.hide?.(); },
      dispose: () => { quickPick.disposed++; },
      set items(value: typeof quickPick.items) { quickPick.items = value; },
      get selectedItems() { return quickPick.selectedItems; },
    }),
  },
}));

import * as vscode from 'vscode';
import { pickSymbol } from '../symbolPick';
import { fakeKind, fakeKinds } from './fakeKinds';
import type { Listed, SymbolName } from '../symbolKind';

const GUN: SymbolName = { kind: 'record', formKey: '000801:A.esp' };
const listed = (symbol: SymbolName, name: string): Listed => ({ symbol, name, detail: 'a detail', icon: 0, location: new vscode.Location(Uri.file('/a.json'), new vscode.Range(0, 0, 0, 0)) });

describe('pick a symbol as Go to Symbol in Workspace finds it', () => {
  it('lists the symbols of every kind that hold what is typed, and answers the one accepted', async () => {
    const kinds = fakeKinds({ record: fakeKind({ symbolsFor: (query) => Promise.resolve(query === 'gun' ? [listed(GUN, 'Gun')] : []) }) });
    const picked = pickSymbol(kinds);

    await quickPick.change?.('gun');
    expect(quickPick.items).toEqual([{ symbol: GUN, label: 'Gun', description: 'a detail' }]);
    quickPick.selectedItems = [{ symbol: GUN }];
    quickPick.accept?.();

    expect(await picked).toEqual(GUN);
  });

  it('answers no symbol when the user dismisses it', async () => {
    const picked = pickSymbol(fakeKinds());

    quickPick.hide?.();

    expect(await picked).toBeUndefined();
  });
});
