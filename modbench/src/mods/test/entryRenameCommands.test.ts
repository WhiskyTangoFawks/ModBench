import { describe, it, expect, vi, beforeEach } from 'vitest';
import type * as vscode from 'vscode';
import { TreeItem, TreeItemCollapsibleState, TreeItemCheckboxState, EventEmitter, ThemeIcon, ThemeColor, MarkdownString, Uri } from '../../test/vscodeMock';

const { registerCommand, showInputBox } = vi.hoisted(() => ({
  registerCommand: vi.fn((_id: string, handler: (...args: unknown[]) => unknown) => ({ dispose: vi.fn(), handler })),
  showInputBox: vi.fn<(options?: vscode.InputBoxOptions) => Promise<string | undefined>>(),
}));

vi.mock('vscode', async () => {
  const { recordedWithProgress } = await import('../../test/recordedProgress');
  return {
    commands: { registerCommand, executeCommand: vi.fn() },
    window: { showInputBox, withProgress: recordedWithProgress },
    workspace: { textDocuments: [] },
    TreeItem, TreeItemCollapsibleState, TreeItemCheckboxState, EventEmitter, ThemeIcon, ThemeColor, MarkdownString, Uri,
  };
});

import { instanceThatReads, progressSteps } from '../../test/recordedProgress';
import { registerEntryRenameCommands } from '../entryRenameCommands';
import { ModNode, SeparatorNode, type ModlistNode } from '../ModListProvider';
import { Refusal } from '../../drivingLib/refusal';
import { AgentCall } from '../../drivingLib/agentGesture';
import { MODS_KEY_ARGS } from '../gestureEntry';
import { recordingReporter } from '../../test/surfacingDoubles';
import { present } from '../../ports/present';
import { instanceValueFixture } from '../../test/mo2/instanceValueFixture';
import { modCommands } from '../../modCommands/modCommands';
import { entryRenameCommands } from '../../modCommands/renameEntry';
import { InMemoryMEditClient } from '../../client/test/InMemoryMEditClient';
import { oneAtATime } from '../../textDocuments/oneAtATime';
import type { SourceEditing } from '../../textDocuments/sourceEditing';
import type { InstanceReading, ModlistEntry } from '../../instanceAdapter/instanceAdapter';
import { fakeInstanceAdapter, modFoldersOf, readingFixture, refusing, repositoriesOf, type AdapterCall, type InstanceAnswers } from '../../test/fakeInstanceAdapter';
import { mod } from './indexedValue';

const separator = (name: string): ModlistEntry => ({ kind: 'separator', name, enabled: true });

function invoke(commandId: string, ...args: unknown[]): Promise<unknown> {
  const call = registerCommand.mock.calls.findLast((c) => c[0] === commandId);
  if (!call) throw new Error(`command not registered: ${commandId}`);
  return Promise.resolve(call[1](...args));
}

const promptOptions = (): vscode.InputBoxOptions => present(showInputBox.mock.calls.at(-1)?.[0], 'the options of the prompt the gesture opened');
const validatorOfThePrompt = (): ((value: string) => unknown) => {
  const options = promptOptions();
  return (value) => options.validateInput?.(value);
};

const SOURCE_MOVES = [{ from: '/instance/source/Mod A', to: '/source/Renamed' }];

function renamesOver(entries: readonly ModlistEntry[], { answers = {}, reading = {}, selection = [] }: { answers?: InstanceAnswers; reading?: Partial<InstanceReading>; selection?: readonly ModlistNode[] } = {}) {
  const fake = fakeInstanceAdapter(readingFixture({ mods: [...entries], modFolders: modFoldersOf(...entries), ...reading }), answers);
  const client = new InMemoryMEditClient();
  client.setCommandResult('getSourceFolderMoveChanges', { moves: SOURCE_MOVES, deletions: [], documents: [] });
  client.setCommandResult('followSourceFolderMove', { followed: true });
  const apply = vi.fn<SourceEditing['applyWorkspaceChanges']>().mockResolvedValue();
  const source: SourceEditing = { applyWorkspaceChanges: apply, oneAtATime: oneAtATime(), refreshSourceControlFor: vi.fn() };
  const reporter = recordingReporter();
  const instance = { ...instanceThatReads, value: instanceValueFixture({ mods: [...entries] }) };
  registerEntryRenameCommands({
    commands: modCommands(fake.adapter), renames: entryRenameCommands({ adapter: fake.adapter, client }), source, instance, reporter,
  }, () => selection);
  return { fake, client, apply, reporter };
}

const renamed = (calls: readonly AdapterCall[]) => calls.filter((call) => call.verb === 'renameModFolder' || call.verb === 'changeModOrder');

beforeEach(() => { vi.clearAllMocks(); progressSteps.length = 0; });

