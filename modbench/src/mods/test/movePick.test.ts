import { describe, it, expect, vi } from 'vitest';

vi.mock('vscode', async () => (await import('./modsVscode')).vscodeModule);

import { modsViewOn } from './modsViewOn';
import type * as vscode from 'vscode';
import { answers, seen } from './modsVscode';
import type { ModlistEntry } from '../../instanceAdapter/instanceAdapter';
import { fakeInstanceAdapter, modFoldersOf, readingFixture } from '../../test/fakeInstanceAdapter';
import { instanceValueFixture } from '../../test/mo2/instanceValueFixture';
import { settled } from '../../test/eventually';
import { mod } from './indexedValue';

const separator = (name: string): ModlistEntry => ({ kind: 'separator', name, enabled: true });

const ENTRIES_IN_MODLIST_ORDER_WINNING_FIRST = [mod('Alpha'), separator('Early'), mod('Beta'), separator('Middle'), separator('Late'), mod('Gamma')];
const SORT = { losingAtTop: 'modbench.mod.sortLosingAtTop', winningAtTop: 'modbench.mod.sortWinningAtTop' } as const;

const shownSorted = async (direction: keyof typeof SORT = 'losingAtTop') => {
  const entries = ENTRIES_IN_MODLIST_ORDER_WINNING_FIRST;
  const adapter = fakeInstanceAdapter(readingFixture({ mods: entries, modFolders: modFoldersOf(...entries) }));
  const shown = modsViewOn({ value: instanceValueFixture({ mods: entries }), adapter });
  await shown.run(SORT[direction]);
  return shown;
};

const pickLabelled = (label: string) => { answers.createdQuickPick = (items) => items.find((item) => item.label === label); };
const pickLabels = () => seen.createdQuickPicks.map(({ items }) => items.map(({ label }) => label));
const pickItems = () => seen.createdQuickPicks.map(({ items }) => items.map(({ label, description }: vscode.QuickPickItem) => [label, description]));
const moved = (change: object) => [{ verb: 'changeModOrder', profile: 'Default', changes: [change] }];

describe('the move pick for mods', () => {
  it.each([
    ['losingAtTop', ['Ungrouped', 'Late', 'Middle', 'Early']],
    ['winningAtTop', ['Ungrouped', 'Early', 'Middle', 'Late']],
  ] as const)('offers Ungrouped, then each separator as the view shows them with %s', async (direction, labels) => {
    const { run, row } = await shownSorted(direction);

    await run('modbench.mod.move', await row('Beta', await row('Middle')));

    expect(pickLabels()).toEqual([labels]);
  });

  it('marks each place that holds a selected mod as current, and no other', async () => {
    const { run, row } = await shownSorted();
    const [alpha, gamma] = [await row('Alpha', await row('Early')), await row('Gamma')];

    await run('modbench.mod.move', gamma, [alpha, gamma]);

    expect(pickItems()).toEqual([[['Ungrouped', 'current'], ['Late', undefined], ['Middle', undefined], ['Early', 'current']]]);
  });

  it.each([
    ['Ungrouped', { kind: 'ungrouped' }],
    ['Late', { kind: 'separator', name: 'Late' }],
    ['Middle', { kind: 'separator', name: 'Middle' }],
    ['Early', { kind: 'separator', name: 'Early' }],
  ] as const)('each item carries the place the mods land in: %s', async (label, place) => {
    const { run, row, adapter } = await shownSorted();
    pickLabelled(label);

    await run('modbench.mod.move', await row('Beta', await row('Middle')));

    await settled(() => { expect(adapter.calls).toEqual(moved({ kind: 'moveMods', mods: ['Beta'], place, end: 'winning' })); });
  });
});

describe('the move pick for separators', () => {
  it.each([
    ['losingAtTop', ['Late', 'Early']],
    ['winningAtTop', ['Early', 'Late']],
  ] as const)('offers the other separators as the view shows them with %s', async (direction, labels) => {
    const { run, row } = await shownSorted(direction);

    await run('modbench.mod.move', await row('Middle'));

    expect(pickLabels()).toEqual([labels]);
  });

  it('leaves out every selected separator, and each item carries the separator it lands above', async () => {
    const { run, row, adapter } = await shownSorted();
    const [late, early] = [await row('Late'), await row('Early')];
    pickLabelled('Middle');

    await run('modbench.mod.move', early, [late, early]);

    expect(pickItems()).toEqual([[['Middle', undefined]]]);
    await settled(() => { expect(adapter.calls).toEqual(moved({ kind: 'moveSeparators', separators: ['Late', 'Early'], place: { kind: 'separator', name: 'Middle' }, end: 'losing' })); });
  });
});
