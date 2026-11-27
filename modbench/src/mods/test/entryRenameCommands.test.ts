import { describe, it, expect, vi } from 'vitest';

vi.mock('vscode', async () => (await import('./modsVscode')).vscodeModule);

import { modsViewOn } from './modsViewOn';
import { answers, seen } from './modsVscode';
import { progressSteps } from '../../test/recordedProgress';
import { MODS_KEY_ARGS } from '../gestureEntry';
import { Refusal } from '../../drivingLib/refusal';
import { AgentCall } from '../../drivingLib/agentGesture';
import { present } from '../../ports/present';
import { instanceValueFixture } from '../../test/mo2/instanceValueFixture';
import { oneAtATime } from '../../textDocuments/oneAtATime';
import type { SourceEditing } from '../../textDocuments/sourceEditing';
import type { InstanceReading, ModlistEntry } from '../../instanceAdapter/instanceAdapter';
import { fakeInstanceAdapter, modFoldersOf, readingFixture, refusing, repositoriesOf, type AdapterCall, type InstanceAnswers } from '../../test/fakeInstanceAdapter';
import { mod } from './indexedValue';

const separator = (name: string): ModlistEntry => ({ kind: 'separator', name, enabled: true });

const validatorOfThePrompt = (): ((value: string) => unknown) => {
  const options = present(seen.inputBoxes.at(-1), 'the options of the prompt the gesture opened');
  return (value) => options.validateInput?.(value);
};

const typing = (name: string | undefined): void => { answers.inputBox = () => name; };

const SOURCE_MOVES = [{ from: '/instance/source/Mod A', to: '/source/Renamed' }];

function renamesOver(entries: readonly ModlistEntry[], { answers: answered = {}, reading = {} }: { answers?: InstanceAnswers; reading?: Partial<InstanceReading> } = {}) {
  const adapter = fakeInstanceAdapter(readingFixture({ mods: [...entries], modFolders: modFoldersOf(...entries), ...reading }), answered);
  const apply = vi.fn<SourceEditing['applyWorkspaceChanges']>().mockResolvedValue();
  const view = modsViewOn({
    value: instanceValueFixture({ mods: [...entries] }), adapter,
    source: { applyWorkspaceChanges: apply, oneAtATime: oneAtATime(), refreshSourceControlFor: () => undefined },
  });
  view.client.setCommandResult('getSourceFolderMoveChanges', { moves: SOURCE_MOVES, deletions: [], documents: [] });
  view.client.setCommandResult('followSourceFolderMove', { followed: true });
  return { ...view, apply };
}

const renamed = (calls: readonly AdapterCall[]) => calls.filter((call) => call.verb === 'renameModFolder' || call.verb === 'changeModOrder');

