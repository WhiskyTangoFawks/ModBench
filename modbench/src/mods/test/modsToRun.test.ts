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

describe('the mods a Mods gesture runs over (modlist-repository.md, Every mod)', () => {
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

  it('skips a source mod held by a selected separator when updating its manifest', () => {
    const sourceModValue = { ...value, paths: { ...value.paths, sourceDirs: new Map([['ModB', '/instance/source/ModB']]) } };

    expect(modsAndSourceModsToRun({ ...focused(undefined), instance: { value: sourceModValue } }, separatorRow('Weapons'), [separatorRow('Weapons')]))
      .toEqual(named(['ModA']));
  });

  it('skips a source mod held by a separator in an agent update-manifest call, but keeps a directly named source mod', () => {
    const sourceModValue = { ...value, paths: { ...value.paths, sourceDirs: new Map([['ModB', '/instance/source/ModB']]) } };
    const separator: Argument = { kind: 'separator', name: 'Weapons' };

    expect(modsAndSourceModsOfAgent([separator], sourceModValue)).toEqual({ mods: ['ModA'], sourceMods: [], refused: [] });
    expect(modsAndSourceModsOfAgent([{ kind: 'mod', name: 'ModB' }], sourceModValue)).toEqual({ mods: ['ModB'], sourceMods: [], refused: [] });
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
