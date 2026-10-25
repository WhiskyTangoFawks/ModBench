import { describe, it, expect, vi } from 'vitest';

vi.mock('vscode', () => ({ TreeItem: class { constructor(readonly label: string) {} } }));

import { everyModHere, modsOfAgent, modsToRun, type ModsToRun, type Scope } from '../modsToRun';
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
const EVERY_MOD_AND_SEPARATOR = ['ModA', 'Weapons_separator', 'ModB', 'InAnotherProfile'];
const EVERY_MOD = ['ModA', 'ModB', 'InAnotherProfile'];
const MODS_VIEW = 'modbench.modList';
const TOOLBOX = 'modbench.toolbox';

const modRow = (name: string) => ({ argument: { kind: 'mod', name }, name });
const separatorRow = (name: string) => ({ argument: { kind: 'separator', name }, name });
const folderRow = { argument: { kind: 'folder', path: '/instance/mods/ModA/meshes' }, name: 'meshes' };

const focused = (id: string | undefined, selection: readonly unknown[] = []) => ({
  toolboxView: TOOLBOX, instance: { value }, focusedView: { id: () => id, selection: () => selection },
});
const everyModUnder = (view: string, mods: readonly string[]): ModsToRun => ({ mods, refused: [], everyMod: true, view });
const named = (mods: readonly string[], refused: ModsToRun['refused'] = []): ModsToRun => ({ mods, refused, everyMod: false, view: MODS_VIEW });

describe('the mods a Mods gesture runs over (modlist-repository.md, Every mod)', () => {
  it.each<[string, ReturnType<typeof focused>, unknown, readonly unknown[] | undefined, Scope, ModsToRun]>([
    ['every mod folder and separator, in every profile, from the palette with no Mods selection', focused(undefined), undefined, undefined, 'modsAndSeparators',
      everyModUnder(TOOLBOX, EVERY_MOD_AND_SEPARATOR)],
    ['every mod folder alone, for a gesture over mods only', focused(undefined), undefined, undefined, 'modsOnly', everyModUnder(TOOLBOX, EVERY_MOD)],
    ['the Mods selection from the palette while Mods has the focus', focused(MODS_VIEW, [modRow('ModB')]), undefined, undefined, 'modsAndSeparators', named(['ModB'])],
    ['every mod from the palette while another view has the focus', focused('modbench.pluginListTree', [modRow('ModB')]), undefined, undefined, 'modsAndSeparators',
      everyModUnder(TOOLBOX, EVERY_MOD_AND_SEPARATOR)],
    ['every mod for a clicked thing that is no row, whatever Mods has selected', focused(MODS_VIEW, [modRow('ModB')]), { rootUri: undefined }, undefined, 'modsAndSeparators',
      everyModUnder(TOOLBOX, EVERY_MOD_AND_SEPARATOR)],
    ['the selected mods for a clicked mod row', focused(undefined), modRow('ModB'), [modRow('ModA'), modRow('ModB')], 'modsAndSeparators', named(['ModA', 'ModB'])],
    ['a separator for itself and the mods it holds, each name once', focused(undefined), separatorRow('Weapons'), [separatorRow('Weapons'), modRow('ModB'), modRow('ModA')], 'modsAndSeparators',
      named(['Weapons_separator', 'ModA', 'ModB'])],
    ['a separator named without its case as the mod manager names it', focused(undefined), separatorRow('weapons'), [separatorRow('weapons')], 'modsAndSeparators',
      named(['Weapons_separator', 'ModA'])],
    ['a separator for its mods alone, for a gesture over mods only', focused(undefined), separatorRow('Weapons'), [separatorRow('Weapons')], 'modsOnly', named(['ModA'])],
    ['a selected row that is neither a mod nor a separator refused, naming it', focused(undefined), modRow('ModA'), [modRow('ModA'), folderRow], 'modsAndSeparators',
      named(['ModA'], [{ item: 'meshes', reason: 'it is not a mod or a separator' }])],
  ])('are %s', (_case, deps, clicked, selected, scope, expected) => {
    expect(modsToRun(deps, clicked, selected, scope)).toEqual(expected);
  });

  it.each<[Scope, readonly string[]]>([
    ['modsAndSeparators', EVERY_MOD_AND_SEPARATOR],
    ['modsOnly', EVERY_MOD],
  ])('are every mod under the Mods view from its title bar, over %s', (scope, mods) => {
    expect(everyModHere({ instance: { value } }, scope)).toEqual(everyModUnder(MODS_VIEW, mods));
  });
});

describe('the mods an agent call runs over', () => {
  const mod = (name: string): Argument => ({ kind: 'mod', name });
  const separator = (name: string): Argument => ({ kind: 'separator', name });

  it.each<[string, Argument[], Scope, readonly string[]]>([
    ['every mod and separator for a call naming none', [], 'modsAndSeparators', EVERY_MOD_AND_SEPARATOR],
    ['every mod for a call naming none, over mods only', [], 'modsOnly', EVERY_MOD],
    ['the mods given, a separator for itself and the mods it holds', [mod('ModB'), separator('Weapons')], 'modsAndSeparators', ['ModB', 'Weapons_separator', 'ModA']],
    ['the mods given, a separator for its mods alone, each once, over mods only', [mod('ModA'), separator('Weapons')], 'modsOnly', ['ModA']],
  ])('are %s', (_case, argument, scope, expected) => {
    expect(modsOfAgent(argument, value, scope)).toEqual(expected);
  });
});
