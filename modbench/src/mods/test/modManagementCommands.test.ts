import { describe, it, expect, vi, beforeEach } from 'vitest';
import type * as vscode from 'vscode';
import { TreeItem, TreeItemCollapsibleState, TreeItemCheckboxState, EventEmitter, ThemeIcon, ThemeColor, MarkdownString, Uri } from '../../test/vscodeMock';

const { registerCommand, executeCommand, showOpenDialog, showInputBox, createQuickPick, openExternal } = vi.hoisted(() => ({
  registerCommand: vi.fn((_id: string, handler: (...args: unknown[]) => unknown) => ({ dispose: vi.fn(), handler })),
  executeCommand: vi.fn((_command: string, _uri?: { fsPath: string }) => Promise.resolve()),
  showOpenDialog: vi.fn(),
  showInputBox: vi.fn<(options?: vscode.InputBoxOptions) => Promise<string | undefined>>(),
  createQuickPick: vi.fn(),
  openExternal: vi.fn(),
}));

vi.mock('vscode', async () => {
  const { recordedWithProgress } = await import('../../test/recordedProgress');
  return {
    commands: { registerCommand, executeCommand },
    window: { showOpenDialog, showInputBox, createQuickPick, withProgress: recordedWithProgress },
    env: { openExternal },
    TreeItem, TreeItemCollapsibleState, TreeItemCheckboxState, EventEmitter, ThemeIcon, ThemeColor, MarkdownString,
    Uri: { ...Uri, parse: (s: string) => ({ toString: () => s }) },
  };
});

import { instanceThatReads, progressSteps } from '../../test/recordedProgress';
import { quickPickChoosing } from '../../drivingLib/test/quickPickDouble';
import {
  registerCreateEmptyModCommand, registerModContextCommands, registerModEnableCommands, registerFileExclusionCommands,
  registerModMoveCommand,
  registerOpenFolderCommand, registerOpenSourceCommand, registerSeparatorCommands, registerViewOnNexusCommand,
  modsCopyValueText,
} from '../modManagementCommands';
import { ModNode, OverwriteNode, SeparatorNode, type ModlistNode } from '../ModListProvider';
import type { NexusModRow } from '../../drivingLib/inFocusedView';
import { Refusal } from '../../drivingLib/refusal';
import { AgentCall } from '../../drivingLib/agentGesture';
import { MODS_KEY_ARGS } from '../gestureEntry';
import { FileNode, FolderNode } from '../modFiles';
import { recordingReporter, scriptedDialog } from '../../test/surfacingDoubles';
import { present } from '../../ports/present';
import { instanceValueFixture } from '../../test/mo2/instanceValueFixture';
import { modCommands, type ModCommands } from '../../modCommands/modCommands';
import type { InstanceReading, ModlistEntry, ModOrderChange, OriginFile } from '../../instanceAdapter/instanceAdapter';
import { fakeInstanceAdapter, modFoldersOf, readingFixture, refusing, type AdapterCall, type InstanceAnswers } from '../../test/fakeInstanceAdapter';
import { unreadStatus } from '../../test/unreadStatus';
import type { Argument } from '../../wire/argument';
import { file, folder, mod } from './indexedValue';

function invoke(commandId: string, ...args: unknown[]): Promise<unknown> {
  const call = registerCommand.mock.calls.findLast((c) => c[0] === commandId);
  if (!call) throw new Error(`command not registered: ${commandId}`);
  return Promise.resolve(call[1](...args));
}

const separator = (name: string): ModlistEntry => ({ kind: 'separator', name, enabled: true });

const unscriptedMEdit = { changeSourceManifest: () => Promise.reject(new Error('unscripted')) };

function commandsOver(mods: readonly ModlistEntry[], answers: InstanceAnswers = {}, reading: Partial<InstanceReading> = {}) {
  const fake = fakeInstanceAdapter(readingFixture({ mods: [...mods], modFolders: modFoldersOf(...mods), ...reading }), answers);
  return { fake, commands: modCommands(fake.adapter, unscriptedMEdit, unreadStatus) };
}

const instanceOf = (mods: readonly ModlistEntry[] = []) => ({ ...instanceThatReads, value: instanceValueFixture({ mods: [...mods] }) });

const modOrderChange = (...changes: ModOrderChange[]): AdapterCall => ({ verb: 'changeModOrder', profile: 'Default', changes });
const trashed = (kind: 'mod' | 'separator', name: string): AdapterCall => ({ verb: 'trashEntryFolder', entry: { kind, name } });

function optionsOfTheLastShowInputBoxCall(): vscode.InputBoxOptions {
  return present(showInputBox.mock.calls.at(-1)?.[0], 'the options of the prompt the gesture opened');
}

const validatorOfThePrompt = (): ((value: string) => unknown) => {
  const options = optionsOfTheLastShowInputBoxCall();
  return (value) => options.validateInput?.(value);
};

const MOD_CLASH = 'A mod with this name already exists';
const SEPARATOR_CLASH = 'A separator with this name already exists';

describe('create empty mod', () => {
  beforeEach(() => { vi.clearAllMocks(); progressSteps.length = 0; });

  const mods = [mod('Existing Mod')];
  const instance = instanceOf(mods);

  it('Esc creates nothing', async () => {
    showInputBox.mockResolvedValueOnce(undefined);
    const { fake, commands } = commandsOver(mods);
    const reporter = recordingReporter();

    registerCreateEmptyModCommand(commands, instance, reporter);
    await invoke('modbench.mod.createEmpty');

    expect([fake.calls, reporter.reports]).toEqual([[], []]);
  });

  it('the prompt refuses a name a folder holds, in install\'s own words', async () => {
    registerCreateEmptyModCommand(commandsOver(mods).commands, instance, recordingReporter());
    await invoke('modbench.mod.createEmpty');
    const validate = validatorOfThePrompt();

    expect([await validate('existing mod'), await validate('Free Name')]).toEqual([
      'A mod named "existing mod" already exists. Install its next release from Downloads, or uninstall it to install anew.', undefined,
    ]);
  });

  it('creates the folder and its line, and reports nothing when both land', async () => {
    showInputBox.mockResolvedValueOnce('New Mod');
    const { fake, commands } = commandsOver(mods);
    const reporter = recordingReporter();

    registerCreateEmptyModCommand(commands, instance, reporter);
    await invoke('modbench.mod.createEmpty');

    expect(fake.calls).toEqual([
      { verb: 'createModFolder', mod: 'New Mod' }, modOrderChange({ kind: 'addAtWinningEnd', entry: { kind: 'mod', name: 'New Mod' } }),
    ]);
    expect(reporter.reports).toEqual([]);
  });

  it('reports a landed-but-partial line failure as a warning, not a failed create', async () => {
    showInputBox.mockResolvedValueOnce('New Mod');
    const reporter = recordingReporter();

    registerCreateEmptyModCommand(commandsOver(mods, { refusals: refusing('changeModOrder', 'disk full') }).commands, instance, reporter);
    await invoke('modbench.mod.createEmpty');

    expect(reporter.reports).toEqual([{
      severity: 'warning',
      message: '"New Mod" was created, but its modlist.txt line could not be written.',
      detail: 'disk full',
    }]);
  });

  it('names the file mod order is kept in as the value names it, not MO2\'s modlist.txt over another manager\'s', async () => {
    showInputBox.mockResolvedValueOnce('New Mod');
    const reporter = recordingReporter();
    const { commands } = commandsOver(mods, { refusals: refusing('changeModOrder', 'disk full') });
    const another: ModCommands = { ...commands, names: { manager: 'Another Manager', modOrderFile: 'order.txt', downloadedFileMetadataFile: 'order.metadata' } };

    registerCreateEmptyModCommand(another, instance, reporter);
    await invoke('modbench.mod.createEmpty');

    expect(reporter.reports.map((r) => r.message)).toEqual(['"New Mod" was created, but its order.txt line could not be written.']);
  });

  it('reports a folder another tool put in the way after the prompt closed as a failed create', async () => {
    showInputBox.mockResolvedValueOnce('New Mod');
    const reporter = recordingReporter();

    registerCreateEmptyModCommand(commandsOver([...mods, mod('New Mod')]).commands, instance, reporter);
    await invoke('modbench.mod.createEmpty');

    expect(reporter.reports).toEqual([{ severity: 'error', message: 'Failed to create "New Mod".', detail: 'The folder "/mods/New Mod" is in the way' }]);
  });
});

