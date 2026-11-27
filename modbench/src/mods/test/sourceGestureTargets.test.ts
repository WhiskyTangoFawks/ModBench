import { describe, it, expect, vi } from 'vitest';

vi.mock('vscode', async () => (await import('./modsVscode')).vscodeModule);

import { modsViewOn } from './modsViewOn';
import { columnHeader, pluginRow, PLUGINS_VIEW } from './sourceGestureHarness';
import { mod } from './indexedValue';
import { progressSteps } from '../../test/recordedProgress';
import { instanceValueFixture } from '../../test/mo2/instanceValueFixture';

type Shown = ReturnType<typeof viewSending>;

function viewSending() {
  const sent: (readonly string[])[] = [];
  const listed = [{ kind: 'separator' as const, name: 'Separator', enabled: true }, mod('ModA'), mod('ModB')];
  const shown = modsViewOn({
    value: instanceValueFixture({ mods: [...listed, mod('Unlisted')] }),
    sourceCommands: { build: (mods) => { sent.push(mods); return Promise.resolve({ landed: [], refused: [] }); } },
  });
  const unlistedRow = async () => {
    const row = await shown.row('Unlisted');
    shown.instance.publish({ ...shown.instance.value, mods: listed });
    return row;
  };
  return { ...shown, sent, unlistedRow };
}

const a = { name: 'A.esp', origin: 'ModA' };

describe('the mods a source gesture sends for the rows it was given', () => {
  it.each<[string, (shown: Shown) => Promise<unknown[]>, { mods: string[]; refused: string[] }]>([
    ['a Mods row sends its mod, the mod order listing it or not', async ({ unlistedRow }) => [await unlistedRow()], { mods: ['Unlisted'], refused: [] }],
    ['a plugin row sends its plugin\'s mod', () => Promise.resolve([pluginRow(a)]), { mods: ['ModA'], refused: [] }],
    ['a record tab\'s column header sends its plugin\'s mod', () => Promise.resolve([columnHeader({ name: 'B.esp', origin: 'ModB' })]), { mods: ['ModB'], refused: [] }],
    ['a selection sends each mod once, in the order first given', async ({ row }) => [pluginRow(a), await row('ModB'), await row('ModA'), pluginRow({ name: 'Also.esp', origin: 'ModA' })],
      { mods: ['ModA', 'ModB'], refused: [] }],
    ['a plugin no mod provides is refused as not in a mod', () => Promise.resolve([pluginRow({ name: 'Loose.esp', origin: 'Overwrite' })]),
      { mods: [], refused: ['"Loose.esp (Overwrite)" (it is not in a mod)'] }],
    ['a row that carries no mod or plugin is refused', async ({ row }) => [await row('Separator')], { mods: [], refused: ['"Separator" (it carries no mod or plugin)'] }],
  ])('%s', async (_case, rowsOf, expected) => {
    const shown = viewSending();
    const rows = await rowsOf(shown);

    await shown.run('modbench.mod.build', rows[0], rows);

    expect({ mods: shown.sent.flat(), refused: shown.reporter.reports.map(({ detail }) => detail) }).toEqual(expected);
  });
});

describe('the view whose bar a source gesture runs under', () => {
  it.each<[string, (shown: Shown) => Promise<unknown[]>, string]>([
    ['the Mods view for a Mods row', async ({ row }) => [await row('ModA')], 'modbench.modList'],
    ['the Mods view for a selection holding a Mods row', async ({ row }) => [pluginRow(a), await row('ModB')], 'modbench.modList'],
    ['the Plugins view for a plugin row', () => Promise.resolve([pluginRow(a)]), PLUGINS_VIEW],
    ['the Plugins view for a column header', () => Promise.resolve([columnHeader({ name: 'B.esp', origin: 'ModB' })]), PLUGINS_VIEW],
  ])('is %s', async (_case, rowsOf, view) => {
    const shown = viewSending();
    const rows = await rowsOf(shown);

    await shown.run('modbench.mod.build', rows[0], rows);

    expect(progressSteps[0]).toBe(`progress opens on ${view}`);
  });
});
