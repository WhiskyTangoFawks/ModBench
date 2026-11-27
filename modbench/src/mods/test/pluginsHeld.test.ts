import { describe, it, expect, vi } from 'vitest';

vi.mock('vscode', async () => (await import('./modsVscode')).vscodeModule);

import { modsViewOn } from './modsViewOn';
import { seen } from './modsVscode';
import type { ModlistEntry } from '../../instanceAdapter/instanceAdapter';
import type { LoadOrderPlugin } from '../../instanceLoader/loadOrderSnapshot';
import { instanceValueFixture } from '../../test/mo2/instanceValueFixture';
import { currentBoxOf } from '../../drivingLib/test/nameFilterViewHarness';
import { file, mod } from './indexedValue';

const sep = (name: string): ModlistEntry => ({ kind: 'separator', name, enabled: false });
const plugin = (name: string, origin: string, winning = true): LoadOrderPlugin =>
  ({ name, origin, path: `/${origin}/${name}`, line: 0, enabled: true, winning });

function scene(mods: ModlistEntry[], files: Record<string, string[]>, plugins: LoadOrderPlugin[], overwrite: string[] = []) {
  return modsViewOn({ value: instanceValueFixture({
    mods, plugins,
    filesByMod: new Map(Object.entries(files).map(([name, paths]) => [name, paths.map((p) => file(name, p))])),
    overwriteFiles: overwrite.map((p) => file('overwrite', p)),
  }) });
}

const heldBy = (shown: ReturnType<typeof scene>, selection: readonly unknown[]) =>
  shown.mods.relatesRows.related(selection).plugins.map(({ name, origin }) => `${name}@${origin}`);

describe('the plugins a Mods selection holds', () => {
  it('a mod holds each plugin its files hold', async () => {
    const shown = scene([mod('A')], { A: ['A.esp', 'textures/x.dds'] }, [plugin('A.esp', 'A')]);

    expect(heldBy(shown, [await shown.row('A')])).toEqual(['A.esp@A']);
  });

  it('an overridden plugin highlights the row of the plugin that overrides it', async () => {
    const shown = scene([mod('Low'), mod('High')], { Low: ['Shared.esp'], High: ['Shared.esp'] },
      [plugin('Shared.esp', 'Low', false), plugin('Shared.esp', 'High')]);

    expect(heldBy(shown, [await shown.row('Low')])).toEqual(['Shared.esp@High']);
  });

  it('a name matches whatever its case', async () => {
    const shown = scene([mod('A')], { A: ['a.ESP'] }, [plugin('A.esp', 'A')]);

    expect(heldBy(shown, [await shown.row('A')])).toEqual(['A.esp@A']);
  });

  it('a disabled mod holds nothing', async () => {
    const shown = scene([mod('A', false)], { A: ['A.esp'] }, [plugin('A.esp', 'A', false)]);

    expect(heldBy(shown, [await shown.row('A')])).toEqual([]);
  });

  it('a nested file named like a plugin is no plugin', async () => {
    const shown = scene([mod('A')], { A: ['meshes/A.esp'] }, [plugin('A.esp', 'B')]);

    expect(heldBy(shown, [await shown.row('A')])).toEqual([]);
  });

  it('Overwrite holds the plugins in its folder', async () => {
    const shown = scene([], {}, [plugin('Out.esp', 'overwrite/')], ['Out.esp']);

    expect(heldBy(shown, [await shown.row('Overwrite')])).toEqual(['Out.esp@overwrite/']);
  });

  it.each([
    ['unfiltered', ''],
    ['filtered to show only its disabled mod', 'off'],
  ])('a separator holds what its enabled mods hold, whether its row is open or collapsed: %s', async (_case, term) => {
    const shown = scene([mod('Off', false), mod('On'), sep('S'), mod('Elsewhere')], { Off: ['Off.esp'], On: ['On.esp'], Elsewhere: ['E.esp'] },
      [plugin('On.esp', 'On'), plugin('E.esp', 'Elsewhere')]);
    shown.mods.nameFilter.open();
    currentBoxOf(seen)().type(term);

    expect(heldBy(shown, [await shown.row('S')])).toEqual(['On.esp@On']);
  });

  it('rows of any other kind hold nothing', async () => {
    const shown = scene([mod('A')], { A: ['A.esp'] }, [plugin('A.esp', 'A')]);
    const fileRow = await shown.row('A.esp', await shown.row('A'));

    expect(heldBy(shown, [fileRow, { kind: 'plugin' }])).toEqual([]);
  });
});