describe('rename mod', () => {
  beforeEach(() => { vi.clearAllMocks(); progressSteps.length = 0; });

  const mods = [mod('Mod A'), mod('Mod B')];
  const instance = instanceOf(mods);
  const twoProfiles = { profiles: ['Default', 'Secondary'] };
  const modA = new ModNode({ kind: 'mod', name: 'Mod A', enabled: true });
  const modB = new ModNode({ kind: 'mod', name: 'Mod B', enabled: true });
  const register = (commands: ModCommands, reporter = recordingReporter(), selection: readonly ModlistNode[] = []) =>
    registerModContextCommands({ commands, instance, viewSelection: () => selection, reporter, ask: scriptedDialog(), trash: vi.fn(), log: vi.fn() });
  const renames = (calls: readonly AdapterCall[]) => calls.filter((call) => call.verb === 'renameModFolder' || call.verb === 'changeModOrder');

  it('prompts with the right-clicked mod\'s name and renames it in every profile', async () => {
    showInputBox.mockResolvedValueOnce('Renamed');
    const { fake, commands } = commandsOver(mods, {}, twoProfiles);
    const reporter = recordingReporter();

    register(commands, reporter);
    await invoke('modbench.mod.rename', modB, [modA, modB]);

    expect(optionsOfTheLastShowInputBoxCall()).toMatchObject({ prompt: 'Rename mod', value: 'Mod B' });
    expect(renames(fake.calls)).toEqual([
      { verb: 'renameModFolder', from: 'Mod B', to: 'Renamed' },
      modOrderChange({ kind: 'renameMod', from: 'Mod B', to: 'Renamed' }),
      { ...modOrderChange({ kind: 'renameMod', from: 'Mod B', to: 'Renamed' }), profile: 'Secondary' },
    ]);
    expect(reporter.reports).toEqual([]);
  });

  it('renames the one selected mod from F2', async () => {
    showInputBox.mockResolvedValueOnce('Renamed');
    const { fake, commands } = commandsOver(mods);

    register(commands, recordingReporter(), [modA]);
    await invoke('modbench.mod.rename', MODS_KEY_ARGS);

    expect(renames(fake.calls)[0]).toEqual({ verb: 'renameModFolder', from: 'Mod A', to: 'Renamed' });
  });

  it('asks the command in the prompt whether the name is free of the other mods, the mod\'s own name being free', async () => {
    showInputBox.mockResolvedValueOnce(undefined);

    register(commandsOver(mods).commands);
    await invoke('modbench.mod.rename', modB);
    const validate = validatorOfThePrompt();

    expect([await validate('mod a'), await validate('mod b')]).toEqual([MOD_CLASH, undefined]);
  });

  it('reports a refusal, the folder not having moved, as a failed rename', async () => {
    showInputBox.mockResolvedValueOnce('Renamed');
    const reporter = recordingReporter();

    register(commandsOver(mods, { refusals: refusing('renameModFolder', 'is in the way') }).commands, reporter);
    await invoke('modbench.mod.rename', modA);

    expect(reporter.reports).toEqual([{ severity: 'error', message: 'Failed to rename mod.', detail: 'is in the way' }]);
  });

  it('warns once for each profile whose line could not be renamed, naming it and the mod order file', async () => {
    showInputBox.mockResolvedValueOnce('Renamed');
    const lineRefusalIn: Record<string, string> = { Default: 'disk full', Secondary: 'locked' };
    const reporter = recordingReporter();

    register(commandsOver(mods, { refusals: (call) => (call.verb === 'changeModOrder' ? lineRefusalIn[call.profile] : undefined) }, twoProfiles).commands, reporter);
    await invoke('modbench.mod.rename', modA);

    expect(reporter.reports).toEqual([
      { severity: 'warning', message: '"Mod A" was renamed, but its modlist.txt line in profile "Default" could not be renamed.', detail: 'disk full' },
      { severity: 'warning', message: '"Mod A" was renamed, but its modlist.txt line in profile "Secondary" could not be renamed.', detail: 'locked' },
    ]);
  });
});

describe('uninstall over the selection', () => {
  beforeEach(() => { vi.clearAllMocks(); progressSteps.length = 0; });

  const mods = [mod('Mod A'), mod('Mod B')];
  const instance = instanceOf(mods);
  const trash = vi.fn(() => Promise.resolve());
  const modA = new ModNode({ kind: 'mod', name: 'Mod A', enabled: true, installationFileName: 'mod-a.7z' });
  const modB = new ModNode({ kind: 'mod', name: 'Mod B', enabled: true });
  const sourceA = new ModNode(modA.mod, { holdsPlugin: true, sourceMod: true });
  const register = (commands: ModCommands, { reporter = recordingReporter(), ask = scriptedDialog('Uninstall'), log = (_line: string) => undefined } = {}) =>
    registerModContextCommands({ commands, instance, viewSelection: () => [], reporter, ask, trash, log });

  it.each<[string, ModNode, ModNode[] | undefined, string]>([
    ['naming the mod', modA, undefined, 'Uninstall "Mod A"? Its folder will be moved to the system trash.'],
    ['saying the source goes with the folder of a source mod', sourceA, undefined, 'Uninstall "Mod A"? Its folder and its source will be moved to the system trash.'],
    ['listing every mod of a selection of several', modA, [modA, modB], 'Uninstall "Mod A", "Mod B"? Their folders will be moved to the system trash.'],
    ['naming the source mods whose source goes with the folders, for a selection of several', sourceA, [sourceA, modB],
      'Uninstall "Mod A", "Mod B"? Their folders will be moved to the system trash, and the source of "Mod A" with them.'],
  ])('asks one modal %s', async (_case, clicked, selected, message) => {
    const ask = scriptedDialog(undefined);

    register(commandsOver(mods).commands, { ask });
    await invoke('modbench.mod.uninstall', clicked, selected);

    expect(ask.asked).toEqual([{ message, detail: undefined, buttons: ['Uninstall'] }]);
  });

  it('uninstalls the selection once confirmed: each folder into the trash it was given, then each line', async () => {
    const { fake, commands } = commandsOver(mods);

    register(commands);
    await invoke('modbench.mod.uninstall', modA, [modA, modB]);

    expect(trash.mock.calls).toEqual([['/mods/Mod A'], ['/mods/Mod B']]);
    expect(fake.calls).toEqual([
      trashed('mod', 'Mod A'), { verb: 'trashSourceFolder', mod: 'Mod A' }, trashed('mod', 'Mod B'), { verb: 'trashSourceFolder', mod: 'Mod B' },
      modOrderChange({ kind: 'dropMod', mod: 'Mod A' }, { kind: 'dropMod', mod: 'Mod B' }),
    ]);
  });

  it('uninstalls nothing when the modal is dismissed', async () => {
    const { fake, commands } = commandsOver(mods);

    register(commands, { ask: scriptedDialog(undefined) });
    await invoke('modbench.mod.uninstall', modA);

    expect(fake.calls).toEqual([]);
  });

  it.each<[string, InstanceAnswers, string, string]>([
    ['source folder could not be trashed', { refusals: refusing('trashSourceFolder', 'the trash refused it') },
      '"Mod A" was uninstalled, but its source folder could not be moved to the trash.', 'the trash refused it'],
    ['publisher tags could not be removed', { publisherTags: [], refusals: refusing('followModFolders', 'not JSON') },
      '"Mod A" was uninstalled, but its publisher tags could not be removed.', 'not JSON'],
    ['line could not be removed after its folder was trashed', { refusals: refusing('changeModOrder', 'disk full') },
      '"Mod A" was uninstalled, but its modlist.txt line could not be removed.', 'disk full'],
  ])('warns, and reports no failed uninstall, of a mod uninstalled whose %s', async (_case, answers, message, detail) => {
    const reporter = recordingReporter();

    register(commandsOver(mods, answers).commands, { reporter });
    await invoke('modbench.mod.uninstall', modA);

    expect(reporter.reports).toEqual([{ severity: 'warning', message, detail }]);
  });

  it('says nothing extra for a fully landed uninstall with no failed mark', async () => {
    const reporter = recordingReporter();
    const logged: string[] = [];

    register(commandsOver(mods).commands, { reporter, log: (line) => { logged.push(line); } });
    await invoke('modbench.mod.uninstall', modA);

    expect([reporter.reports, logged]).toEqual([[], []]);
  });

  it('a failed mark is one Output line and no notification; the uninstall it rides on stands landed', async () => {
    const reporter = recordingReporter();
    const logged: string[] = [];
    const installedFromItsFile = { metadata: new Map([['Mod A', { installationFile: { name: 'mod-a.7z' } }]]), refusals: refusing('markDownloadedFile', 'disk full') };

    register(commandsOver(mods, installedFromItsFile).commands, { reporter, log: (line) => { logged.push(line); } });
    await invoke('modbench.mod.uninstall', modA);

    expect(reporter.reports).toEqual([]);
    expect(logged).toEqual(['"Mod A" was uninstalled, but its downloaded file could not be marked uninstalled: disk full']);
  });
});

describe('delete separator: the whole selection of separators, asked once', () => {
  beforeEach(() => { vi.clearAllMocks(); progressSteps.length = 0; });

  const mods = [separator('Group A'), mod('Mod A'), separator('Group B')];
  const instance = instanceOf(mods);
  const trash = vi.fn(() => Promise.resolve());
  const groupA = new SeparatorNode({ kind: 'separator', name: 'Group A', enabled: true }, []);
  const groupB = new SeparatorNode({ kind: 'separator', name: 'Group B', enabled: true }, []);
  const modA = new ModNode({ kind: 'mod', name: 'Mod A', enabled: true });

  it('deletes every selected separator in one write, its folder first into the trash it was given, and says nothing when all land', async () => {
    const { fake, commands } = commandsOver(mods);
    const reporter = recordingReporter();

    registerSeparatorCommands(commands, instance, reporter, scriptedDialog('Delete'), trash, () => []);
    await invoke('modbench.separator.delete', groupB, [groupA, groupB]);

    expect(trash.mock.calls).toEqual([['/mods/Group A'], ['/mods/Group B']]);
    expect(fake.calls).toEqual([
      trashed('separator', 'Group A'), trashed('separator', 'Group B'),
      modOrderChange({ kind: 'dropSeparator', separator: 'Group A' }, { kind: 'dropSeparator', separator: 'Group B' }),
    ]);
    expect(reporter.reports).toEqual([]);
  });

  it.each<[string, SeparatorNode[] | undefined, string]>([
    ['naming the separator and saying its mods stay', undefined, 'Delete separator "Group A"? Its mods stay.'],
    ['listing every separator of a selection of several', [groupA, groupB], 'Delete separators "Group A", "Group B"? Their mods stay.'],
  ])('asks one modal %s', async (_case, selected, message) => {
    const ask = scriptedDialog(undefined);

    registerSeparatorCommands(commandsOver(mods).commands, instance, recordingReporter(), ask, trash, () => []);
    await invoke('modbench.separator.delete', groupA, selected);

    expect(ask.asked).toEqual([{ message, detail: undefined, buttons: ['Delete'] }]);
  });

  it('a cancelled question writes nothing', async () => {
    const { fake, commands } = commandsOver(mods);

    registerSeparatorCommands(commands, instance, recordingReporter(), scriptedDialog(undefined), trash, () => []);
    await invoke('modbench.separator.delete', groupA, [groupA, groupB]);

    expect(fake.calls).toEqual([]);
  });

  it('takes only the separators of a selection mixing mods and separators', async () => {
    const { fake, commands } = commandsOver(mods);

    registerSeparatorCommands(commands, instance, recordingReporter(), scriptedDialog('Delete'), trash, () => []);
    await invoke('modbench.separator.delete', groupA, [modA, groupA]);

    expect(fake.calls).toEqual([trashed('separator', 'Group A'), modOrderChange({ kind: 'dropSeparator', separator: 'Group A' })]);
  });

  it('writes nothing and reports nothing for a selection with no separator', async () => {
    const { fake, commands } = commandsOver(mods);
    const reporter = recordingReporter();

    registerSeparatorCommands(commands, instance, reporter, scriptedDialog('Delete'), trash, () => [modA]);
    await invoke('modbench.separator.delete');

    expect([fake.calls, reporter.reports]).toEqual([[], []]);
  });

  it('a post-trash line failure is a warning notification naming the part that failed, not a failed delete', async () => {
    const reporter = recordingReporter();

    registerSeparatorCommands(commandsOver(mods, { refusals: refusing('changeModOrder', 'disk full') }).commands, instance, reporter, scriptedDialog('Delete'), trash, () => []);
    await invoke('modbench.separator.delete', groupA);

    expect(reporter.reports).toEqual([{
      severity: 'warning',
      message: '"Group A" was deleted, but its modlist.txt line could not be removed.',
      detail: 'disk full',
    }]);
  });
});