describe('rename mod', () => {
  const mods = [mod('Mod A'), mod('Mod B')];

  it('prompts with the right-clicked mod\'s name and renames it, not the selection around it', async () => {
    const { run, row, adapter, reporter } = renamesOver(mods);
    typing('Renamed');
    const [modA, modB] = [await row('Mod A'), await row('Mod B')];

    await run('modbench.mod.rename', modB, [modA, modB]);

    expect(seen.inputBoxes.at(-1)).toMatchObject({ prompt: 'Rename mod', value: 'Mod B' });
    expect(renamed(adapter.calls)[0]).toEqual({ verb: 'renameModFolder', from: 'Mod B', to: 'Renamed' });
    expect(reporter.reports).toEqual([]);
  });

  it('renames the mod Rename Symbol supplies to the name it supplies, asking nothing', async () => {
    const { run, row, view, adapter, reporter } = renamesOver(mods);
    view.selectRows([await row('Mod A')]);

    await run('modbench.mod.rename', undefined, undefined, { oldName: 'Mod B', newName: 'Renamed' });

    expect(seen.inputBoxes).toEqual([]);
    expect(renamed(adapter.calls)[0]).toEqual({ verb: 'renameModFolder', from: 'Mod B', to: 'Renamed' });
    expect(reporter.reports).toEqual([]);
  });

  it('renames the one selected mod from F2', async () => {
    const { run, row, view, adapter } = renamesOver(mods);
    typing('Renamed');
    view.selectRows([await row('Mod A')]);

    await run('modbench.mod.rename', MODS_KEY_ARGS);

    expect(renamed(adapter.calls)[0]).toEqual({ verb: 'renameModFolder', from: 'Mod A', to: 'Renamed' });
  });

  it('asks the command in the prompt whether the name is free of the other mods, the mod\'s own name being free', async () => {
    const { run, row } = renamesOver(mods);

    await run('modbench.mod.rename', await row('Mod B'));
    const validate = validatorOfThePrompt();

    expect([await validate('mod a'), await validate('mod b')]).toEqual(['A mod with this name already exists', undefined]);
  });

  it('applies its owners\' changes through Text documents, as one workspace edit', async () => {
    const { run, row, apply } = renamesOver(mods, { reading: { sourceModFolders: repositoriesOf({ 'Mod A': '/instance/source/Mod A' }) } });
    typing('Renamed');

    await run('modbench.mod.rename', await row('Mod A'));

    expect(apply).toHaveBeenCalledOnce();
    expect(apply).toHaveBeenCalledWith(expect.arrayContaining([{ moves: SOURCE_MOVES, deletions: [], documents: [] }]));
  });

  it('says its folder and lines were not renamed when its folder could not move', async () => {
    const { run, row, reporter } = renamesOver(mods, { answers: { refusals: refusing('renameModFolder', 'is in the way') } });
    typing('Renamed');

    await run('modbench.mod.rename', await row('Mod A'));

    expect(reporter.reports).toEqual([{ severity: 'error', message: 'Could not rename "Mod A": its folder and lines were not renamed.', detail: 'is in the way' }]);
  });

  it('lands with one warning naming each profile whose line could not be renamed', async () => {
    const lineRefusalIn: Record<string, string> = { Default: 'disk full', Secondary: 'locked' };
    const { run, row, reporter } = renamesOver(mods, {
      answers: { refusals: (call) => (call.verb === 'changeModOrder' ? lineRefusalIn[call.profile] : undefined) }, reading: { profiles: ['Default', 'Secondary'] },
    });
    typing('Renamed');

    await run('modbench.mod.rename', await row('Mod A'));

    expect(reporter.reports).toEqual([{
      severity: 'warning',
      message: 'Renamed "Mod A" to "Renamed". 2 references to it could not follow.',
      detail: 'profile "Default"\'s modlist.txt: disk full\nprofile "Secondary"\'s modlist.txt: locked',
    }]);
  });

  describe('for an agent', () => {
    const renameCall = (name: string) => new AgentCall([{ kind: 'mod', name: 'Mod A' }], { name });

    it('renames the mod given to the name given, never the selection, asking nothing, and answers the outcome', async () => {
      const { run, row, view, adapter, reporter } = renamesOver(mods);
      view.selectRows([await row('Mod B')]);

      const answered = await run('modbench.mod.rename', renameCall('Renamed'));

      expect(renamed(adapter.calls)[0]).toEqual({ verb: 'renameModFolder', from: 'Mod A', to: 'Renamed' });
      expect(answered).toEqual({ applied: true, outcome: { landed: ['Renamed'], refused: [] } });
      expect([seen.inputBoxes, reporter.reports]).toEqual([[], []]);
    });

    it('answers a rename to the mod\'s own name as nothing landed, writing and reporting nothing', async () => {
      const { run, adapter, reporter } = renamesOver(mods);

      expect(await run('modbench.mod.rename', renameCall('Mod A'))).toEqual({ applied: true, outcome: { landed: [], refused: [] } });
      expect([adapter.calls, reporter.reports]).toEqual([[], []]);
    });

    it('refuses an Argument of more than one mod', async () => {
      const { run, adapter } = renamesOver(mods);

      await expect(run('modbench.mod.rename', new AgentCall([{ kind: 'mod', name: 'Mod A' }, { kind: 'mod', name: 'Mod B' }], { name: 'X' }))).rejects.toBeInstanceOf(Refusal);
      expect(adapter.calls).toEqual([]);
    });
  });
});

describe('a rename prompt asks the command nothing of an empty name, so an unreadable mod order shows no error there', () => {
  it.each<[string, (view: ReturnType<typeof renamesOver>) => Promise<unknown>]>([
    ['modbench.mod.rename', async ({ row }) => await row('Mod A', await row('Group A'))],
    ['modbench.separator.rename', ({ row }) => row('Group A')],
  ])('%s', async (command, clicked) => {
    const view = renamesOver([mod('Mod A'), separator('Group A')], { answers: { unreadReads: { modOrder: 'modlist.txt is locked' } } });

    await view.run(command, await clicked(view));
    const validate = validatorOfThePrompt();

    expect([await validate(''), await validate('Named')]).toEqual([undefined, 'modlist.txt is locked']);
  });
});