describe('rename mod', () => {
  const mods = [mod('Mod A'), mod('Mod B')];
  const modA = new ModNode({ kind: 'mod', name: 'Mod A', enabled: true });
  const modB = new ModNode({ kind: 'mod', name: 'Mod B', enabled: true });

  it('prompts with the right-clicked mod\'s name and renames it, not the selection around it', async () => {
    showInputBox.mockResolvedValueOnce('Renamed');
    const { fake, reporter } = renamesOver(mods);

    await invoke('modbench.mod.rename', modB, [modA, modB]);

    expect(promptOptions()).toMatchObject({ prompt: 'Rename mod', value: 'Mod B' });
    expect(renamed(fake.calls)[0]).toEqual({ verb: 'renameModFolder', from: 'Mod B', to: 'Renamed' });
    expect(reporter.reports).toEqual([]);
  });

  it('renames the one selected mod from F2', async () => {
    showInputBox.mockResolvedValueOnce('Renamed');
    const { fake } = renamesOver(mods, { selection: [modA] });

    await invoke('modbench.mod.rename', MODS_KEY_ARGS);

    expect(renamed(fake.calls)[0]).toEqual({ verb: 'renameModFolder', from: 'Mod A', to: 'Renamed' });
  });

  it('asks the command in the prompt whether the name is free of the other mods, the mod\'s own name being free', async () => {
    showInputBox.mockResolvedValueOnce(undefined);
    renamesOver(mods);

    await invoke('modbench.mod.rename', modB);
    const validate = validatorOfThePrompt();

    expect([await validate('mod a'), await validate('mod b')]).toEqual(['A mod with this name already exists', undefined]);
  });

  it('applies its owners\' changes through Text documents, as one workspace edit', async () => {
    showInputBox.mockResolvedValueOnce('Renamed');
    const { apply } = renamesOver(mods, { reading: { sourceModFolders: repositoriesOf({ 'Mod A': '/instance/source/Mod A' }) } });

    await invoke('modbench.mod.rename', modA);

    expect(apply).toHaveBeenCalledOnce();
    expect(apply).toHaveBeenCalledWith(expect.arrayContaining([{ moves: SOURCE_MOVES, deletions: [], documents: [] }]));
  });

  it('says its folder and lines were not renamed when its folder could not move', async () => {
    showInputBox.mockResolvedValueOnce('Renamed');
    const { reporter } = renamesOver(mods, { answers: { refusals: refusing('renameModFolder', 'is in the way') } });

    await invoke('modbench.mod.rename', modA);

    expect(reporter.reports).toEqual([{ severity: 'error', message: 'Could not rename "Mod A": its folder and lines were not renamed.', detail: 'is in the way' }]);
  });

  it('lands with one warning naming each profile whose line could not be renamed', async () => {
    showInputBox.mockResolvedValueOnce('Renamed');
    const lineRefusalIn: Record<string, string> = { Default: 'disk full', Secondary: 'locked' };
    const { reporter } = renamesOver(mods, {
      answers: { refusals: (call) => (call.verb === 'changeModOrder' ? lineRefusalIn[call.profile] : undefined) }, reading: { profiles: ['Default', 'Secondary'] },
    });

    await invoke('modbench.mod.rename', modA);

    expect(reporter.reports).toEqual([{
      severity: 'warning',
      message: 'Renamed "Mod A" to "Renamed". 2 references to it could not follow.',
      detail: 'profile "Default"\'s modlist.txt: disk full\nprofile "Secondary"\'s modlist.txt: locked',
    }]);
  });

  describe('for an agent', () => {
    const renameCall = (name: string) => new AgentCall([{ kind: 'mod', name: 'Mod A' }], { name });

    it('renames the mod given to the name given, never the selection, asking nothing, and answers the outcome', async () => {
      const { fake, reporter } = renamesOver(mods, { selection: [modB] });

      const answered = await invoke('modbench.mod.rename', renameCall('Renamed'));

      expect(renamed(fake.calls)[0]).toEqual({ verb: 'renameModFolder', from: 'Mod A', to: 'Renamed' });
      expect(answered).toEqual({ applied: true, outcome: { landed: ['Renamed'], refused: [] } });
      expect([showInputBox.mock.calls, reporter.reports]).toEqual([[], []]);
    });

    it('answers a rename to the mod\'s own name as nothing landed, writing and reporting nothing', async () => {
      const { fake, reporter } = renamesOver(mods);

      expect(await invoke('modbench.mod.rename', renameCall('Mod A'))).toEqual({ applied: true, outcome: { landed: [], refused: [] } });
      expect([fake.calls, reporter.reports]).toEqual([[], []]);
    });

    it('refuses an Argument of more than one mod', async () => {
      const { fake } = renamesOver(mods);

      await expect(invoke('modbench.mod.rename', new AgentCall([{ kind: 'mod', name: 'Mod A' }, { kind: 'mod', name: 'Mod B' }], { name: 'X' }))).rejects.toBeInstanceOf(Refusal);
      expect(fake.calls).toEqual([]);
    });
  });
});