describe('rename separator takes its separator through the gesture entry', () => {
  beforeEach(() => { vi.clearAllMocks(); progressSteps.length = 0; });

  const mods = [separator('Group A'), mod('Mod A'), separator('Group B'), separator('Taken Meanwhile')];
  const instance = instanceOf(mods);
  const groupA = new SeparatorNode({ kind: 'separator', name: 'Group A', enabled: true }, []);
  const groupB = new SeparatorNode({ kind: 'separator', name: 'Group B', enabled: true }, []);

  it('prompts with the right-clicked separator\'s name and renames it, not the selection around it', async () => {
    showInputBox.mockResolvedValueOnce('Renamed');
    const { fake, commands } = commandsOver(mods);

    registerSeparatorCommands(commands, instance, recordingReporter(), scriptedDialog(), vi.fn(), () => [groupA, groupB]);
    await invoke('modbench.separator.rename', groupB, [groupA, groupB]);

    expect(optionsOfTheLastShowInputBoxCall()).toMatchObject({ prompt: 'Rename separator', value: 'Group B' });
    expect(fake.calls).toEqual([modOrderChange({ kind: 'renameSeparator', from: 'Group B', to: 'Renamed' })]);
  });

  it('asks the command in the prompt whether the name is free of the other separators, the separator\'s own name being free', async () => {
    showInputBox.mockResolvedValueOnce(undefined);

    registerSeparatorCommands(commandsOver(mods).commands, instance, recordingReporter(), scriptedDialog(), vi.fn(), () => []);
    await invoke('modbench.separator.rename', groupB);
    const validate = validatorOfThePrompt();

    expect([await validate('group a'), await validate('group b')]).toEqual([SEPARATOR_CLASH, undefined]);
  });

  it('reports the refusal of a name another separator took after the prompt closed', async () => {
    showInputBox.mockResolvedValueOnce('Taken Meanwhile');
    const reporter = recordingReporter();

    registerSeparatorCommands(commandsOver(mods).commands, instance, reporter, scriptedDialog(), vi.fn(), () => []);
    await invoke('modbench.separator.rename', groupB);

    expect(reporter.reports).toEqual([{ severity: 'error', message: 'Failed to rename separator.', detail: SEPARATOR_CLASH }]);
  });

  it('renames the one selected separator from F2', async () => {
    showInputBox.mockResolvedValueOnce('Renamed');
    const { fake, commands } = commandsOver(mods);

    registerSeparatorCommands(commands, instance, recordingReporter(), scriptedDialog(), vi.fn(), () => [groupB]);
    await invoke('modbench.separator.rename', MODS_KEY_ARGS);

    expect(optionsOfTheLastShowInputBoxCall()).toMatchObject({ value: 'Group B' });
    expect(fake.calls).toEqual([modOrderChange({ kind: 'renameSeparator', from: 'Group B', to: 'Renamed' })]);
  });
});

describe('add separator: one command for a mod anchor and a separator anchor', () => {
  beforeEach(() => { vi.clearAllMocks(); progressSteps.length = 0; });

  const mods = [mod('Mod A'), separator('Group A'), mod('Other Mod'), separator('Other Group'), separator('Taken Meanwhile')];
  const instance = instanceOf(mods);
  const modA = new ModNode({ kind: 'mod', name: 'Mod A', enabled: true });
  const groupA = new SeparatorNode({ kind: 'separator', name: 'Group A', enabled: true }, []);
  const otherMod = new ModNode({ kind: 'mod', name: 'Other Mod', enabled: true });
  const otherGroup = new SeparatorNode({ kind: 'separator', name: 'Other Group', enabled: true }, []);

  it.each<[string, ModlistNode, ModlistNode, { kind: 'mod' | 'separator'; name: string }]>([
    ['mod', modA, otherMod, { kind: 'mod', name: 'Mod A' }],
    ['separator', groupA, otherGroup, { kind: 'separator', name: 'Group A' }],
  ])('prompts and anchors the new separator on the right-clicked %s, not the selection around it', async (_case, clicked, other, anchor) => {
    showInputBox.mockResolvedValueOnce('New Section');
    const { fake, commands } = commandsOver(mods);

    registerSeparatorCommands(commands, instance, recordingReporter(), scriptedDialog(), vi.fn(), () => [other, clicked]);
    await invoke('modbench.separator.add', clicked, [other, clicked]);

    expect(optionsOfTheLastShowInputBoxCall()).toMatchObject({ prompt: 'Separator name', placeHolder: 'My Group' });
    expect(fake.calls).toEqual([modOrderChange({ kind: 'addSeparator', separator: 'New Section', anchor })]);
  });

  it('asks the command in the prompt whether the name is free of the other separators', async () => {
    showInputBox.mockResolvedValueOnce(undefined);

    registerSeparatorCommands(commandsOver(mods).commands, instance, recordingReporter(), scriptedDialog(), vi.fn(), () => []);
    await invoke('modbench.separator.add', modA);
    const validate = validatorOfThePrompt();

    expect([await validate('group a'), await validate('Free Name')]).toEqual([SEPARATOR_CLASH, undefined]);
  });

  it('reports the refusal of a name another separator took after the prompt closed', async () => {
    showInputBox.mockResolvedValueOnce('Taken Meanwhile');
    const reporter = recordingReporter();

    registerSeparatorCommands(commandsOver(mods).commands, instance, reporter, scriptedDialog(), vi.fn(), () => []);
    await invoke('modbench.separator.add', modA);

    expect(reporter.reports).toEqual([{ severity: 'error', message: 'Failed to add separator.', detail: SEPARATOR_CLASH }]);
  });

  it.each([['the prompt is cancelled (Esc)', undefined], ['the name is empty', '']])('adds nothing when %s', async (_case, answer) => {
    showInputBox.mockResolvedValueOnce(answer);
    const { fake, commands } = commandsOver(mods);

    registerSeparatorCommands(commands, instance, recordingReporter(), scriptedDialog(), vi.fn(), () => [modA]);
    await invoke('modbench.separator.add', modA);

    expect(fake.calls).toEqual([]);
  });
});

describe('a name prompt asks the command nothing of an empty name, so an unreadable mod order shows no error there', () => {
  beforeEach(() => { vi.clearAllMocks(); progressSteps.length = 0; });

  const mods = [mod('Mod A'), separator('Group A')];
  const instance = instanceOf(mods);
  const unreadable = { unreadReads: { modOrder: 'modlist.txt is locked' } };

  it.each<[string, (commands: ModCommands) => Promise<unknown>]>([
    ['rename mod', (commands) => {
      registerModContextCommands({ commands, instance, viewSelection: () => [], reporter: recordingReporter(), ask: scriptedDialog(), trash: vi.fn(), log: vi.fn() });
      return invoke('modbench.mod.rename', new ModNode({ kind: 'mod', name: 'Mod A', enabled: true }));
    }],
    ['rename separator', (commands) => {
      registerSeparatorCommands(commands, instance, recordingReporter(), scriptedDialog(), vi.fn(), () => []);
      return invoke('modbench.separator.rename', new SeparatorNode({ kind: 'separator', name: 'Group A', enabled: true }, []));
    }],
    ['add separator', (commands) => {
      registerSeparatorCommands(commands, instance, recordingReporter(), scriptedDialog(), vi.fn(), () => []);
      return invoke('modbench.separator.add', new ModNode({ kind: 'mod', name: 'Mod A', enabled: true }));
    }],
  ])('%s', async (_case, open) => {
    showInputBox.mockResolvedValueOnce(undefined);

    await open(commandsOver(mods, unreadable).commands);
    const validate = validatorOfThePrompt();

    expect([await validate(''), await validate('Named')]).toEqual([undefined, 'modlist.txt is locked']);
  });
});

