import { describe, it, expect, vi } from 'vitest';

vi.mock('vscode', async () => (await import('./modsVscode')).vscodeModule);

import { modsViewOn } from './modsViewOn';
import type { ModlistEntry } from '../../instanceAdapter/instanceAdapter';
import { fakeInstanceAdapter, modFoldersOf, readingFixture } from '../../test/fakeInstanceAdapter';
import { instanceValueFixture } from '../../test/mo2/instanceValueFixture';
import { settled } from '../../test/eventually';
import { mod } from './indexedValue';
import type { SortDirection } from '../../drivingLib/sortDirectionToggle';

const separator = (name: string): ModlistEntry => ({ kind: 'separator', name, enabled: true });

const ENTRIES = [
  mod('Alpha'), separator('Group A'), mod('Beta'), mod('Gamma'), separator('Group B'), separator('Pack - One'), separator('Pack - Two'), mod('Delta'),
];
const SORT = { losingAtTop: 'modbench.mod.sortLosingAtTop', winningAtTop: 'modbench.mod.sortWinningAtTop' } as const;

async function shownSorted(direction: SortDirection) {
  const adapter = fakeInstanceAdapter(readingFixture({ mods: ENTRIES, modFolders: modFoldersOf(...ENTRIES) }));
  const shown = modsViewOn({ value: instanceValueFixture({ mods: ENTRIES }), adapter });
  await shown.run(SORT[direction]);
  const { row } = shown;
  const [groupA, groupB] = [await row('Group A'), await row('Group B')];
  const rows = {
    alpha: await row('Alpha', groupA), beta: await row('Beta', groupB), gamma: await row('Gamma', groupB), delta: await row('Delta'),
    groupA, groupB, overwrite: await row('Overwrite'), pack: await row('Pack'),
  };
  return { ...shown, rows };
}

type Rows = Awaited<ReturnType<typeof shownSorted>>['rows'];
type Name = keyof Rows;

const BOTH: readonly SortDirection[] = ['losingAtTop', 'winningAtTop'];
const endTheViewShowsAtTheTop = { losingAtTop: 'losing', winningAtTop: 'winning' } as const;
const endTheViewShowsAtTheBottom = { losingAtTop: 'winning', winningAtTop: 'losing' } as const;
const moved = (change: object) => [{ verb: 'changeModOrder', profile: 'Default', changes: [change] }];

describe.each(BOTH)('a drop is a move, as shown, with %s', (direction) => {
  it('mods dropped on a mod land directly above it', async () => {
    const { drop, rows: { alpha, delta, gamma }, adapter } = await shownSorted(direction);

    await drop([alpha, delta], gamma);

    await settled(() => { expect(adapter.calls).toEqual(moved({ kind: 'moveMods', mods: ['Alpha', 'Delta'], place: { kind: 'mod', name: 'Gamma' }, end: endTheViewShowsAtTheTop[direction] })); });
  });

  it('mods dropped on a separator land at its winning end', async () => {
    const { drop, rows: { delta, groupA }, adapter } = await shownSorted(direction);

    await drop([delta], groupA);

    await settled(() => { expect(adapter.calls).toEqual(moved({ kind: 'moveMods', mods: ['Delta'], place: { kind: 'separator', name: 'Group A' }, end: 'winning' })); });
  });

  it('a separator dropped on a separator lands directly above it', async () => {
    const { drop, rows: { groupA, groupB }, adapter } = await shownSorted(direction);

    await drop([groupB], groupA);

    await settled(() => { expect(adapter.calls).toEqual(moved({ kind: 'moveSeparators', separators: ['Group B'], place: { kind: 'separator', name: 'Group A' }, end: endTheViewShowsAtTheTop[direction] })); });
  });

  it.each([
    ['mods', 'beta', { kind: 'moveMods', mods: ['Beta'] }],
    ['a separator', 'groupA', { kind: 'moveSeparators', separators: ['Group A'] }],
  ] as const)('%s dropped below the last row land at the bottom of the view', async (_case, name, change) => {
    const { drop, rows, adapter } = await shownSorted(direction);

    await drop([rows[name]], undefined);

    await settled(() => { expect(adapter.calls).toEqual(moved({ ...change, place: { kind: 'modOrder' }, end: endTheViewShowsAtTheBottom[direction] })); });
  });

  it('a mixed drag moves only the rows of the focused row\'s kind', async () => {
    const { drop, rows: { alpha, delta, groupA, groupB }, adapter } = await shownSorted(direction);

    await drop([groupB, delta, alpha], groupA);
    await drop([delta, groupB], groupA);

    await settled(() => {
      expect(adapter.calls.flatMap((call) => (call.verb === 'changeModOrder' ? call.changes : []))).toEqual([
        { kind: 'moveMods', mods: ['Delta', 'Alpha'], place: { kind: 'separator', name: 'Group A' }, end: 'winning' },
        { kind: 'moveSeparators', separators: ['Group B'], place: { kind: 'separator', name: 'Group A' }, end: endTheViewShowsAtTheTop[direction] },
      ]);
    });
  });

  it.each<[string, Name[], Name, string]>([
    ['mods on Overwrite', ['delta'], 'overwrite', 'Overwrite is not a mod.'],
    ['mods on a separator group', ['delta'], 'pack', 'A separator group is a heading, so nothing goes onto it.'],
    ['mods on a mod being dragged', ['alpha', 'delta'], 'alpha', 'Alpha is being dragged, so nothing goes onto it.'],
    ['separators on a separator being dragged', ['groupA', 'groupB'], 'groupA', 'Group A is being dragged, so nothing goes onto it.'],
    ['mods on a separator being dragged that is not of the focused row\'s kind', ['groupB', 'delta'], 'groupB', 'Group B is being dragged, so nothing goes onto it.'],
    ['mods inside a separator being dragged', ['groupB', 'delta'], 'gamma', 'Gamma is inside Group B, which is being dragged.'],
    ['a separator on a mod', ['groupA'], 'delta', 'A separator goes above a separator, not on a mod.'],
  ])('a drop of %s is refused, saying why', async (_case, dragged, target, refusal) => {
    const { drop, rows, adapter, reporter } = await shownSorted(direction);

    await drop(dragged.map((name) => rows[name]), rows[target]);

    expect([adapter.calls, reporter.reports.map(({ detail }) => detail)]).toEqual([[], [refusal]]);
  });

  it('a drop of mods on a mod being dragged, as the view rebuilt it since the drag began, is refused, saying why', async () => {
    const { drop, rows: { alpha, delta }, adapter, reporter, instance, row } = await shownSorted(direction);
    instance.publish(instanceValueFixture({ mods: ENTRIES }));

    await drop([alpha, delta], await row('Alpha', await row('Group A')));

    expect([adapter.calls, reporter.reports]).toEqual([[], [{ severity: 'error', message: 'Could not move mods.', detail: 'Alpha is being dragged, so nothing goes onto it.' }]]);
  });
});
