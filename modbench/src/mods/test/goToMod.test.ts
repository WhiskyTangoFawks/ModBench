import { describe, it, expect, vi } from 'vitest';

vi.mock('vscode', async () => (await import('./modsVscode')).vscodeModule);

import { modsViewOn } from './modsViewOn';
import { answers, seen } from './modsVscode';
import { modOrigin } from '../../instanceLoader/fileConflictIndex';
import { currentBoxOf } from '../../drivingLib/test/nameFilterViewHarness';
import { file, folder, indexedValueOf, mod } from './indexedValue';

const PATH = 'textures/a.dds';
const revealOf = (name: string) => ({ label: name, options: { select: true, focus: true } });

async function setup(...names: string[]) {
  const shown = modsViewOn({ value: await indexedValueOf(names.map((name) => mod(name)), Object.fromEntries(names.map((name) => [name, { files: [file(name, PATH)], folders: [folder(name, 'textures')] }]))) });
  const fileOf = async (name: string) => shown.row('a.dds', await shown.row('textures', await shown.row(name)));
  const invoke = (...args: unknown[]) => shown.run('modbench.mod.goToMod', ...args);
  return { ...shown, fileOf, invoke };
}

describe('the go to mod command', () => {
  it('selects the one candidate with no pick', async () => {
    const { view, fileOf, invoke } = await setup('High', 'Low');

    await invoke(await fileOf('High'));

    expect([view.reveals, seen.quickPicks]).toEqual([[revealOf('Low')], []]);
  });

  it('picks among the several the winning copy wins over, in mod order, losing first, and selects the pick', async () => {
    const { view, fileOf, invoke } = await setup('High', 'Middle', 'Low');
    answers.quickPick = (items) => items[1];

    await invoke(await fileOf('High'));

    expect(seen.quickPicks.map(({ labels }) => labels)).toEqual([['Low', 'Middle']]);
    expect(view.reveals).toEqual([revealOf('Middle')]);
  });

  it('selects nothing when the pick is dismissed', async () => {
    const { view, reporter, fileOf, invoke } = await setup('High', 'Middle', 'Low');

    await invoke(await fileOf('High'));

    expect([view.reveals, reporter.reports]).toEqual([[], []]);
  });

  it('takes the other mod as its option, with no pick', async () => {
    const { view, fileOf, invoke } = await setup('High', 'Middle', 'Low');

    await invoke(await fileOf('High'), undefined, modOrigin('Low'));

    expect([view.reveals, seen.quickPicks]).toEqual([[revealOf('Low')], []]);
  });

  it('refuses an option that names no copy this one relates to, rather than selecting something else', async () => {
    const { view, reporter, fileOf, invoke } = await setup('High', 'Middle', 'Low');

    await invoke(await fileOf('High'), undefined, modOrigin('Stranger'));
    await invoke(await fileOf('High'), undefined, 'Low');

    expect(view.reveals).toEqual([]);
    expect(reporter.reports.map(({ message }) => message)).toEqual(['Failed to go to a mod.', 'Failed to go to a mod.']);
  });

  it('does nothing for a copy no conflict holds, and for a row that is not a file', async () => {
    const { view, row, fileOf, invoke } = await setup('High');

    await invoke(await fileOf('High'));
    await invoke(await row('High'));

    expect(view.reveals).toEqual([]);
  });

  it('says so when no row shows the mod, rather than selecting nothing in silence', async () => {
    const { mods, view, reporter, fileOf, invoke } = await setup('High', 'Low');
    mods.nameFilter.open();
    currentBoxOf(seen)().type('high');

    await invoke(await fileOf('High'));

    expect(view.reveals).toEqual([]);
    expect(reporter.reports).toEqual([{ severity: 'error', message: 'Failed to go to "Low".', detail: 'No row shows it.' }]);
  });

  it('reports a reveal that fails', async () => {
    const { view, reporter, fileOf, invoke } = await setup('High', 'Low');
    view.revealRefusal = new Error('no such row');

    await invoke(await fileOf('High'));

    expect(reporter.reports).toEqual([{ severity: 'error', message: 'Failed to go to "Low".', detail: 'no such row' }]);
  });

  it('acts on the one selected file when a key hands it no row', async () => {
    const { view, fileOf, invoke } = await setup('High', 'Low');
    view.selectRows([await fileOf('High')]);

    await invoke();

    expect(view.reveals).toEqual([revealOf('Low')]);
  });
});
