import { describe, expect, it } from 'vitest';
import { heldTexts, type RenamePlan, type ResolvedPlugin } from '../../symbolNames/symbolNames';
import type { MEditClient } from '../MEditClient';
import { recordIndexReferences, type SourceFilesOf } from '../recordIndexReferences';

const symbol = { name: 'Base.esm', origin: 'BaseMod' };
const child = { name: 'Child.esp', origin: 'ChildMod' };

type PlanClient = Pick<MEditClient, 'getPluginNameReferences' | 'getRenameSourceChanges' | 'moveLastWritten'>;

const unasked = (): never => { throw new Error('not asked'); };

const SOURCE_FILES = [{ from: 'Base - Main.ba2', to: 'New - Main.ba2' }];
const sourceFiles: SourceFilesOf = () => Promise.resolve(SOURCE_FILES);

const SOURCE_CHANGES = {
  treeName: 'BASE.esm',
  moves: [{ from: '/source/plugin-source/BASE.esm', to: '/source/plugin-source/New.esm' }],
  deletions: [],
  documents: [{ path: '/source/plugin-source/Patch.esp/Npc.json', text: '{"Race":"000800:New.esm"}' }],
  leftBehind: [{ plugin: { name: 'Broken.esp', origin: 'SourceMod' }, reason: "'Npc.json' is no JSON document." }],
};

function planClient(answers: Partial<PlanClient> = {}): PlanClient & { moved: unknown[][]; asked: unknown[][] } {
  const moved: unknown[][] = [];
  const asked: unknown[][] = [];
  return {
    moved,
    asked,
    getPluginNameReferences: () => Promise.resolve([]),
    getRenameSourceChanges: (...args) => { asked.push(args); return Promise.resolve(SOURCE_CHANGES); },
    moveLastWritten: (...args) => { moved.push(args); return Promise.resolve({ moved: true }); },
    ...answers,
  };
}

const WINNING = [{ ...symbol, winning: true }];
const LOSING = [{ ...symbol, origin: 'Other Mod', winning: true }, { ...symbol, winning: false }];

const planned = async (client: PlanClient, plugins: readonly ResolvedPlugin[] = WINNING): Promise<RenamePlan> => {
  const plan = await recordIndexReferences(client, sourceFiles).plan(symbol, 'New.esm', heldTexts([]), plugins);
  if ('refused' in plan) throw new Error(plan.refused);
  return plan;
};

describe('the record index says where plugins name a plugin (ADR-0028)', () => {
  it('answers each copy that names the plugin, named by its file name alone', async () => {
    const owner = recordIndexReferences({
      getPluginNameReferences: () => Promise.resolve([{ formKey: '000800:Base.esm', plugin: child, inPluginSource: false }]),
      getRenameSourceChanges: unasked, moveLastWritten: unasked,
    }, sourceFiles);

    expect(await owner.read(symbol, heldTexts([]))).toEqual({
      references: [{ copy: { formKey: '000800:Base.esm', plugin: child }, names: { name: 'Base.esm' } }], leftOut: [],
    });
  });

  it('leaves out every plugin, saying why, when mEdit cannot answer', async () => {
    const owner = recordIndexReferences(planClient({ getPluginNameReferences: () => Promise.resolve({ failed: 'refused', refusal: 'mEdit is still indexing plugins.' }) }), sourceFiles);

    expect(await owner.read(symbol, heldTexts([]))).toEqual({ references: [], leftOut: ['the plugins mEdit reads: mEdit is still indexing plugins.'] });
  });
});

describe('the record index plans a rename of a plugin (ADR-0028)', () => {
  it('changes the plugin source and the source folder\'s files mEdit answers, and moves what Modbench last wrote once they are applied', async () => {
    const client = planClient();

    const plan = await planned(client);

    expect(plan.changes).toEqual({ moves: SOURCE_CHANGES.moves, deletions: [], documents: SOURCE_CHANGES.documents });
    expect(client.asked).toEqual([[symbol, 'New.esm', { namedByFileName: true, sourceFiles: SOURCE_FILES }]]);
    expect(client.moved).toEqual([]);
    expect(await plan.commit()).toBeUndefined();
    expect(client.moved).toEqual([[symbol, 'BASE.esm', 'New.esm']]);
  });

  it('cannot carry a plugin source that does not read, nor a copy in a plugin with no plugin source, but the plugin\'s own', async () => {
    const plan = await planned(planClient({
      getPluginNameReferences: () => Promise.resolve([
        { formKey: '000000:Child.esp', plugin: child, inPluginSource: false },
        { formKey: '000801:Patch.esp', plugin: { name: 'Patch.esp', origin: 'SourceMod' }, inPluginSource: true },
        { formKey: '000800:Base.esm', plugin: { name: 'base.ESM', origin: 'BaseMod' }, inPluginSource: false },
      ]),
    }));

    expect(plan.cannotFollow).toEqual(["Broken.esp (SourceMod): 'Npc.json' is no JSON document.", '000000:Child.esp in Child.esp (ChildMod)']);
  });

  it('carries no name a copy\'s file name gives it when mod order resolves that name to another copy', async () => {
    const client = planClient({ getPluginNameReferences: () => Promise.resolve([{ formKey: '000000:Child.esp', plugin: child, inPluginSource: false }]) });

    const plan = await planned(client, LOSING);

    expect(client.asked).toEqual([[symbol, 'New.esm', { namedByFileName: false, sourceFiles: SOURCE_FILES }]]);
    expect(plan.cannotFollow).toEqual(["Broken.esp (SourceMod): 'Npc.json' is no JSON document."]);
  });

  it('cannot carry what the plugins mEdit reads name when mEdit cannot say', async () => {
    const plan = await planned(planClient({ getPluginNameReferences: () => Promise.resolve({ failed: 'refused', refusal: 'mEdit is still indexing plugins.' }) }));

    expect(plan.cannotFollow).toContain('the plugins mEdit reads: mEdit is still indexing plugins.');
  });

  it('refuses the rename mEdit refuses', async () => {
    const owner = recordIndexReferences(planClient({ getRenameSourceChanges: () => Promise.resolve({ refused: true, message: 'Old.esp\'s source was not renamed.' }) }), sourceFiles);

    expect(await owner.plan(symbol, 'New.esm', heldTexts([]), WINNING)).toEqual({ refused: 'Old.esp\'s source was not renamed.' });
  });

  it('answers why its commit failed when mEdit refuses to move what Modbench last wrote', async () => {
    const plan = await planned(planClient({ moveLastWritten: () => Promise.resolve({ refused: true, message: 'git refused the ref.' }) }));

    expect(await plan.commit()).toBe('git refused the ref.');
  });
});