describe('a rename prompt asks the command nothing of an empty name, so an unreadable mod order shows no error there', () => {
  it.each([
    ['modbench.mod.rename', new ModNode({ kind: 'mod', name: 'Mod A', enabled: true })],
    ['modbench.separator.rename', new SeparatorNode({ kind: 'separator', name: 'Group A', enabled: true }, [])],
  ])('%s', async (command, row) => {
    showInputBox.mockResolvedValueOnce(undefined);
    renamesOver([mod('Mod A'), separator('Group A')], { answers: { unreadReads: { modOrder: 'modlist.txt is locked' } } });

    await invoke(command, row);
    const validate = validatorOfThePrompt();

    expect([await validate(''), await validate('Named')]).toEqual([undefined, 'modlist.txt is locked']);
  });
});

describe('rename separator', () => {
  const entries = [separator('Group A'), mod('Mod A'), separator('Group B'), separator('Taken Meanwhile')];
  const groupA = new SeparatorNode({ kind: 'separator', name: 'Group A', enabled: true }, []);
  const groupB = new SeparatorNode({ kind: 'separator', name: 'Group B', enabled: true }, []);
  const renameLine = { verb: 'changeModOrder', profile: 'Default', changes: [{ kind: 'renameSeparator', from: 'Group B', to: 'Renamed' }] };

  it('prompts with the right-clicked separator\'s name and renames it, not the selection around it', async () => {
    showInputBox.mockResolvedValueOnce('Renamed');
    const { fake } = renamesOver(entries, { selection: [groupA, groupB] });

    await invoke('modbench.separator.rename', groupB, [groupA, groupB]);

    expect(promptOptions()).toMatchObject({ prompt: 'Rename separator', value: 'Group B' });
    expect(renamed(fake.calls)).toEqual([renameLine]);
  });

  it('asks the command in the prompt whether the name is free of the other separators, the separator\'s own name being free', async () => {
    showInputBox.mockResolvedValueOnce(undefined);
    renamesOver(entries);

    await invoke('modbench.separator.rename', groupB);
    const validate = validatorOfThePrompt();

    expect([await validate('group a'), await validate('group b')]).toEqual(['A separator with this name already exists', undefined]);
  });

  it('reports the refusal of a name another separator took after the prompt closed', async () => {
    showInputBox.mockResolvedValueOnce('Taken Meanwhile');
    const { reporter } = renamesOver(entries);

    await invoke('modbench.separator.rename', groupB);

    expect(reporter.reports).toEqual([{ severity: 'error', message: 'A separator with this name already exists', detail: undefined }]);
  });

  it('ends on the Instance loader\'s read, with the view\'s progress bar open throughout', async () => {
    showInputBox.mockResolvedValueOnce('Renamed');
    renamesOver(entries, { answers: { refusals: (call) => { progressSteps.push(call.verb); return undefined; } } });

    await invoke('modbench.separator.rename', groupB);

    expect(progressSteps).toEqual([
      'progress opens on modbench.modList', 'changeModOrder', 'followFoldersInRepository', 'Instance loader: read every file again', 'progress closes',
    ]);
  });

  it('renames the one selected separator from F2', async () => {
    showInputBox.mockResolvedValueOnce('Renamed');
    const { fake } = renamesOver(entries, { selection: [groupB] });

    await invoke('modbench.separator.rename', MODS_KEY_ARGS);

    expect(renamed(fake.calls)).toEqual([renameLine]);
  });

  it('renames the separator given an agent, never the selection, and answers the outcome', async () => {
    const { fake } = renamesOver(entries, { selection: [groupA] });

    const answered = await invoke('modbench.separator.rename', new AgentCall([{ kind: 'separator', name: 'Group B' }], { name: 'Renamed' }));

    expect(renamed(fake.calls)).toEqual([renameLine]);
    expect(answered).toEqual({ applied: true, outcome: { landed: ['Renamed'], refused: [] } });
  });

  it.each([
    ['modbench.mod.rename', { kind: 'plugin', plugin: { name: 'A.esp', origin: 'Mod A' } }],
    ['modbench.separator.rename', { kind: 'mod', name: 'Mod A' }],
  ] as const)('%s refuses an agent\'s Argument of a kind it does not take, writing nothing', async (command, argument) => {
    const { fake } = renamesOver(entries);

    await expect(invoke(command, new AgentCall([argument], { name: 'X' }))).rejects.toBeInstanceOf(Refusal);
    expect(fake.calls).toEqual([]);
  });

  it('refuses an agent\'s Argument of more than one separator, writing nothing', async () => {
    const { fake } = renamesOver(entries);

    await expect(invoke('modbench.separator.rename', new AgentCall([{ kind: 'separator', name: 'Group A' }, { kind: 'separator', name: 'Group B' }], { name: 'X' })))
      .rejects.toBeInstanceOf(Refusal);
    expect(fake.calls).toEqual([]);
  });
});
