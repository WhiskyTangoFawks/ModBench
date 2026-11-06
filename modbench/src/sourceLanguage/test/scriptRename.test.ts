import { describe, expect, it, vi } from 'vitest';
import { Uri } from '../../test/vscodeMock';

vi.mock('vscode', () => ({ Uri }));

import { scriptRename } from '../scriptRename';
import { heldTexts, type FileChanges } from '../../symbolNames/symbolNames';
import type { PluginAddress } from '../../wire/pluginAddress';

const QUEST = '000801:Mod.esp';
const ALIAS = '000802:Mod.esp';
const CONTAINER = '/instance/source/Mod/plugin-source/Mod.esp/Quest.json';
const SCRIPTS = (formKey: string, name: string) => `{ "FormKey": "${formKey}", "VirtualMachineAdapter": { "Scripts": [ { "Name": "${name}" } ] } }`;
const TEXT = `[ ${SCRIPTS(QUEST, 'ns:quest')}, ${SCRIPTS(ALIAS, 'Ns:Quest')} ]`;
const PATH = 'VirtualMachineAdapter.Scripts[0].Name';
const MOD = { name: 'Mod.esp', origin: 'Mod' };
const COMPILED = { name: 'Other.esp', origin: 'Other' };

type Answer = Awaited<ReturnType<Parameters<typeof scriptRename>[0]['client']['getScriptReferences']>>;

function renaming(answer: Answer, unsaved?: string) {
  const applied: (readonly FileChanges[])[] = [];
  const touched: (readonly PluginAddress[])[] = [];
  const rename = scriptRename({
    client: {
      getScriptReferences: () => Promise.resolve(answer),
      getRecordOwner: () => Promise.resolve(undefined),
      getCopyDocument: () => Promise.resolve({ kind: 'ContainersFile' as const, location: CONTAINER }),
    },
    readText: () => Promise.resolve(TEXT),
  });
  const editing = (plugins: readonly PluginAddress[]) => ({
    held: heldTexts(unsaved === undefined ? [] : [[CONTAINER, unsaved]]),
    apply: (changes: readonly FileChanges[]) => {
      touched.push(plugins);
      applied.push(changes);
      return Promise.resolve(undefined);
    },
  });
  return { follow: () => rename(editing, 'Ns:Quest', 'Ns:Renamed'), applied, touched };
}

describe('a Papyrus script renamed from the Explorer (symbols.md, The features, stories 6 and 7)', () => {
  it('names it anew in each record its plugin source holds that attaches it, as one edit of each file', async () => {
    const { follow, applied, touched } = renaming([
      { formKey: QUEST, plugin: MOD, inPluginSource: true, fieldPaths: [PATH] },
      { formKey: ALIAS, plugin: MOD, inPluginSource: true, fieldPaths: [PATH] },
    ]);

    expect(await follow()).toEqual({ applied: true, cannotFollow: [] });
    expect(applied).toEqual([[{ moves: [], deletions: [], documents: [{ path: CONTAINER, text: TEXT.replace('ns:quest', 'Ns:Renamed').replace('Ns:Quest', 'Ns:Renamed') }] }]]);
    expect(touched).toEqual([[MOD]]);
  });

  it('reads a file\'s unsaved text in place of the file', async () => {
    const unsaved = `[ ${SCRIPTS(QUEST, 'Ns:Quest')} ]`;
    const { follow, applied } = renaming([{ formKey: QUEST, plugin: MOD, inPluginSource: true, fieldPaths: [PATH] }], unsaved);

    await follow();

    expect(applied[0]?.[0]?.documents).toEqual([{ path: CONTAINER, text: unsaved.replace('Ns:Quest', 'Ns:Renamed') }]);
  });

  it('lands with each record that cannot follow named: one in a plugin with no plugin source, and one whose file does not name it where mEdit says', async () => {
    const { follow, applied } = renaming([
      { formKey: QUEST, plugin: COMPILED, inPluginSource: false, fieldPaths: [PATH] },
      { formKey: QUEST, plugin: MOD, inPluginSource: true, fieldPaths: ['VirtualMachineAdapter.Scripts[1].Name'] },
    ]);

    expect(await follow()).toEqual({
      applied: true,
      cannotFollow: [
        `${QUEST} in Other.esp (Other)`,
        `${QUEST} in Mod.esp (Mod): its plugin source does not name Ns:Quest at VirtualMachineAdapter.Scripts[1].Name`,
      ],
    });
    expect(applied).toEqual([[{ moves: [], deletions: [], documents: [] }]]);
  });

  it('carries no reference when mEdit cannot say which records attach it, saying why', async () => {
    const { follow, applied } = renaming({ failed: 'refused', refusal: 'the record index is not ready' });

    expect(await follow()).toEqual({ applied: false, refusal: 'the plugins mEdit reads: the record index is not ready' });
    expect(applied).toEqual([]);
  });
});