describe('enable and disable: the whole selection, one write per direction', () => {
  beforeEach(() => { vi.clearAllMocks(); progressSteps.length = 0; });

  const mods = [mod('Mod A', false), mod('Mod B')];
  const instance = instanceOf(mods);
  const modA = new ModNode({ kind: 'mod', name: 'Mod A', enabled: false });
  const modB = new ModNode({ kind: 'mod', name: 'Mod B', enabled: true });

  it.each([
    ['modbench.mod.enable', modA, true],
    ['modbench.mod.disable', modB, false],
  ] as const)('%s applies to every selected mod, whatever its own current state', async (command, clicked, enabled) => {
    const { fake, commands } = commandsOver(mods);

    registerModEnableCommands(commands, instance, () => [], recordingReporter());
    await invoke(command, clicked, [modA, modB]);

    expect(fake.calls).toEqual([modOrderChange({ kind: 'enable', mod: 'Mod A', enabled }, { kind: 'enable', mod: 'Mod B', enabled })]);
  });

  it('says nothing when the whole selection lands', async () => {
    const reporter = recordingReporter();

    registerModEnableCommands(commandsOver(mods).commands, instance, () => [], reporter);
    await invoke('modbench.mod.enable', modA);

    expect(reporter.reports).toEqual([]);
  });
});

describe('enable and disable, called by the agent', () => {
  beforeEach(() => { vi.clearAllMocks(); progressSteps.length = 0; });

  const mods = [mod('Mod B', false)];
  const instance = instanceOf(mods);
  const selected = new ModNode({ kind: 'mod', name: 'Selected Mod', enabled: false });

  it.each([
    ['modbench.mod.enable', true],
    ['modbench.mod.disable', false],
  ])('%s acts on the mods given, never on the selection, and answers the outcome, reporting nothing', async (command, enabled) => {
    const { fake, commands } = commandsOver(mods);
    const reporter = recordingReporter();
    registerModEnableCommands(commands, instance, () => [selected], reporter);

    const answered = await invoke(command, new AgentCall([{ kind: 'mod', name: 'Mod B' }, { kind: 'mod', name: 'Gone' }], {}));

    expect(fake.calls).toEqual([modOrderChange({ kind: 'enable', mod: 'Mod B', enabled })]);
    expect(answered).toEqual({ applied: true, outcome: { landed: ['Mod B'], refused: [{ item: 'Gone', reason: 'Mod not found in modlist: Gone' }] } });
    expect(reporter.reports).toEqual([]);
  });
});

describe('move: the selection of mods or of separators, to a picked place', () => {
  beforeEach(() => { vi.clearAllMocks(); progressSteps.length = 0; shown = undefined; });

  const mods = [mod('Mod A'), separator('Group A'), mod('Mod B'), separator('Group B'), mod('Mod C')];
  const instance = instanceOf(mods);
  const modA = new ModNode({ kind: 'mod', name: 'Mod A', enabled: true });
  const modC = new ModNode({ kind: 'mod', name: 'Mod C', enabled: true });
  const groupA = new SeparatorNode({ kind: 'separator', name: 'Group A', enabled: true }, []);
  const groupB = new SeparatorNode({ kind: 'separator', name: 'Group B', enabled: true }, []);
  const losingAtTop = { selection: () => [], direction: () => 'losingAtTop' as const };
  type PlaceItem = { label: string; description?: string };
  let shown: ReturnType<typeof quickPickChoosing<PlaceItem>> | undefined;
  const scriptPick = (choose: (items: readonly PlaceItem[]) => PlaceItem | undefined) =>
    createQuickPick.mockImplementationOnce(() => (shown = quickPickChoosing<PlaceItem>(choose)));
  const shownPick = () => present(shown, 'the shown pick');
  const pickedLabels = (): string[] => shownPick().items.map((item) => item.label);
  const pickLabelled = (label: string) => scriptPick((items) => items.find((i) => i.label === label));
  const escapeAtPick = () => scriptPick(() => undefined);

  it('right-clicked on a mod in a mixed selection, moves only the mods to the picked separator', async () => {
    pickLabelled('Group B');
    const { fake, commands } = commandsOver(mods);

    registerModMoveCommand(commands, instance, losingAtTop, recordingReporter());
    await invoke('modbench.mod.move', modA, [modA, groupB, modC]);

    expect(pickedLabels()).toEqual(['Ungrouped', 'Group B', 'Group A']);
    expect(fake.calls).toEqual([modOrderChange({ kind: 'moveMods', mods: ['Mod A', 'Mod C'], place: { kind: 'separator', name: 'Group B' }, end: 'losing' })]);
  });

  it('right-clicked on a separator in a mixed selection, moves only the separators above the picked one', async () => {
    pickLabelled('Group A');
    const { fake, commands } = commandsOver(mods);

    registerModMoveCommand(commands, instance, losingAtTop, recordingReporter());
    await invoke('modbench.mod.move', groupB, [modA, groupB]);

    expect(pickedLabels()).toEqual(['Group A']);
    expect(fake.calls).toEqual([modOrderChange({ kind: 'moveSeparators', separators: ['Group B'], place: { kind: 'separator', name: 'Group A' }, end: 'losing' })]);
  });

  it('with winning at the top, lands mods and separators toward the winning end, as the view shows it', async () => {
    const winningAtTop = { selection: () => [], direction: () => 'winningAtTop' as const };
    const { fake, commands } = commandsOver(mods);

    registerModMoveCommand(commands, instance, winningAtTop, recordingReporter());
    pickLabelled('Group A');
    await invoke('modbench.mod.move', modC);
    pickLabelled('Group A');
    await invoke('modbench.mod.move', groupB);

    expect(fake.calls).toEqual([
      modOrderChange({ kind: 'moveMods', mods: ['Mod C'], place: { kind: 'separator', name: 'Group A' }, end: 'winning' }),
      modOrderChange({ kind: 'moveSeparators', separators: ['Group B'], place: { kind: 'separator', name: 'Group A' }, end: 'winning' }),
    ]);
  });

  it('handed a target, as a drop hands one, moves there without a pick', async () => {
    const { fake, commands } = commandsOver(mods);

    registerModMoveCommand(commands, instance, losingAtTop, recordingReporter());
    await invoke('modbench.mod.move', modC, [modC], { place: { kind: 'mod', name: 'Mod A' }, end: 'winning' });
    await invoke('modbench.mod.move', groupB, [groupB], { place: { kind: 'modOrder' }, end: 'winning' });

    expect(createQuickPick).not.toHaveBeenCalled();
    expect(fake.calls).toEqual([
      modOrderChange({ kind: 'moveMods', mods: ['Mod C'], place: { kind: 'mod', name: 'Mod A' }, end: 'winning' }),
      modOrderChange({ kind: 'moveSeparators', separators: ['Group B'], place: { kind: 'modOrder' }, end: 'winning' }),
    ]);
  });

  it('opens the mods pick on the place that holds the selected mods', async () => {
    escapeAtPick();

    registerModMoveCommand(commandsOver(mods).commands, instance, losingAtTop, recordingReporter());
    await invoke('modbench.mod.move', modC);

    const { items, activeItems } = shownPick();
    expect(activeItems).toEqual([items.find((i) => i.description === 'current')]);
    expect(activeItems.map((i) => i.label)).toEqual(['Ungrouped']);
  });

  it('with the selected mods in several places, opens on none', async () => {
    escapeAtPick();

    registerModMoveCommand(commandsOver(mods).commands, instance, losingAtTop, recordingReporter());
    await invoke('modbench.mod.move', modA, [modA, modC]);

    expect(shownPick().activeItems).toEqual([]);
  });

  it('opens the separators pick on no item', async () => {
    escapeAtPick();

    registerModMoveCommand(commandsOver(mods).commands, instance, losingAtTop, recordingReporter());
    await invoke('modbench.mod.move', groupB);

    expect(shownPick().activeItems).toEqual([]);
  });

  it('from the palette over a selection mixing mods and separators, moves nothing and says nothing', async () => {
    const { fake, commands } = commandsOver(mods);
    const reporter = recordingReporter();

    registerModMoveCommand(commands, instance, { ...losingAtTop, selection: () => [modA, groupA] }, reporter);
    await invoke('modbench.mod.move');

    expect(createQuickPick).not.toHaveBeenCalled();
    expect([fake.calls, reporter.reports]).toEqual([[], []]);
  });

  it.each([
    ['mods', modA],
    ['separators', groupB],
  ])('Esc at the %s pick moves nothing and says nothing', async (_case, clicked) => {
    escapeAtPick();
    const { fake, commands } = commandsOver(mods);
    const reporter = recordingReporter();

    registerModMoveCommand(commands, instance, losingAtTop, reporter);
    await invoke('modbench.mod.move', clicked);

    expect(createQuickPick).toHaveBeenCalledOnce();
    expect([fake.calls, reporter.reports]).toEqual([[], []]);
  });
});

