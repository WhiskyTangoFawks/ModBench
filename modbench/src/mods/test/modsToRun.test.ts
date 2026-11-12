import { describe, it, expect, vi } from 'vitest';

vi.mock('vscode', () => ({ TreeItem: class { constructor(readonly label: string) {} } }));

import { everyModHere, modsAndSourceModsOfAgent, modsAndSourceModsToRun, modsOfAgent, modsToRun, type ModsToRun } from '../modsToRun';
import type { Argument } from '../../wire/argument';
import { instanceValueFixture } from '../../test/mo2/instanceValueFixture';

const value = instanceValueFixture({
  mods: [
    { kind: 'mod', name: 'ModA', enabled: true },
    { kind: 'separator', name: 'Weapons', enabled: true },
    { kind: 'mod', name: 'ModB', enabled: false },
  ],
  modFolders: [
    { kind: 'mod', name: 'ModA', path: '/instance/mods/ModA', modName: 'ModA' },
    { kind: 'separator', name: 'Weapons', path: '/instance/mods/Weapons_separator', modName: 'Weapons_separator' },
    { kind: 'mod', name: 'ModB', path: '/instance/mods/ModB', modName: 'ModB' },
    { kind: 'mod', name: 'InAnotherProfile', path: '/instance/mods/InAnotherProfile', modName: 'InAnotherProfile' },
  ],
});
const EVERY_MOD = ['ModA', 'ModB', 'InAnotherProfile'];
const MODS_VIEW = 'modbench.modList';
const TOOLBOX = 'modbench.toolbox';

const modRow = (name: string) => ({ argument: { kind: 'mod', name }, name });
const separatorRow = (name: string) => ({ argument: { kind: 'separator', name }, name });
const folderRow = { argument: { kind: 'folder', path: '/instance/mods/ModA/meshes' }, name: 'meshes' };

const focused = (id: string | undefined, selection: readonly unknown[] = []) => ({
  toolboxView: TOOLBOX, instance: { value }, focusedView: { id: () => id, selection: () => selection },
});
const everyModUnder = (view: string, mods: readonly string[]): ModsToRun => ({ mods, sourceMods: [], refused: [], everyMod: true, view });
const named = (mods: readonly string[], refused: ModsToRun['refused'] = []): ModsToRun => ({ mods, sourceMods: [], refused, everyMod: false, view: MODS_VIEW });

describe('the mods a Mods gesture runs over (instance-repository.md, Every mod)', () => {
  it.each<[string, ReturnType<typeof focused>, unknown, readonly unknown[] | undefined, ModsToRun]>([
    ['every mod folder, no separator, in every profile, from the palette with no Mods selection', focused(undefined), undefined, undefined, everyModUnder(TOOLBOX, EVERY_MOD)],
    ['the Mods selection from the palette while Mods has the focus', focused(MODS_VIEW, [modRow('ModB')]), undefined, undefined, named(['ModB'])],
    ['every mod from the palette while another view has the focus', focused('modbench.pluginListTree', [modRow('ModB')]), undefined, undefined, everyModUnder(TOOLBOX, EVERY_MOD)],
    ['every mod for a clicked thing that is no row, whatever Mods has selected', focused(MODS_VIEW, [modRow('ModB')]), { rootUri: undefined }, undefined, everyModUnder(TOOLBOX, EVERY_MOD)],
    ['the selected mods for a clicked mod row', focused(undefined), modRow('ModB'), [modRow('ModA'), modRow('ModB')], named(['ModA', 'ModB'])],
    ['a separator for the mods it holds alone, each name once', focused(undefined), separatorRow('Weapons'), [separatorRow('Weapons'), modRow('ModB'), modRow('ModA')], named(['ModA', 'ModB'])],
    ['a separator named without its case as the mod manager names it', focused(undefined), separatorRow('weapons'), [separatorRow('weapons')], named(['ModA'])],
    ['a selected row that is neither a mod nor a separator refused, naming it', focused(undefined), modRow('ModA'), [modRow('ModA'), folderRow],
      named(['ModA'], [{ item: 'meshes', reason: 'it is not a mod or a separator' }])],
  ])('are %s', (_case, deps, clicked, selected, expected) => {
    expect(modsToRun(deps, clicked, selected)).toEqual(expected);
  });

  it('are every mod under the Mods view from its title bar', () => {
    expect(everyModHere({ instance: { value } })).toEqual(everyModUnder(MODS_VIEW, EVERY_MOD));
  });

  describe('update manifest and a source mod a separator holds (instance-repository.md, Update manifest, story 1)', () => {
    const sourceModValue = (sourceMod: string) => ({ ...value, paths: { ...value.paths, sourceDirs: new Map([[sourceMod, `/instance/source/${sourceMod}`]]) } });
    const weapons: Argument = { kind: 'separator', name: 'Weapons' };
    const mod = (name: string): Argument => ({ kind: 'mod', name });
    const modsRun = (path: 'view' | 'agent', sourceMod: string, argument: readonly Argument[]): readonly string[] => {
      const instance = { value: sourceModValue(sourceMod) };
      const rows = argument.map((row) => ({ argument: row, name: 'name' in row ? row.name : '' }));
      return path === 'view'
        ? modsAndSourceModsToRun({ ...focused(undefined), instance }, rows[0], rows).mods
        : modsAndSourceModsOfAgent(argument, instance.value).mods;
    };

    it.each([
      ['view', 'ModA', [weapons], []],
      ['view', 'ModA', [weapons, mod('ModA')], ['ModA']],
      ['view', 'ModB', [weapons], ['ModA']],
      ['view', 'ModB', [mod('ModB')], ['ModB']],
      ['agent', 'ModA', [weapons], []],
      ['agent', 'ModA', [weapons, mod('ModA')], ['ModA']],
      ['agent', 'ModB', [weapons], ['ModA']],
      ['agent', 'ModB', [mod('ModB')], ['ModB']],
    ] as const)('through the %s, with %s the source mod, %j gives %j', (path, sourceMod, argument, expected) => {
      expect(modsRun(path, sourceMod, argument)).toEqual(expected);
    });
  });
});

describe('the mods an agent call runs over', () => {
  const mod = (name: string): Argument => ({ kind: 'mod', name });
  const separator = (name: string): Argument => ({ kind: 'separator', name });

  it.each<[string, Argument[], readonly string[]]>([
    ['every mod for a call naming none', [], EVERY_MOD],
    ['the mods given, a separator for the mods it holds alone, each once', [mod('ModA'), separator('Weapons')], ['ModA']],
  ])('are %s', (_case, argument, expected) => {
    expect(modsOfAgent(argument, value)).toEqual(expected);
  });
});
