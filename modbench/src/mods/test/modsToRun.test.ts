import { describe, it, expect, vi } from 'vitest';

vi.mock('vscode', async () => (await import('./modsVscode')).vscodeModule);

import { modsViewOn } from './modsViewOn';
import { file, folder, indexedValueOf, mod } from './indexedValue';
import { progressSteps } from '../../test/recordedProgress';
import { FakeTreeView } from '../../drivingLib/test/nameFilterViewHarness';
import { AgentCall } from '../../drivingLib/agentGesture';
import type { ModlistEntry } from '../../instanceAdapter/instanceAdapter';
import type { InstanceValue } from '../../instanceLoader/instance';
import type { Argument, ArgumentOf } from '../../wire/argument';
import type { InstanceRepositoryCommands } from '../../sourceCommands/instanceRepositoryCommands';

const separator = (name: string): ModlistEntry => ({ kind: 'separator', name, enabled: true });
const MOD_FOLDERS = [
  { kind: 'mod' as const, name: 'ModA', path: '/instance/mods/ModA', modName: 'ModA' },
  { kind: 'separator' as const, name: 'Weapons', path: '/instance/mods/Weapons_separator', modName: 'Weapons_separator' },
  { kind: 'mod' as const, name: 'ModB', path: '/instance/mods/ModB', modName: 'ModB' },
  { kind: 'mod' as const, name: 'InAnotherProfile', path: '/instance/mods/InAnotherProfile', modName: 'InAnotherProfile' },
];
const EVERY_MOD = ['ModA', 'ModB', 'InAnotherProfile'];
const MODS_VIEW = 'modbench.modList';
const TOOLBOX = 'modbench.toolbox';

async function valueOf(): Promise<InstanceValue> {
  const value = await indexedValueOf(
    [separator('Pack - A'), separator('Pack - B'), mod('ModA'), separator('Weapons'), mod('ModB', false)],
    { ModA: { files: [file('ModA', 'meshes/a.nif')], folders: [folder('ModA', 'meshes')] } },
  );
  return { ...value, modFolders: MOD_FOLDERS };
}

async function viewOver() {
  const updateManifest = vi.fn<InstanceRepositoryCommands['updateManifest']>().mockResolvedValue({ notes: [], repositoryNotes: [], landed: [], refused: [] });
  const restoreFromManifest = vi.fn<InstanceRepositoryCommands['restoreFromManifest']>().mockResolvedValue({ landed: [], refused: [] });
  const checked: (readonly string[])[] = [];
  const shown = modsViewOn({
    value: await valueOf(),
    manifestGestures: { toolboxView: TOOLBOX, say: () => undefined, commands: { updateManifest, restoreFromManifest, ignoreFiles: vi.fn() } },
    checkForUpdates: (mods) => { checked.push(mods); return Promise.resolve({ applied: true, outcome: { landed: [], refused: [] } }); },
  });
  const ran = () => ({
    restored: restoreFromManifest.mock.calls.map(([mods, , everyMod]) => [mods, everyMod]),
    view: progressSteps[0],
    refused: shown.reporter.reports.map(({ detail }) => detail),
  });
  const modA = async () => shown.row('ModA', await shown.row('Weapons'));
  return { ...shown, updateManifest, checked, ran, modA };
}

type Shown = Awaited<ReturnType<typeof viewOver>>;

const focusingPlugins = async ({ focusedView, row }: Shown) => {
  const plugins = new FakeTreeView();
  focusedView.follow('modbench.pluginListTree', plugins);
  plugins.selectRows([await row('ModB')]);
  return [];
};

const selectingInMods = (...names: string[]) => async ({ view, row }: Shown) => {
  view.selectRows(await Promise.all(names.map(async (name) => await row(name))));
  return [];
};

const everyModUnder = (view: string) => ({ restored: [[EVERY_MOD, true]], view: `progress opens on ${view}`, refused: [] });
const named = (mods: readonly string[], refused: readonly string[] = []) => ({ restored: [[mods, false]], view: `progress opens on ${MODS_VIEW}`, refused });