describe('open folder: one command for a mod, the Overwrite row, a file and a folder', () => {
  beforeEach(() => { vi.clearAllMocks(); progressSteps.length = 0; });

  const instance = {
    ...instanceThatReads,
    value: instanceValueFixture({
      paths: { overwriteDir: '/instance/overwrite', downloadsDir: '', modDirs: new Map([['My Mod', '/instance/mods/My Mod']]), sourceDirs: new Map() },
    }),
  };
  const revealed = (): (string | undefined)[] =>
    executeCommand.mock.calls.filter((c) => c[0] === 'revealInExplorer').map((c) => c[1]?.fsPath);
  const myMod = new ModNode({ kind: 'mod', name: 'My Mod', enabled: true });
  const linked: OriginFile = { ...file('mods/My Mod', 'textures/a.dds'), sourcePath: '/elsewhere/a.dds' };
  const textures = new FolderNode(myMod, { kind: 'mod', name: 'My Mod' }, folder('mods/My Mod', 'textures'), [linked], [], 'textures');
  const leaf = new FileNode(textures, textures.origin, linked, 'a.dds');

  it.each<[string, ModlistNode[], unknown[], string]>([
    ['the clicked mod\'s own folder, as the value names it', [], [myMod], '/instance/mods/My Mod'],
    ['the overwrite folder from the Overwrite row', [], [new OverwriteNode([], 'MO2')], '/instance/overwrite'],
    ['a clicked file where it sits in its mod, a link too', [], [leaf], '/instance/mods/My Mod/textures/a.dds'],
    ['the one selected file from the palette', [leaf], [], '/instance/mods/My Mod/textures/a.dds'],
    ['a clicked folder where the value says it sits', [], [textures], '/instance/mods/My Mod/textures'],
    ['the one selected folder from the palette', [textures], [], '/instance/mods/My Mod/textures'],
  ])('reveals %s', async (_case, selection, args, path) => {
    registerOpenFolderCommand(instance, recordingReporter(), () => selection);
    await invoke('modbench.mod.openFolder', ...args);

    expect(revealed()).toEqual([path]);
  });

  it.each<[string, () => Pick<typeof instance, 'value'>, ModlistNode, string]>([
    ['a mod no folder holds, naming it, rather than returning in silence', () => instance,
      new ModNode({ kind: 'mod', name: 'Folderless Mod', enabled: true }), 'Folderless Mod'],
    ['the Overwrite row while the value names no folder for it, rather than revealing an empty path',
      () => ({ value: instanceValueFixture({ paths: { ...instance.value.paths, overwriteDir: undefined } }) }), new OverwriteNode([], 'MO2'), 'Overwrite'],
  ])('refuses %s', async (_case, holding, clicked, name) => {
    const reporter = recordingReporter();

    registerOpenFolderCommand(holding(), reporter, () => []);
    await invoke('modbench.mod.openFolder', clicked);

    expect(revealed()).toEqual([]);
    expect(reporter.reports).toEqual([{ severity: 'error', message: `Failed to open the folder of "${name}".`, detail: 'No folder holds it.' }]);
  });

  it.each<[string, ModlistNode[]]>([
    ['several rows', [myMod, new OverwriteNode([], 'MO2')]],
    ['a separator', [new SeparatorNode({ kind: 'separator', name: 'Group', enabled: true }, [])]],
  ])('reveals nothing from the palette over a selection of %s', async (_what, selection) => {
    registerOpenFolderCommand(instance, recordingReporter(), () => selection);
    await invoke('modbench.mod.openFolder');

    expect(revealed()).toEqual([]);
  });

  it.each<[string, ModlistNode, string]>([
    ['a file by its path in its mod', leaf, 'textures/a.dds'],
    ['a mod by its name', myMod, 'My Mod'],
  ])('reports a reveal that fails, naming %s', async (_case, row, name) => {
    executeCommand.mockRejectedValueOnce(new Error('no explorer'));
    const reporter = recordingReporter();

    registerOpenFolderCommand(instance, reporter, () => []);
    await invoke('modbench.mod.openFolder', row);

    expect(reporter.reports).toEqual([{ severity: 'error', message: `Failed to open the folder of "${name}".`, detail: 'no explorer' }]);
  });
});

describe('view on Nexus: one command for a mod and for a downloaded file', () => {
  beforeEach(() => { vi.clearAllMocks(); progressSteps.length = 0; });

  const instance = { ...instanceThatReads, value: instanceValueFixture({ gameName: 'Skyrim Special Edition' }) };
  const opened = (): string[] => openExternal.mock.calls.map((c) => String(c[0]));
  const downloadedFileRow = (nexusModId?: string): NexusModRow => ({ nexusModId });

  it.each<[string, unknown, string]>([
    ['a mod row', new ModNode({ kind: 'mod', name: 'My Mod', enabled: true, nexusId: '42' }), 'https://www.nexusmods.com/skyrimspecialedition/mods/42'],
    ['a downloaded file row', downloadedFileRow('123'), 'https://www.nexusmods.com/skyrimspecialedition/mods/123'],
  ])('opens the mod\'s Nexus page from %s', async (_case, row, page) => {
    registerViewOnNexusCommand(instance, recordingReporter(), () => undefined);
    await invoke('modbench.mod.viewOnNexus', row);

    expect(opened()).toEqual([page]);
  });

  it('takes the domain from the game the mod\'s metadata names, not the instance\'s', async () => {
    registerViewOnNexusCommand(instance, recordingReporter(), () => undefined);
    await invoke('modbench.mod.viewOnNexus', new ModNode({ kind: 'mod', name: 'My Mod', enabled: true, nexusId: '42', gameName: 'Starfield' }));
    await invoke('modbench.mod.viewOnNexus', { nexusModId: '123', gameName: 'Fallout 4' });

    expect(opened()).toEqual(['https://www.nexusmods.com/starfield/mods/42', 'https://www.nexusmods.com/fallout4/mods/123']);
  });

  it.each([
    ['a mod', new ModNode({ kind: 'mod', name: 'My Mod', enabled: true, nexusId: '42', gameName: 'EnderalSE' })],
    ['a downloaded file', { nexusModId: '42', gameName: 'EnderalSE' }],
  ])('opens no page for %s of a game the registry holds no domain for, and names the game', async (_row, row) => {
    const reporter = recordingReporter();

    registerViewOnNexusCommand(instance, reporter, () => undefined);
    await invoke('modbench.mod.viewOnNexus', row);

    expect([openExternal.mock.calls, reporter.reports]).toEqual([[], [
      { severity: 'error', message: 'Failed to open the Nexus page of mod 42.', detail: "Nexus has no domain for the game 'EnderalSE'." },
    ]]);
  });

  it('reports a page that fails to open', async () => {
    openExternal.mockRejectedValueOnce(new Error('no browser'));
    const reporter = recordingReporter();

    registerViewOnNexusCommand(instance, reporter, () => undefined);
    await invoke('modbench.mod.viewOnNexus', new ModNode({ kind: 'mod', name: 'My Mod', enabled: true, nexusId: '42' }));

    expect(reporter.reports).toEqual([
      { severity: 'error', message: 'Failed to open the Nexus page of mod 42.', detail: 'no browser' },
    ]);
  });

  it('opens the selected row\'s Nexus page from the palette, which hands it no row', async () => {
    registerViewOnNexusCommand(instance, recordingReporter(), () => downloadedFileRow('123'));
    await invoke('modbench.mod.viewOnNexus');

    expect(opened()).toEqual(['https://www.nexusmods.com/skyrimspecialedition/mods/123']);
  });

  it('opens the right-clicked row\'s page, never the selected one\'s', async () => {
    registerViewOnNexusCommand(instance, recordingReporter(), () => downloadedFileRow('123'));
    await invoke('modbench.mod.viewOnNexus', new ModNode({ kind: 'mod', name: 'My Mod', enabled: true, nexusId: '42' }));

    expect(opened()).toEqual(['https://www.nexusmods.com/skyrimspecialedition/mods/42']);
  });

  it('opens nothing for a row with no Nexus id', async () => {
    registerViewOnNexusCommand(instance, recordingReporter(), () => undefined);
    await invoke('modbench.mod.viewOnNexus', downloadedFileRow());
    await invoke('modbench.mod.viewOnNexus', new ModNode({ kind: 'mod', name: 'My Mod', enabled: true }));

    expect(openExternal).not.toHaveBeenCalled();
  });
});

describe('copy value in Mods: one line for each selected row copy value takes', () => {
  const alpha = new ModNode({ kind: 'mod', name: 'Alpha', enabled: true });
  const groupA = new SeparatorNode({ kind: 'separator', name: 'Group A', enabled: true }, []);
  const beta = new ModNode({ kind: 'mod', name: 'Beta', enabled: true });
  const groupB = new SeparatorNode({ kind: 'separator', name: 'Group B', enabled: true }, []);
  const armour = new ModNode({ kind: 'mod', name: 'Armour', enabled: true });
  const armourFile = file('mods/Armour', 'textures/armour/a.dds');
  const textures = new FolderNode(armour, { kind: 'mod', name: 'Armour' }, folder('mods/Armour', 'textures'), [armourFile], [], 'textures');
  const leaf = new FileNode(textures, textures.origin, armourFile, 'a.dds');
  const noSelection = (): ModlistNode[] => [];

  it.each<[string, ModlistNode, string]>([
    ['a mod its own name', alpha, 'Alpha'],
    ['a separator its own name', groupA, 'Group A'],
    ['a file its path in its mod', leaf, 'textures/armour/a.dds'],
    ['a folder its path in its mod', textures, 'textures'],
  ])('copies for %s right-clicked alone', (_case, clicked, text) => {
    expect(modsCopyValueText(noSelection)(clicked, undefined)).toBe(text);
  });

  it('copies every selected mod\'s and separator\'s name, one per line, when the selection mixes kinds', () => {
    expect(modsCopyValueText(noSelection)(beta, [alpha, groupA, beta, groupB])).toBe('Alpha\nGroup A\nBeta\nGroup B');
  });

  it('excludes the Overwrite row from a selection that includes it', () => {
    expect(modsCopyValueText(noSelection)(alpha, [alpha, new OverwriteNode([], 'MO2')])).toBe('Alpha');
  });

  it('is undefined for the Overwrite row, so another surface\'s copy takes over', () => {
    expect(modsCopyValueText(noSelection)(new OverwriteNode([], 'MO2'), undefined)).toBeUndefined();
  });

  it('copies the view\'s selection for the Mods key\'s own args', () => {
    const viewSelection = (): ModlistNode[] => [alpha, groupA, new OverwriteNode([], 'MO2')];
    expect(modsCopyValueText(viewSelection)(MODS_KEY_ARGS, undefined)).toBe('Alpha\nGroup A');
  });

  it('copies each selected file\'s and folder\'s path in its mod beside the mods\' names, from a click and from the key', () => {
    expect([
      modsCopyValueText(noSelection)(textures, [alpha, textures, leaf]),
      modsCopyValueText(() => [leaf, textures])(MODS_KEY_ARGS, undefined),
    ]).toEqual(['Alpha\ntextures\ntextures/armour/a.dds', 'textures/armour/a.dds\ntextures']);
  });
});

