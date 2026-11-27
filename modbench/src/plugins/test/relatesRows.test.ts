import { describe, it, expect, vi } from 'vitest';

vi.mock('vscode', () => import('./vscodeHost'));

import { clientHoldingNothing, pluginsOver } from './pluginsOver';
import type { LoadOrderPlugin, PluginWithNoLine } from '../../instanceLoader/loadOrderSnapshot';
import type { Mod } from '../../instanceLoader/instance';
import { pluginMetadataFixture } from '../../client/test/fixtures';
import { holdsLoadOrder } from '../../client/test/says';
import { instanceValueFixture } from '../../test/mo2/instanceValueFixture';
import { settled as until } from '../../test/eventually';
import { DATA_DIRECTORY_ORIGIN, OVERWRITE_ORIGIN } from '../../wire/pluginAddress';

const mod = (name: string): Mod => ({ kind: 'mod', name, enabled: true });
const entry = (name: string, origin: string, winning = true): LoadOrderPlugin =>
  ({ name, path: `/fixture/${origin}/${name}`, origin, line: 0, enabled: true, winning });
const OTHER_ROWS = [{ kind: 'record' }, 'a string'];

async function relating(plugins: LoadOrderPlugin[], masters: Record<string, string[]> = {}, pluginsLoadedWithNoLine: PluginWithNoLine[] = []) {
  const client = clientHoldingNothing();
  client.setQueryAnswer('getPlugins', plugins.map(({ name, origin }) => pluginMetadataFixture({ name, origin, masters: masters[name] ?? [] })));
  client.setQueryAnswer('getPluginsIndexing', []);
  const made = pluginsOver({ client, value: instanceValueFixture({ mods: [mod('Alpha'), mod('Beta')], plugins, pluginsLoadedWithNoLine }) });
  holdsLoadOrder(client, { indexed: plugins });
  await until(() => { expect(made.plugins.standing.mEdit()).toEqual([]); });
  const row = await made.pluginRows();
  return {
    relatedTo: (...selected: readonly LoadOrderPlugin[]) => made.shown.relatesRows.related(selected.map(({ name, origin }) => row(name, origin))),
    relatedToOtherRows: () => made.shown.relatesRows.related(OTHER_ROWS),
  };
}

describe('the mods and Overwrite a Plugins selection comes from', () => {
  it.each([
    ['the mod each plugin comes from', [entry('A.esp', 'Alpha'), entry('B.esp', 'Beta')], [{ kind: 'mod', name: 'Alpha' }, { kind: 'mod', name: 'Beta' }]],
    ['the mod as the mod list spells it, whatever the origin\'s case', [entry('A.esp', 'alpha')], [{ kind: 'mod', name: 'Alpha' }]],
    ['Overwrite for a plugin Overwrite holds', [entry('A.esp', OVERWRITE_ORIGIN)], [{ kind: 'runtimeOutput' }]],
    ['nothing for a plugin from the game folder, or from no listed mod', [entry('A.esp', DATA_DIRECTORY_ORIGIN), entry('B.esp', 'Gone')], []],
  ])('is %s', async (_case, plugins, origins) => {
    const { relatedTo } = await relating(plugins);

    expect(relatedTo(...plugins).origins).toEqual(origins);
  });

  it('is nothing for rows of any other kind', async () => {
    const { relatedToOtherRows } = await relating([entry('A.esp', 'Alpha')]);

    expect(relatedToOtherRows()).toEqual({ plugins: [], origins: [] });
  });
});

describe('the plugin rows a Plugins selection\'s masters are', () => {
  const DEP = entry('Dep.esp', 'Alpha');
  const PLUGINS = [DEP, entry('Base.esm', 'Gamma', false), entry('Base.esm', 'Beta')];

  it.each([
    ['the row the game loads for each master\'s file name, whatever its case', ['base.ESM'], [{ name: 'Base.esm', origin: 'Beta' }]],
    ['nothing for a master no row holds', ['Ghost.esm'], []],
    ['nothing for a plugin with no masters', [] as string[], []],
  ])('is %s', async (_case, masters, expected) => {
    const { relatedTo } = await relating(PLUGINS, { 'Dep.esp': masters });

    expect(relatedTo(DEP).plugins).toEqual(expected);
  });

  it('includes a master the game loads with no line', async () => {
    const { relatedTo } = await relating([DEP], { 'Dep.esp': ['Fallout4.esm'] }, [{ name: 'Fallout4.esm', origin: 'Data/', path: '/data/Fallout4.esm' }]);

    expect(relatedTo(DEP).plugins).toEqual([{ name: 'Fallout4.esm', origin: 'Data/' }]);
  });
});