describe('rename separator', () => {
  const entries = [separator('Group A'), mod('Mod A'), separator('Group B'), separator('Taken Meanwhile')];
  const renameLine = { verb: 'changeModOrder', profile: 'Default', changes: [{ kind: 'renameSeparator', from: 'Group B', to: 'Renamed' }] };

  it('renames the separator Rename Symbol supplies to the name it supplies, asking nothing', async () => {
    const { run, row, view, adapter } = renamesOver(entries);
    view.selectRows([await row('Group A')]);

    await run('modbench.separator.rename', undefined, undefined, { oldName: 'Group B', newName: 'Renamed' });

    expect(seen.inputBoxes).toEqual([]);
    expect(renamed(adapter.calls)).toEqual([renameLine]);
  });

  it('prompts with the right-clicked separator\'s name and renames it, not the selection around it', async () => {
    const { run, row, view, adapter } = renamesOver(entries);
    typing('Renamed');
    const [groupA, groupB] = [await row('Group A'), await row('Group B')];
    view.selectRows([groupA, groupB]);

    await run('modbench.separator.rename', groupB, [groupA, groupB]);

    expect(seen.inputBoxes.at(-1)).toMatchObject({ prompt: 'Rename separator', value: 'Group B' });
    expect(renamed(adapter.calls)).toEqual([renameLine]);
  });

  it('asks the command in the prompt whether the name is free of the other separators, the separator\'s own name being free', async () => {
    const { run, row } = renamesOver(entries);

    await run('modbench.separator.rename', await row('Group B'));
    const validate = validatorOfThePrompt();

    expect([await validate('group a'), await validate('group b')]).toEqual(['A separator with this name already exists', undefined]);
  });

  it('reports the refusal of a name another separator took after the prompt closed', async () => {
    const { run, row, reporter } = renamesOver(entries);
    typing('Taken Meanwhile');

    await run('modbench.separator.rename', await row('Group B'));

    expect(reporter.reports).toEqual([{ severity: 'error', message: 'A separator with this name already exists', detail: undefined }]);
  });

  it('ends on the Instance loader\'s read, with the view\'s progress bar open throughout', async () => {
    const { run, row } = renamesOver(entries, { answers: { refusals: (call) => { progressSteps.push(call.verb); return undefined; } } });
    typing('Renamed');

    await run('modbench.separator.rename', await row('Group B'));

    expect(progressSteps).toEqual([
      'progress opens on modbench.modList', 'changeModOrder', 'followFoldersInRepository', 'progress closes',
    ]);
  });

  it('renames the one selected separator from F2', async () => {
    const { run, row, view, adapter } = renamesOver(entries);
    typing('Renamed');
    view.selectRows([await row('Group B')]);

    await run('modbench.separator.rename', MODS_KEY_ARGS);

    expect(renamed(adapter.calls)).toEqual([renameLine]);
  });

  it('renames the separator given an agent, never the selection, and answers the outcome', async () => {
    const { run, row, view, adapter } = renamesOver(entries);
    view.selectRows([await row('Group A')]);

    const answered = await run('modbench.separator.rename', new AgentCall([{ kind: 'separator', name: 'Group B' }], { name: 'Renamed' }));

    expect(renamed(adapter.calls)).toEqual([renameLine]);
    expect(answered).toEqual({ applied: true, outcome: { landed: ['Renamed'], refused: [] } });
  });

  it.each([
    ['modbench.mod.rename', { kind: 'plugin', plugin: { name: 'A.esp', origin: 'Mod A' } }],
    ['modbench.separator.rename', { kind: 'mod', name: 'Mod A' }],
  ] as const)('%s refuses an agent\'s Argument of a kind it does not take, writing nothing', async (command, argument) => {
    const { run, adapter } = renamesOver(entries);

    await expect(run(command, new AgentCall([argument], { name: 'X' }))).rejects.toBeInstanceOf(Refusal);
    expect(adapter.calls).toEqual([]);
  });

  it('refuses an agent\'s Argument of more than one separator, writing nothing', async () => {
    const { run, adapter } = renamesOver(entries);

    await expect(run('modbench.separator.rename', new AgentCall([{ kind: 'separator', name: 'Group A' }, { kind: 'separator', name: 'Group B' }], { name: 'X' })))
      .rejects.toBeInstanceOf(Refusal);
    expect(adapter.calls).toEqual([]);
  });
});