const filesOfM = (files: readonly OriginFile[]): Partial<InstanceReading> => ({
  modFiles: new Map([['M', { origin: 'M', folder: '/instance/mods/M', files: [...files], folders: [], notes: [] }]]),
});

describe('exclude and include file: every selected file, in the right-clicked row\'s direction', () => {
  beforeEach(() => { vi.clearAllMocks(); progressSteps.length = 0; });

  const modRow = new ModNode({ kind: 'mod', name: 'M', enabled: true });
  const origin = { kind: 'mod', name: 'M' } as const;
  const fileRow = (listed: OriginFile, parent: ModNode | FolderNode = modRow) => new FileNode(parent, origin, listed, listed.relativePath);
  const included = fileRow(file('mods/M', 'a.dds'));
  const excluded = fileRow(file('mods/M', 'b.dds.mohidden', true));
  const hidingFolder = new FolderNode(modRow, origin, folder('mods/M', 'x.mohidden', true), [], [], 'x.mohidden');
  const plainInFolder = fileRow({ ...file('mods/M', 'x.mohidden/c.dds', true), markedExcluded: false }, hidingFolder);
  const markedInFolder = fileRow(file('mods/M', 'x.mohidden/d.dds.mohidden', true), hidingFolder);
  const mods = [mod('M')];
  const listed = filesOfM([included.file, excluded.file, plainInFolder.file, markedInFolder.file]);
  const instance = instanceOf(mods);
  const marked = (relativePath: string, mark: 'Excluded' | 'Included'): AdapterCall => ({ verb: 'markOriginFile', origin, relativePath, mark });

  it('sends every selected file to the write, whatever the view shows each as, and nothing else', async () => {
    const { fake, commands } = commandsOver(mods, {}, listed);
    const reporter = recordingReporter();

    registerFileExclusionCommands(commands, instance, () => [], reporter);
    await invoke('modbench.mod.excludeFile', included, [included, excluded, modRow]);

    expect(fake.calls).toEqual([marked('a.dds', 'Excluded'), marked('b.dds.mohidden', 'Excluded')]);
    expect(reporter.reports).toEqual([]);
  });

  it('includes the view\'s selection from the palette, where no row is right-clicked', async () => {
    const { fake, commands } = commandsOver(mods, {}, listed);

    registerFileExclusionCommands(commands, instance, () => [excluded], recordingReporter());
    await invoke('modbench.mod.includeFile');

    expect(fake.calls).toEqual([marked('b.dds.mohidden', 'Included')]);
  });

  it.each([
    ['excludeFile', 'Excluded', included], ['includeFile', 'Included', excluded],
  ] as const)('%s takes a file its folder excludes by its own name, with the selection\'s others', async (verb, mark, clicked) => {
    const { fake, commands } = commandsOver(mods, {}, listed);

    registerFileExclusionCommands(commands, instance, () => [], recordingReporter());
    await invoke(`modbench.mod.${verb}`, clicked, [clicked, plainInFolder, markedInFolder]);

    expect(fake.calls).toEqual([
      marked(clicked.file.relativePath, mark), marked('x.mohidden/c.dds', mark), marked('x.mohidden/d.dds.mohidden', mark),
    ]);
  });

  it('writes nothing and reports nothing over a selection with no file', async () => {
    const { fake, commands } = commandsOver(mods, {}, listed);
    const reporter = recordingReporter();

    registerFileExclusionCommands(commands, instance, () => [modRow], reporter);
    await invoke('modbench.mod.excludeFile');

    expect([fake.calls, reporter.reports]).toEqual([[], []]);
  });
});

describe('a Mods gesture that writes ends on the Instance loader\'s read, with the view\'s progress bar open throughout', () => {
  beforeEach(() => { vi.clearAllMocks(); progressSteps.length = 0; });

  const mods = [mod('Mod A'), mod('Mod B'), separator('Group A')];
  const instance = instanceOf(mods);
  const modA = new ModNode({ kind: 'mod', name: 'Mod A', enabled: true });
  const modB = new ModNode({ kind: 'mod', name: 'Mod B', enabled: true });
  const groupA = new SeparatorNode({ kind: 'separator', name: 'Group A', enabled: true }, []);
  const fileRow = new FileNode(modA, { kind: 'mod', name: 'Mod A' }, file('mods/Mod A', 'a.dds'), 'a.dds');
  const eachWriteInOrder: InstanceAnswers = { refusals: (call) => { progressSteps.push(call.verb); return undefined; } };
  const commands = () => commandsOver(mods, eachWriteInOrder, {
    modFiles: new Map([['Mod A', { origin: 'Mod A', folder: '/instance/mods/Mod A', files: [fileRow.file], folders: [], notes: [] }]]),
  }).commands;
  const reporter = () => recordingReporter();

  it.each<[string, () => Promise<unknown>, string[]]>([
    ['enable', () => {
      registerModEnableCommands(commands(), instance, () => [], reporter());
      return invoke('modbench.mod.enable', modA);
    }, ['changeModOrder']],
    ['disable over a selection, in one write', () => {
      registerModEnableCommands(commands(), instance, () => [], reporter());
      return invoke('modbench.mod.disable', modA, [modA, modB]);
    }, ['changeModOrder']],
    ['move', () => {
      registerModMoveCommand(commands(), instance, { selection: () => [], direction: () => 'losingAtTop' }, reporter());
      return invoke('modbench.mod.move', modA, [modA], { place: { kind: 'ungrouped' }, end: 'losing' });
    }, ['changeModOrder']],
    ['uninstall', () => {
      registerModContextCommands({
        commands: commands(), instance, viewSelection: () => [], reporter: reporter(), ask: scriptedDialog('Uninstall'), trash: vi.fn(), log: vi.fn(),
      });
      return invoke('modbench.mod.uninstall', modA);
    }, ['trashEntryFolder', 'trashSourceFolder', 'changeModOrder']],
    ['separator delete', () => {
      registerSeparatorCommands(commands(), instance, reporter(), scriptedDialog('Delete'), vi.fn(), () => []);
      return invoke('modbench.separator.delete', groupA);
    }, ['trashEntryFolder', 'changeModOrder']],
    ['separator rename', () => {
      showInputBox.mockResolvedValueOnce('Renamed');
      registerSeparatorCommands(commands(), instance, reporter(), scriptedDialog(), vi.fn(), () => []);
      return invoke('modbench.separator.rename', groupA);
    }, ['changeModOrder']],
    ['separator add', () => {
      showInputBox.mockResolvedValueOnce('New Group');
      registerSeparatorCommands(commands(), instance, reporter(), scriptedDialog(), vi.fn(), () => []);
      return invoke('modbench.separator.add', groupA);
    }, ['changeModOrder']],
    ['create empty mod', () => {
      showInputBox.mockResolvedValueOnce('New Mod');
      registerCreateEmptyModCommand(commands(), instance, reporter());
      return invoke('modbench.mod.createEmpty');
    }, ['createModFolder', 'changeModOrder']],
    ['exclude file', () => {
      registerFileExclusionCommands(commands(), instance, () => [], reporter());
      return invoke('modbench.mod.excludeFile', fileRow);
    }, ['markOriginFile']],
  ])('%s', async (_name, run, writes) => {
    await run();

    expect(progressSteps).toEqual(['progress opens on modbench.modList', ...writes, 'Instance loader: read every file again', 'progress closes']);
  });
});

describe('open source: a source mod\'s source folder', () => {
  beforeEach(() => { vi.clearAllMocks(); progressSteps.length = 0; });

  const instance = {
    ...instanceThatReads,
    value: instanceValueFixture({
      listedSourceMods: new Set(['Source Mod']),
      paths: {
        overwriteDir: undefined, downloadsDir: '', modDirs: new Map(),
        sourceDirs: new Map([['Source Mod', '/instance/source/Source Mod']]),
      },
    }),
  };
  const revealed = (): (string | undefined)[] =>
    executeCommand.mock.calls.filter((c) => c[0] === 'revealInExplorer').map((c) => c[1]?.fsPath);

  it('reveals the clicked source mod\'s source folder, as the value names it', async () => {
    registerOpenSourceCommand(instance, recordingReporter(), () => []);
    await invoke('modbench.mod.openSource', new ModNode({ kind: 'mod', name: 'Source Mod', enabled: true }));

    expect(revealed()).toEqual(['/instance/source/Source Mod']);
  });

  it('refuses a mod with no repository, naming it', async () => {
    const reporter = recordingReporter();

    registerOpenSourceCommand(instance, reporter, () => []);
    await invoke('modbench.mod.openSource', new ModNode({ kind: 'mod', name: 'Plain Mod', enabled: true }));

    expect(revealed()).toEqual([]);
    expect(reporter.reports).toEqual([
      { severity: 'error', message: 'Failed to open the source of "Plain Mod".', detail: 'It is not a source mod.' },
    ]);
  });

  it('reveals nothing from the palette over a selection of several rows', async () => {
    const sourceMod = new ModNode({ kind: 'mod', name: 'Source Mod', enabled: true });

    registerOpenSourceCommand(instance, recordingReporter(), () => [sourceMod, sourceMod]);
    await invoke('modbench.mod.openSource');

    expect(revealed()).toEqual([]);
  });
});