describe('the mods a Mods gesture runs over (instance-repository.md, Every mod)', () => {
  it.each<[string, (shown: Shown) => Promise<unknown[]>, unknown]>([
    ['every mod folder, no separator, in every profile, from the palette with no Mods selection', () => Promise.resolve([]), everyModUnder(TOOLBOX)],
    ['the Mods selection from the palette while Mods has the focus', selectingInMods('ModB'), named(['ModB'])],
    ['every mod from the palette while another view has the focus', focusingPlugins, everyModUnder(TOOLBOX)],
    ['every mod for a clicked thing that is no row, whatever Mods has selected', async (shown) => { await selectingInMods('ModB')(shown); return [{ rootUri: undefined }]; },
      everyModUnder(TOOLBOX)],
    ['the selected mods for a clicked mod row', async ({ row, modA }) => [await row('ModB'), [await modA(), await row('ModB')]], named(['ModA', 'ModB'])],
    ['a separator for the mods it holds alone, each name once', async ({ row, modA }) => [await row('Weapons'), [await row('Weapons'), await row('ModB'), await modA()]],
      named(['ModA', 'ModB'])],
    ['a selected row that is neither a mod nor a separator refused, naming it', async ({ row, modA }) => [await modA(), [await modA(), await row('meshes', await modA())]],
      named(['ModA'], ['"meshes" (it is not a mod or a separator)'])],
    ['a selected separator group refused, naming it, and no mod run for it', selectingInMods('Pack'),
      { restored: [], view: undefined, refused: ['"Pack" (it is not a mod or a separator)'] }],
  ])('are %s', async (_case, entry, expected) => {
    const shown = await viewOver();
    const args = await entry(shown);

    await shown.run('modbench.mod.restoreFromManifest', ...args);

    expect(shown.ran()).toEqual(expected);
  });

  it('are every mod under the Mods view from its title bar', async () => {
    const shown = await viewOver();
    await selectingInMods('ModB')(shown);

    await shown.run('modbench.modList.restoreFromManifestHere');

    expect(shown.ran()).toEqual(everyModUnder(MODS_VIEW));
  });

  describe('update manifest and a source mod a separator holds (instance-repository.md, Update manifest, story 1)', () => {
    type Held = ArgumentOf<'mod' | 'separator'>;
    const weapons: Held = { kind: 'separator', name: 'Weapons' };
    const held = (name: string): Held => ({ kind: 'mod', name });
    const cases: readonly (readonly [string, readonly Held[], readonly string[]])[] = [
      ['ModA', [weapons], []],
      ['ModA', [weapons, held('ModA')], ['ModA']],
      ['ModB', [weapons], ['ModA']],
      ['ModB', [held('ModB')], ['ModB']],
    ];

    const withSourceMod = async (sourceMod: string) => {
      const shown = await viewOver();
      shown.instance.publish({ ...shown.instance.value, paths: { ...shown.instance.value.paths, sourceDirs: new Map([[sourceMod, `/instance/source/${sourceMod}`]]) } });
      return shown;
    };
    const rowOf: Record<string, (shown: Shown) => Promise<unknown>> = { Weapons: ({ row }) => row('Weapons'), ModA: ({ modA }) => modA(), ModB: ({ row }) => row('ModB') };

    it.each(cases)('the view, with %s the source mod, selecting %j, runs %j', async (sourceMod, selection, expected) => {
      const shown = await withSourceMod(sourceMod);
      const rows = await Promise.all(selection.map(async ({ name }) => await rowOf[name]?.(shown)));

      await shown.run('modbench.mod.updateManifest', rows[0], rows);

      expect(shown.updateManifest.mock.calls.map(([mods]) => mods)).toEqual([expected]);
    });

    it.each(cases)('the agent, with %s the source mod, naming %j, runs %j', async (sourceMod, argument, expected) => {
      const shown = await withSourceMod(sourceMod);

      await shown.run('modbench.mod.updateManifest', new AgentCall(argument, {}));

      expect(shown.updateManifest.mock.calls.map(([mods]) => mods)).toEqual([expected]);
    });
  });
});

describe('the mods an agent call runs over', () => {
  const named = (name: string): Argument => ({ kind: 'mod', name });
  const separatorNamed = (name: string): Argument => ({ kind: 'separator', name });

  it.each<[string, Argument[], readonly string[]]>([
    ['every mod for a call naming none', [], EVERY_MOD],
    ['the mods given, a separator for the mods it holds alone, each once', [named('ModA'), separatorNamed('Weapons')], ['ModA']],
    ['a separator named without its case as the mod manager names it', [separatorNamed('weapons')], ['ModA']],
  ])('are %s', async (_case, argument, expected) => {
    const shown = await viewOver();

    await shown.run('modbench.mod.checkForUpdates', new AgentCall(argument, {}));

    expect(shown.checked).toEqual([expected]);
  });
});
