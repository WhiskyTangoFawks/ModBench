import { describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => import('./vscodeHost'));

import { host } from './vscodeHost';
import { instanceHolding, symbolsOver } from './symbolsOver';
import { mEditNames, spelledName } from './mEditNames';
import type { DocumentName } from '../../client';
import type { MEditClient } from '../../client/MEditClient';
import type { SymbolOwner } from '../../symbolNames/symbolNames';
import { instanceValueFixture } from '../../test/mo2/instanceValueFixture';

const SOURCE = '/instance/source/Patch Mod/plugin-source/Patch.esp/Npcs/PatchNpc - 000800_Patch.esp.json';
const TEXT = '{ "FormKey": "000800:Patch.esp", "EditorID": "PatchNpc", "Race": "000801:Base.esm", "Ref": "000802:Gone.esp", "Game": "000803:Fallout4.esm", "Name": "Npc" }';
const at = (snippet: string) => `${TEXT.slice(0, TEXT.indexOf(snippet) + 2)}|${TEXT.slice(TEXT.indexOf(snippet) + 2)}`;
const PATCH = { name: 'Patch.esp', origin: 'Patch Mod' };
const BASE = { name: 'Base.esm', origin: 'Base Mod' };
const PLUGINS = [
  { ...BASE, path: '/mods/Base Mod/Base.esm', line: 0, enabled: true, winning: true },
  { name: 'Fallout4.esm', origin: 'Data/', path: '/game/Data/Fallout4.esm', line: null, enabled: true, winning: true },
  { name: 'Base.esm', origin: 'Losing Mod', path: '/mods/Losing Mod/Base.esm', line: 1, enabled: true, winning: false },
];
const formKeyLinking = (formKey: string, plugin: string): DocumentName[] => [
  spelledName('Record', TEXT, `"${formKey}"`, { value: formKey, record: formKey, fieldPath: 'Race' }), spelledName('Plugin', TEXT, plugin),
];
const NAMES = mEditNames(() => [
  ...formKeyLinking('000801:Base.esm', 'Base.esm'), ...formKeyLinking('000802:Gone.esp', 'Gone.esp'), ...formKeyLinking('000803:Fallout4.esm', 'Fallout4.esm'),
  spelledName('EditorId', TEXT, 'PatchNpc', { record: '000800:Patch.esp' }),
]);

type FileAnswer = Awaited<ReturnType<MEditClient['getRecordOfFile']>>;

function renaming({ pluginNamed, file = { formKey: '000800:Patch.esp', plugin: PATCH } }: { pluginNamed?: string; file?: FileAnswer } = {}) {
  const owner: SymbolOwner = {
    read: () => Promise.resolve({ references: [], leftOut: [] }), nameAt: () => Promise.resolve(pluginNamed === undefined ? undefined : { name: pluginNamed }), plan: () => Promise.reject(new Error('Not planned here.')),
  };
  return symbolsOver({
    instance: instanceHolding(instanceValueFixture({ plugins: PLUGINS })), owners: [owner], names: NAMES,
    arrange: (client) => { client.setQueryAnswer('getRecordOfFile', file); },
  });
}

const executed = () => host.executed.filter(([id]) => id !== 'setContext');

describe('Rename Symbol (symbols.md, The features, story 6)', () => {
  it('on a plugin\'s name, is the plugin\'s rename, before any record\'s edit', async () => {
    renaming({ pluginNamed: 'Base.esm' });

    expect(await host.prepareRename(SOURCE, at('Base.esm'))).toEqual({ spans: 'Base.esm', placeholder: 'Base.esm' });
    await host.rename(SOURCE, at('Base.esm'), 'New.esm');

    expect(executed()).toEqual([['modbench.plugin.rename', undefined, undefined, { plugin: BASE, name: 'New.esm' }]]);
  });

  it.each([
    ['a FormKey a record links, in the copy mod order resolves its plugin to', '000801', '000801:Base.esm', '000900:Base.esm',
      { formKey: '000801:Base.esm', plugin: 'Base.esm', origin: 'Base Mod' }, 'FormKey'],
    ['the EditorID, in the copy the file holds', 'PatchNpc', 'PatchNpc', 'Renamed',
      { formKey: '000800:Patch.esp', plugin: 'Patch.esp', origin: 'Patch Mod' }, 'EditorID'],
  ])('on %s, is edit field on it', async (_case, snippet, placeholder, newName, address, member) => {
    renaming();

    const offered = await host.prepareRename(SOURCE, at(snippet));
    await host.rename(SOURCE, at(snippet), newName);

    expect(offered).toEqual({ spans: placeholder, placeholder });
    expect(executed()).toEqual([['modbench.record.editField', address, { op: 'set', path: [{ kind: 'member', name: member }], value: newName }]]);
  });

  it('offers nothing where plugin source names no FormKey or EditorID', async () => {
    renaming();

    await expect(host.prepareRename(SOURCE, at('"Npc"'))).rejects.toThrow('Rename Symbol renames a plugin, a mod or a separator, or changes a record\'s FormKey or EditorID, and none is here.');
  });

  it.each([
    ['a FormKey whose plugin mod order resolves to no copy', '000802', 'Mod order resolves Gone.esp to no plugin.', undefined],
    ['a FormKey whose plugin mod order resolves to the game folder\'s copy', '000803', 'Fallout4.esm is a plugin in the game folder, not in a mod: only a plugin in a mod renames.', undefined],
    ['an EditorID in a file that holds no record', 'PatchNpc', 'mEdit says this file holds no record.', null],
    ['an EditorID in a file mEdit cannot read', 'PatchNpc', 'mEdit could not be reached.', { failed: 'unreachable' } as const],
  ])('refuses %s, and edits nothing', async (_case, snippet, refusal, file) => {
    renaming(file === undefined ? {} : { file });

    await expect(host.rename(SOURCE, at(snippet), 'New')).rejects.toThrow(refusal);
    expect(executed()).toEqual([]);
  });
});