describe('the mod gestures, called by the agent', () => {
  beforeEach(() => { vi.clearAllMocks(); progressSteps.length = 0; });

  const mods = [mod('Mod A'), mod('Mod B'), separator('Group'), separator('Group B')];
  const instance = instanceOf(mods);
  const selected = new ModNode({ kind: 'mod', name: 'Selected Mod', enabled: true });
  const ofMods = (...names: string[]) => new AgentCall(names.map((name) => ({ kind: 'mod' as const, name })), {});
  const nothingOpened = () => {
    expect(showInputBox).not.toHaveBeenCalled();
    expect(createQuickPick).not.toHaveBeenCalled();
  };

  describe('move', () => {
    const group = { kind: 'separator', name: 'Group' } as const;
    const view = { selection: () => [selected], direction: () => 'losingAtTop' as const };

    it('moves the mods given to the place given, never the selection, opening no pick, and answers the outcome', async () => {
      const { fake, commands } = commandsOver(mods);
      const reporter = recordingReporter();
      registerModMoveCommand(commands, instance, view, reporter);

      const answered = await invoke('modbench.mod.move', new AgentCall([{ kind: 'mod', name: 'Mod A' }, { kind: 'mod', name: 'Mod B' }], { place: group, end: 'winning' }));

      expect(fake.calls).toEqual([modOrderChange({ kind: 'moveMods', mods: ['Mod A', 'Mod B'], place: group, end: 'winning' })]);
      expect(answered).toEqual({ applied: true, outcome: { landed: ['Mod A', 'Mod B'], refused: [] } });
      expect(reporter.reports).toEqual([]);
      nothingOpened();
    });

    it('moves separators given as separators to a separator place, never the selection, and answers the outcome', async () => {
      const { fake, commands } = commandsOver(mods);
      registerModMoveCommand(commands, instance, view, recordingReporter());
      const above = { kind: 'separator', name: 'Group B' } as const;

      const answered = await invoke('modbench.mod.move', new AgentCall([{ kind: 'separator', name: 'Group' }], { place: above, end: 'winning' }));

      expect(fake.calls).toEqual([modOrderChange({ kind: 'moveSeparators', separators: ['Group'], place: above, end: 'winning' })]);
      expect(answered).toEqual({ applied: true, outcome: { landed: ['Group'], refused: [] } });
      nothingOpened();
    });

    it('refuses an Argument that mixes mods and separators, as the view moves neither', async () => {
      const { fake, commands } = commandsOver(mods);
      registerModMoveCommand(commands, instance, view, recordingReporter());

      await expect(invoke('modbench.mod.move', new AgentCall([{ kind: 'mod', name: 'Mod A' }, { kind: 'separator', name: 'Group' }], { place: group, end: 'winning' })))
        .rejects.toBeInstanceOf(Refusal);

      expect(fake.calls).toEqual([]);
    });
  });

  describe('rename', () => {
    const renameCall = (name: string) => new AgentCall([{ kind: 'mod', name: 'Mod A' }], { name });
    const register = (commands: ModCommands, reporter = recordingReporter()) =>
      registerModContextCommands({ commands, instance, viewSelection: () => [selected], reporter, ask: scriptedDialog(), trash: vi.fn(), log: vi.fn() });

    it('renames the mod given to the name given, never the selection, asking nothing, and answers the outcome', async () => {
      const { fake, commands } = commandsOver(mods);
      const reporter = recordingReporter();
      register(commands, reporter);

      const answered = await invoke('modbench.mod.rename', renameCall('Renamed'));

      expect(fake.calls.filter((call) => call.verb === 'renameModFolder')).toEqual([{ verb: 'renameModFolder', from: 'Mod A', to: 'Renamed' }]);
      expect(answered).toEqual({ applied: true, outcome: { landed: ['Renamed'], refused: [] }, partial: [] });
      expect(reporter.reports).toEqual([]);
      nothingOpened();
    });

    it('answers a rename to the mod\'s own name as nothing landed and nothing refused, writing and reporting nothing', async () => {
      const { fake, commands } = commandsOver(mods);
      const reporter = recordingReporter();
      register(commands, reporter);

      const answered = await invoke('modbench.mod.rename', renameCall('Mod A'));

      expect(answered).toEqual({ applied: true, outcome: { landed: [], refused: [] } });
      expect([fake.calls, reporter.reports]).toEqual([[], []]);
    });

    it('refuses an Argument of more than one mod', async () => {
      const { fake, commands } = commandsOver(mods);
      register(commands);

      await expect(invoke('modbench.mod.rename', new AgentCall([{ kind: 'mod', name: 'Mod A' }, { kind: 'mod', name: 'Mod B' }], { name: 'X' }))).rejects.toBeInstanceOf(Refusal);

      expect(fake.calls).toEqual([]);
    });
  });

  it('uninstall uninstalls the mods given, never the selection, confirming nothing', async () => {
    const { fake, commands } = commandsOver(mods);
    const ask = scriptedDialog();
    registerModContextCommands({ commands, instance, viewSelection: () => [selected], reporter: recordingReporter(), ask, trash: vi.fn(), log: vi.fn() });

    const answered = await invoke('modbench.mod.uninstall', ofMods('Mod A', 'Mod B'));

    expect(fake.calls.filter((call) => call.verb === 'trashEntryFolder')).toEqual([trashed('mod', 'Mod A'), trashed('mod', 'Mod B')]);
    expect(answered).toEqual({ applied: true, outcome: { landed: [{ name: 'Mod A' }, { name: 'Mod B' }], refused: [] }, partial: [] });
    expect(ask.asked).toEqual([]);
  });

  describe('create empty mod', () => {
    const createCall = (name: string) => new AgentCall([], { name });

    it('creates the mod named, prompting for nothing, and answers the outcome', async () => {
      const { fake, commands } = commandsOver(mods);
      const reporter = recordingReporter();
      registerCreateEmptyModCommand(commands, instance, reporter);

      const answered = await invoke('modbench.mod.createEmpty', createCall('New Mod'));

      expect(fake.calls[0]).toEqual({ verb: 'createModFolder', mod: 'New Mod' });
      expect(answered).toEqual({ applied: true, outcome: { landed: ['New Mod'], refused: [] }, partial: [] });
      expect(reporter.reports).toEqual([]);
      nothingOpened();
    });

    it('refuses a name a folder holds as a Refusal, creating nothing', async () => {
      const { fake, commands } = commandsOver(mods);
      registerCreateEmptyModCommand(commands, instance, recordingReporter());

      await expect(invoke('modbench.mod.createEmpty', createCall('Mod A'))).rejects.toEqual(
        new Refusal('A mod named "Mod A" already exists. Install its next release from Downloads, or uninstall it to install anew.'));

      expect(fake.calls).toEqual([]);
    });

    it('leaves a blank name to the command, which refuses it for the view as for the agent', async () => {
      const { fake, commands } = commandsOver(mods);
      const reporter = recordingReporter();
      registerCreateEmptyModCommand(commands, instance, reporter);

      const answered = await invoke('modbench.mod.createEmpty', createCall('  '));
      showInputBox.mockResolvedValueOnce('  ');
      await invoke('modbench.mod.createEmpty');

      expect(fake.calls).toEqual([]);
      expect(answered).toEqual({ applied: false, refusal: 'Failed to create "  ".', detail: 'A mod name cannot be empty.' });
      expect(reporter.reports).toEqual([{ severity: 'error', message: 'Failed to create "  ".', detail: 'A mod name cannot be empty.' }]);
    });
  });

  it.each([
    ['modbench.mod.excludeFile', 'Excluded'],
    ['modbench.mod.includeFile', 'Included'],
  ] as const)('%s marks the files given, never the selection, and answers the outcome', async (command, mark) => {
    const origin = { kind: 'mod', name: 'M' } as const;
    const inSelection = new FileNode(selected, origin, file('mods/M', 'sel.dds'), 'sel.dds');
    const { fake, commands } = commandsOver([mod('M')], {}, filesOfM([file('mods/M', 'a.dds'), inSelection.file]));
    const reporter = recordingReporter();
    registerFileExclusionCommands(commands, instance, () => [inSelection], reporter);

    const answered = await invoke(command, new AgentCall([{ kind: 'file', origin, relativePath: 'a.dds' }], {}));

    expect(fake.calls).toEqual([{ verb: 'markOriginFile', origin, relativePath: 'a.dds', mark }]);
    expect(answered).toEqual({ applied: true, outcome: { landed: [{ origin, relativePath: 'a.dds' }], refused: [] } });
    expect(reporter.reports).toEqual([]);
    nothingOpened();
  });
});

