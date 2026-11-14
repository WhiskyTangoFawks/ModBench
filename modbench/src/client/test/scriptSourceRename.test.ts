import { describe, expect, it, vi } from 'vitest';
import { scriptSourceRename } from '../scriptSourceRename';
import { heldTexts } from '../../symbolNames/symbolNames';
import type { DocumentName } from '../MEditClient';

const QUEST = '000801:Mod.esp';
const ALIAS = '000802:Mod.esp';
const CONTAINER = '/instance/source/Mod/plugin-source/Mod.esp/Quest.json';
const SCRIPTS = (formKey: string, name: string) => `{ "FormKey": "${formKey}", "VirtualMachineAdapter": { "Scripts": [ { "Name": "${name}" } ] } }`;
const TEXT = `[ ${SCRIPTS(QUEST, 'ns:quest')}, ${SCRIPTS(ALIAS, 'Ns:Quest')} ]`;
const PATH = 'VirtualMachineAdapter.Scripts[0].Name';
const MOD = { name: 'Mod.esp', origin: 'Mod' };
const COMPILED = { name: 'Other.esp', origin: 'Other' };

type Answer = Awaited<ReturnType<Parameters<typeof scriptSourceRename>[0]['client']['getScriptReferences']>>;

const firstScriptOfEachRecordIn = (text: string): DocumentName[] =>
  [...text.matchAll(/"FormKey": "([^"]+)", "VirtualMachineAdapter": \{ "Scripts": \[ \{ "Name": "/g)].map((found) => {
    const start = found.index + found[0].length;
    const value = text.slice(start, text.indexOf('"', start));
    return { kind: 'Script', start, end: start + value.length, value, record: found[1], fieldPath: PATH };
  });

const planning = (answer: Answer, unsaved?: string, refreshSourceControlFor = vi.fn()) => scriptSourceRename({
  client: {
    getScriptReferences: () => Promise.resolve(answer),
    getPluginSourceNames: (text) => Promise.resolve(firstScriptOfEachRecordIn(text)),
    getCopyDocument: (plugin) => Promise.resolve(plugin.origin === 'Gone' ? null : { kind: plugin.origin === 'Rendered' ? 'Rendered' as const : 'ContainersFile' as const, location: CONTAINER }),
  },
  readText: () => Promise.resolve(TEXT),
  refreshSourceControlFor,
}).plan({ kind: 'script', name: 'Ns:Quest' }, 'Ns:Renamed', heldTexts(unsaved === undefined ? [] : [[CONTAINER, unsaved]]));

const planned = async (answer: Answer, unsaved?: string) => {
  const plan = await planning(answer, unsaved);
  if ('refused' in plan) throw new Error(plan.refused);
  return { changes: plan.changes, cannotFollow: plan.cannotFollow };
};

describe('plugin source\'s part in renaming a Papyrus script (symbols.md, The features, stories 6 and 7)', () => {
  it('names it anew in each record its plugin source holds that attaches it, as one edit of each file', async () => {
    expect(await planned({
      copies: [{ formKey: QUEST, plugin: MOD, inPluginSource: true, fieldPaths: [PATH] }, { formKey: ALIAS, plugin: MOD, inPluginSource: true, fieldPaths: [PATH] }],
      unread: [],
    })).toEqual({
      changes: { moves: [], deletions: [], documents: [{ path: CONTAINER, text: TEXT.replace('ns:quest', 'Ns:Renamed').replace('Ns:Quest', 'Ns:Renamed') }] },
      cannotFollow: [],
    });
  });

  it('refreshes Source Control, once its edit applied, for each plugin whose source it edited', async () => {
    const refreshSourceControlFor = vi.fn();
    const plan = await planning({
      copies: [
        { formKey: QUEST, plugin: MOD, inPluginSource: true, fieldPaths: [PATH] },
        { formKey: ALIAS, plugin: MOD, inPluginSource: true, fieldPaths: [PATH] },
        { formKey: QUEST, plugin: COMPILED, inPluginSource: false, fieldPaths: [PATH] },
      ],
      unread: [],
    }, undefined, refreshSourceControlFor);
    if ('refused' in plan) throw new Error(plan.refused);
    expect(refreshSourceControlFor).not.toHaveBeenCalled();

    await plan.commit();

    expect(refreshSourceControlFor.mock.calls).toEqual([[MOD]]);
  });

  it('reads a file\'s unsaved text in place of the file', async () => {
    const unsaved = `[ ${SCRIPTS(QUEST, 'Ns:Quest')} ]`;

    const { changes } = await planned({ copies: [{ formKey: QUEST, plugin: MOD, inPluginSource: true, fieldPaths: [PATH] }], unread: [] }, unsaved);

    expect(changes.documents).toEqual([{ path: CONTAINER, text: unsaved.replace('Ns:Quest', 'Ns:Renamed') }]);
  });

  it('edits no record that cannot follow, and names each: one in a plugin with no plugin source, one mEdit could not read, and one whose file does not name it where mEdit says', async () => {
    expect(await planned({
      copies: [
        { formKey: QUEST, plugin: COMPILED, inPluginSource: false, fieldPaths: [PATH] },
        { formKey: QUEST, plugin: MOD, inPluginSource: true, fieldPaths: ['VirtualMachineAdapter.Scripts[1].Name'] },
      ],
      unread: [`${ALIAS} in Mod.esp (Mod): mEdit has no schema for its record type xxxx`],
    })).toEqual({
      changes: { moves: [], deletions: [], documents: [] },
      cannotFollow: [
        `${QUEST} in Other.esp (Other)`,
        `${ALIAS} in Mod.esp (Mod): mEdit has no schema for its record type xxxx`,
        `${QUEST} in Mod.esp (Mod): its plugin source does not name Ns:Quest at VirtualMachineAdapter.Scripts[1].Name`,
      ],
    });
  });

  it('edits no copy mEdit says is in plugin source where no plugin source file holds it, and names each', async () => {
    expect(await planned({
      copies: [
        { formKey: QUEST, plugin: { name: 'Mod.esp', origin: 'Gone' }, inPluginSource: true, fieldPaths: [PATH] },
        { formKey: QUEST, plugin: { name: 'Mod.esp', origin: 'Rendered' }, inPluginSource: true, fieldPaths: [PATH] },
      ],
      unread: [],
    })).toEqual({
      changes: { moves: [], deletions: [], documents: [] },
      cannotFollow: [`Mod.esp (Gone) holds no ${QUEST}.`, `${QUEST} in Mod.esp (Rendered): its plugin source holds no file of it`],
    });
  });

  it('names what mEdit could not read when it cannot say which records attach it', async () => {
    expect(await planned({ failed: 'refused', refusal: 'the record index is not ready' })).toEqual({
      changes: { moves: [], deletions: [], documents: [] },
      cannotFollow: ['the plugins mEdit reads: the record index is not ready'],
    });
  });
});
