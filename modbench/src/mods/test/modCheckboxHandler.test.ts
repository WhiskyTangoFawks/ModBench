import { describe, it, expect, vi } from 'vitest';

vi.mock('vscode', async () => (await import('./modsVscode')).vscodeModule);

import { modsViewOn } from './modsViewOn';
import { TreeItemCheckboxState } from '../../test/vscodeMock';
import type { ModlistEntry } from '../../instanceAdapter/instanceAdapter';
import { fakeInstanceAdapter, modFoldersOf, readingFixture, refusing } from '../../test/fakeInstanceAdapter';
import { instanceValueFixture } from '../../test/mo2/instanceValueFixture';
import { settled } from '../../test/eventually';
import { mod } from './indexedValue';

const { Checked, Unchecked } = TreeItemCheckboxState;

function modsOf(entries: ModlistEntry[], refusals?: ReturnType<typeof refusing>) {
  const adapter = fakeInstanceAdapter(readingFixture({ mods: entries, modFolders: modFoldersOf(...entries) }), { refusals });
  return modsViewOn({ value: instanceValueFixture({ mods: entries }), adapter });
}

const enabling = (...mods: [string, boolean][]) =>
  ({ verb: 'changeModOrder', profile: 'Default', changes: mods.map(([name, enabled]) => ({ kind: 'enable', mod: name, enabled })) });

describe('a checkbox click in Mods', () => {
  it('fires enable once over every mod the click checked', async () => {
    const { view, row, adapter } = modsOf([mod('A', false), mod('B', false)]);

    view.check([[await row('A'), Checked], [await row('B'), Checked]]);

    await settled(() => { expect(adapter.calls).toEqual([enabling(['A', true], ['B', true])]); });
  });

  it('fires disable for the mods it unchecked and enable for the ones it checked, each once', async () => {
    const { view, row, adapter } = modsOf([mod('On', false), mod('Off')]);

    view.check([[await row('Off'), Unchecked], [await row('On'), Checked]]);

    await settled(() => { expect(adapter.calls).toEqual([enabling(['On', true]), enabling(['Off', false])]); });
  });

  it('restores every mod row it clicked once the commands end, though one failed (common.md, A gesture that writes, story 2)', async () => {
    const { view, row, reporter } = modsOf([mod('A'), mod('B', false)], refusing('changeModOrder', 'refused'));
    const [a, b] = [await row('A'), await row('B')];
    const redrawn: unknown[] = [];
    view.treeDataProvider.onDidChangeTreeData?.((rows) => { redrawn.push(rows); });

    view.check([[a, Unchecked], [b, Checked]]);

    await settled(() => { expect(redrawn).toEqual([a, b]); });
    expect(reporter.reports.map(({ message }) => message)).toEqual(['Failed to enable mods.', 'Failed to disable mods.']);
  });

  it('ignores a non-mod row (the pinned Overwrite row sharing the tree)', async () => {
    const { view, row, adapter } = modsOf([mod('A', false)]);

    view.check([[await row('Overwrite'), Checked], [await row('A'), Checked]]);

    await settled(() => { expect(adapter.calls).toEqual([enabling(['A', true])]); });
  });
});