describe('the separator gestures, called by the agent', () => {
  beforeEach(() => { vi.clearAllMocks(); progressSteps.length = 0; });

  const mods = [separator('Group A'), mod('Mod A'), separator('Group B')];
  const instance = instanceOf(mods);
  const selected = new SeparatorNode({ kind: 'separator', name: 'Selected Group', enabled: true }, []);
  const register = (commands: ModCommands, reporter = recordingReporter(), ask = scriptedDialog()) =>
    registerSeparatorCommands(commands, instance, reporter, ask, vi.fn(), () => [selected]);
  const group = (name: string) => ({ kind: 'separator' as const, name });
  const nothingOpened = (ask: ReturnType<typeof scriptedDialog>) => {
    expect(showInputBox).not.toHaveBeenCalled();
    expect(ask.asked).toEqual([]);
  };

  it.each([
    ['a mod', { kind: 'mod', name: 'Mod A' }],
    ['a separator', group('Group A')],
  ] as const)('add adds the separator named beside %s given, never the selection, asking nothing, and answers the outcome', async (_, anchor) => {
    const { fake, commands } = commandsOver(mods);
    const reporter = recordingReporter();
    const ask = scriptedDialog();
    register(commands, reporter, ask);

    const answered = await invoke('modbench.separator.add', new AgentCall([anchor], { name: 'New Section' }));

    expect(fake.calls).toEqual([modOrderChange({ kind: 'addSeparator', separator: 'New Section', anchor })]);
    expect(answered).toEqual({ applied: true, outcome: { landed: ['New Section'], refused: [] } });
    expect(reporter.reports).toEqual([]);
    nothingOpened(ask);
  });

  it.each([
    ['add', 'modbench.separator.add'],
    ['rename', 'modbench.separator.rename'],
  ])('%s refuses an Argument of more than one entry, writing nothing', async (_case, command) => {
    const { fake, commands } = commandsOver(mods);
    register(commands);

    await expect(invoke(command, new AgentCall([group('Group A'), group('Group B')], { name: 'X' }))).rejects.toBeInstanceOf(Refusal);

    expect(fake.calls).toEqual([]);
  });

  it('rename renames the separator given to the name given, never the selection, asking nothing, and answers the outcome', async () => {
    const { fake, commands } = commandsOver(mods);
    const reporter = recordingReporter();
    const ask = scriptedDialog();
    register(commands, reporter, ask);

    const answered = await invoke('modbench.separator.rename', new AgentCall([group('Group A')], { name: 'Renamed' }));

    expect(fake.calls).toEqual([modOrderChange({ kind: 'renameSeparator', from: 'Group A', to: 'Renamed' })]);
    expect(answered).toEqual({ applied: true, outcome: { landed: ['Renamed'], refused: [] } });
    expect(reporter.reports).toEqual([]);
    nothingOpened(ask);
  });

  it('rename answers a rename that wrote nothing as nothing landed and nothing refused', async () => {
    register(commandsOver(mods).commands);

    expect(await invoke('modbench.separator.rename', new AgentCall([group('Group A')], { name: 'Group A' }))).toEqual({ applied: true, outcome: { landed: [], refused: [] } });
  });

  it('delete deletes the separators given, never the selection, asking nothing, and answers the outcome', async () => {
    const { fake, commands } = commandsOver(mods);
    const reporter = recordingReporter();
    const ask = scriptedDialog();
    register(commands, reporter, ask);

    const answered = await invoke('modbench.separator.delete', new AgentCall([group('Group A'), group('Group B')], {}));

    expect(fake.calls.filter((call) => call.verb === 'trashEntryFolder')).toEqual([trashed('separator', 'Group A'), trashed('separator', 'Group B')]);
    expect(answered).toEqual({ applied: true, outcome: { landed: [{ name: 'Group A' }, { name: 'Group B' }], refused: [] }, partial: [] });
    expect(reporter.reports).toEqual([]);
    nothingOpened(ask);
  });
});

describe('a Mods selection gesture reports a refusal through the shared reporter, once', () => {
  beforeEach(() => { vi.clearAllMocks(); progressSteps.length = 0; });

  const mods = [separator('Group A'), mod('Mod A'), separator('Group B'), mod('Mod C'), mod('M')];
  const instance = instanceOf(mods);
  const modA = new ModNode({ kind: 'mod', name: 'Mod A', enabled: true });
  const modB = new ModNode({ kind: 'mod', name: 'Mod B', enabled: true });
  const modC = new ModNode({ kind: 'mod', name: 'Mod C', enabled: true });
  const groupA = new SeparatorNode({ kind: 'separator', name: 'Group A', enabled: true }, []);
  const groupB = new SeparatorNode({ kind: 'separator', name: 'Group B', enabled: true }, []);
  const modRow = new ModNode({ kind: 'mod', name: 'M', enabled: true });
  const included = new FileNode(modRow, { kind: 'mod', name: 'M' }, file('mods/M', 'a.dds'), 'a.dds');
  const gone = new FileNode(modRow, { kind: 'mod', name: 'M' }, file('mods/M', 'c.dds'), 'c.dds');
  const trash = (path: string): Promise<void> =>
    (['/mods/Mod C', '/mods/Group B'].includes(path) ? Promise.reject(new Error('trash unavailable')) : Promise.resolve());
  const pickPlace = (label: string) => createQuickPick.mockImplementationOnce(() => quickPickChoosing<{ label: string }>((items) => items.find((i) => i.label === label)));
  const over = (answers: InstanceAnswers) => commandsOver(mods, answers, filesOfM([included.file])).commands;

  const gestures = {
    uninstall: (answers: InstanceAnswers, reporter: ReturnType<typeof recordingReporter>) => {
      registerModContextCommands({ commands: over(answers), instance, viewSelection: () => [], reporter, ask: scriptedDialog('Uninstall'), trash, log: vi.fn() });
      return invoke('modbench.mod.uninstall', modA, [modA, modC]);
    },
    'separator delete': (answers: InstanceAnswers, reporter: ReturnType<typeof recordingReporter>) => {
      registerSeparatorCommands(over(answers), instance, reporter, scriptedDialog('Delete'), trash, () => []);
      return invoke('modbench.separator.delete', groupA, [groupA, groupB]);
    },
    enable: (answers: InstanceAnswers, reporter: ReturnType<typeof recordingReporter>) => {
      registerModEnableCommands(over(answers), instance, () => [], reporter);
      return invoke('modbench.mod.enable', modA, [modA, modB]);
    },
    move: (answers: InstanceAnswers, reporter: ReturnType<typeof recordingReporter>) => {
      pickPlace('Ungrouped');
      registerModMoveCommand(over(answers), instance, { selection: () => [], direction: () => 'losingAtTop' }, reporter);
      return invoke('modbench.mod.move', modA, [modA, modB]);
    },
    'exclude file': (answers: InstanceAnswers, reporter: ReturnType<typeof recordingReporter>) => {
      registerFileExclusionCommands(over(answers), instance, () => [], reporter);
      return invoke('modbench.mod.excludeFile', included, [included, gone]);
    },
    'include file': (answers: InstanceAnswers, reporter: ReturnType<typeof recordingReporter>) => {
      registerFileExclusionCommands(over(answers), instance, () => [], reporter);
      return invoke('modbench.mod.includeFile', included, [included, gone]);
    },
  };

  it.each<[keyof typeof gestures, InstanceAnswers, string, string]>([
    ['uninstall', {}, 'Could not uninstall 1 of 2 mods.', '"Mod C" (trash unavailable)'],
    ['separator delete', {}, 'Could not delete 1 of 2 separators.', '"Group B" (trash unavailable)'],
    ['enable', {}, 'Could not enable 1 of 2 mods.', '"Mod B" (Mod not found in modlist: Mod B)'],
    ['move', {}, 'Could not move 1 of 2 mods.', '"Mod B" (Mod not found in modlist: Mod B)'],
    ['exclude file', {}, 'Could not exclude 1 of 2 files.', '"M/c.dds" ("c.dds" is gone from disk.)'],
  ])('%s names the refused item and why, while the others land', async (name, answers, message, detail) => {
    const reporter = recordingReporter();

    await gestures[name](answers, reporter);

    expect(reporter.reports).toEqual([{ severity: 'error', message, detail }]);
  });

  it.each<[keyof typeof gestures, InstanceAnswers, string]>([
    ['uninstall', { unreadablePublisher: 'ENOENT: modlist.txt' }, 'Failed to uninstall mods.'],
    ['separator delete', { unreadReads: { modOrder: 'ENOENT: modlist.txt' } }, 'Failed to delete separators.'],
    ['enable', { refusals: refusing('changeModOrder', 'ENOENT: modlist.txt') }, 'Failed to enable mods.'],
    ['move', { refusals: refusing('changeModOrder', 'ENOENT: modlist.txt') }, 'Failed to move mods.'],
    ['exclude file', { unreadReads: { sourceMods: 'ENOENT: modlist.txt' } }, 'Could not exclude 2 files.'],
    ['include file', { unreadReads: { sourceMods: 'ENOENT: modlist.txt' } }, 'Could not include 2 files.'],
  ])('%s reports a refusal of the whole selection with its cause', async (name, answers, message) => {
    const reporter = recordingReporter();

    await gestures[name](answers, reporter);

    expect(reporter.reports).toEqual([{ severity: 'error', message, detail: 'ENOENT: modlist.txt' }]);
  });
});

describe('a Mods gesture called by the agent refuses an Argument of a kind it does not take, writing nothing', () => {
  beforeEach(() => { vi.clearAllMocks(); progressSteps.length = 0; });

  const instance = instanceOf([mod('Mod A')]);
  const plugin = { kind: 'plugin', plugin: { name: 'A.esp', origin: 'Mod A' } } as const;
  const modArgument = { kind: 'mod', name: 'Mod A' } as const;
  const registerContext = (commands: ModCommands) =>
    registerModContextCommands({ commands, instance, viewSelection: () => [], reporter: recordingReporter(), ask: scriptedDialog(), trash: vi.fn(), log: vi.fn() });
  const registerSeparators = (commands: ModCommands) => registerSeparatorCommands(commands, instance, recordingReporter(), scriptedDialog(), vi.fn(), () => []);
  const registerEnable = (commands: ModCommands) => registerModEnableCommands(commands, instance, () => [], recordingReporter());
  const registerExclusion = (commands: ModCommands) => registerFileExclusionCommands(commands, instance, () => [], recordingReporter());

  it.each<[string, Argument, (commands: ModCommands) => unknown]>([
    ['modbench.mod.enable', plugin, registerEnable],
    ['modbench.mod.disable', plugin, registerEnable],
    ['modbench.mod.move', plugin, (commands) => registerModMoveCommand(commands, instance, { selection: () => [], direction: () => 'losingAtTop' }, recordingReporter())],
    ['modbench.mod.uninstall', plugin, registerContext],
    ['modbench.mod.rename', plugin, registerContext],
    ['modbench.mod.excludeFile', modArgument, registerExclusion],
    ['modbench.mod.includeFile', modArgument, registerExclusion],
    ['modbench.separator.add', plugin, registerSeparators],
    ['modbench.separator.rename', modArgument, registerSeparators],
    ['modbench.separator.delete', modArgument, registerSeparators],
  ])('%s', async (command, argument, register) => {
    const { fake, commands } = commandsOver([mod('Mod A')]);
    register(commands);

    await expect(invoke(command, new AgentCall([argument], { name: 'X' }))).rejects.toBeInstanceOf(Refusal);

    expect(fake.calls).toEqual([]);
  });
});
