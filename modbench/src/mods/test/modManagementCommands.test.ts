import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TreeItem, TreeItemCollapsibleState, TreeItemCheckboxState, EventEmitter, ThemeIcon, ThemeColor, MarkdownString, uriFile, uriFrom } from '../../test/vscodeMock';

interface InputBoxOptionsDoubleOfJustPromptAndValidateInput {
  prompt?: string;
  value?: string;
  placeHolder?: string;
  validateInput?: (value: string) => Thenable<string | undefined> | string | undefined;
}

const { registerCommand, executeCommand, showOpenDialog, showInputBox, createQuickPick, openExternal } = vi.hoisted(() => ({
  registerCommand: vi.fn((_id: string, handler: (...args: unknown[]) => unknown) => ({ dispose: vi.fn(), handler })),
  executeCommand: vi.fn((_command: string, _uri?: { fsPath: string }) => Promise.resolve()),
  showOpenDialog: vi.fn(),
  showInputBox: vi.fn<(options?: InputBoxOptionsDoubleOfJustPromptAndValidateInput) => Promise<string | undefined>>(),
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
    Uri: { file: uriFile, from: uriFrom, parse: (s: string) => ({ toString: () => s }) },
  };
});

import { progressSteps } from '../../test/recordedProgress';
import { quickPickChoosing } from '../../drivingLib/test/quickPickDouble';

const commands = {
  uninstallMods: vi.fn(), deleteSeparators: vi.fn(), renameMod: vi.fn(), renameSeparator: vi.fn(), insertSeparator: vi.fn(),
  createEmptyMod: vi.fn(), setModsEnabled: vi.fn(), moveMods: vi.fn(), moveSeparators: vi.fn(), markFiles: vi.fn(),
  changePublisherTag: vi.fn(),
  newModNameRefusal: vi.fn(), separatorNameRefusal: vi.fn(), renameModNameRefusal: vi.fn(), installMod: vi.fn(), upgradeLoss: vi.fn(),
  names: { manager: 'MO2', modOrderFile: 'modlist.txt', downloadedFileMetadataFile: '.meta' },
} satisfies Record<keyof ModCommands, unknown>;
const {
  uninstallMods, deleteSeparators, renameMod, renameSeparator, insertSeparator, createEmptyMod, setModsEnabled, moveMods, moveSeparators, markFiles,
  newModNameRefusal, separatorNameRefusal, renameModNameRefusal,
} = commands;

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
import { recordingReporter, scriptedDialog, assertAskedOnce } from '../../test/surfacingDoubles';
import { present } from '../../ports/present';
import { instanceValueFixture } from '../../test/mo2/instanceValueFixture';
import type { ModCommands } from '../../modCommands/modCommands';

function invoke(commandId: string, ...args: unknown[]): Promise<unknown> {
  const call = registerCommand.mock.calls.find((c) => c[0] === commandId);
  if (!call) throw new Error(`command not registered: ${commandId}`);
  return Promise.resolve(call[1](...args));
}

const instanceThatReads = {
  refresh: () => { progressSteps.push('Instance loader: read every file again'); return Promise.resolve(); },
};

describe('modbench.mod.createEmpty: the prompt refuses in install\'s own words', () => {
  beforeEach(() => { vi.clearAllMocks(); progressSteps.length = 0; });

  const instance = { ...instanceThatReads, value: instanceValueFixture({ activeProfile: 'Default', mods: [{ kind: 'mod', name: 'Existing Mod', enabled: true }] }) };

  it('Esc creates nothing', async () => {
    showInputBox.mockResolvedValueOnce(undefined);
    const reporter = recordingReporter();

    registerCreateEmptyModCommand(commands, instance, reporter);
    await invoke('modbench.mod.createEmpty');

    expect(createEmptyMod).not.toHaveBeenCalled();
    expect(reporter.reports).toEqual([]);
  });

  it('the prompt\'s validateInput asks the command whether the name is free', async () => {
    newModNameRefusal.mockResolvedValueOnce('"Harder VATS" already exists');
    registerCreateEmptyModCommand(commands, instance, recordingReporter());
    await invoke('modbench.mod.createEmpty');

    const [options] = present(showInputBox.mock.calls[0], 'the one showInputBox call');
    const validateInput = present(options?.validateInput, 'validateInput on the input box options');
    expect(await validateInput('Harder VATS')).toBe('"Harder VATS" already exists');
    expect(newModNameRefusal).toHaveBeenCalledWith('Harder VATS');
  });

  it('creates the folder and its line, and reports nothing when both land', async () => {
    showInputBox.mockResolvedValueOnce('New Mod');
    createEmptyMod.mockResolvedValueOnce({ applied: true, wrote: true });
    const reporter = recordingReporter();

    registerCreateEmptyModCommand(commands, instance, reporter);
    await invoke('modbench.mod.createEmpty');

    expect(createEmptyMod).toHaveBeenCalledWith('New Mod');
    expect(reporter.reports).toEqual([]);
  });

  it('reports a landed-but-partial line failure as a warning, not a failed create', async () => {
    showInputBox.mockResolvedValueOnce('New Mod');
    createEmptyMod.mockResolvedValueOnce({ applied: true, wrote: false, lineRefusal: 'disk full' });
    const reporter = recordingReporter();

    registerCreateEmptyModCommand(commands, instance, reporter);
    await invoke('modbench.mod.createEmpty');

    expect(reporter.reports).toEqual([{
      severity: 'warning',
      message: '"New Mod" was created, but its modlist.txt line could not be written.',
      detail: 'disk full',
    }]);
  });

  it('names the file mod order is kept in as the value names it, not MO2\'s modlist.txt over another manager\'s', async () => {
    showInputBox.mockResolvedValueOnce('New Mod');
    createEmptyMod.mockResolvedValueOnce({ applied: true, wrote: false, lineRefusal: 'disk full' });
    const reporter = recordingReporter();
    const another = { ...commands, names: { manager: 'Another Manager', modOrderFile: 'order.txt', downloadedFileMetadataFile: 'order.metadata' } };

    registerCreateEmptyModCommand(another, instance, reporter);
    await invoke('modbench.mod.createEmpty');

    expect(reporter.reports.map((r) => r.message)).toEqual(['"New Mod" was created, but its order.txt line could not be written.']);
  });

  it('reports a name-collision refusal as a failed create', async () => {
    showInputBox.mockResolvedValueOnce('New Mod');
    createEmptyMod.mockResolvedValueOnce({ applied: false, refusal: 'A mod named "New Mod" already exists.' });
    const reporter = recordingReporter();

    registerCreateEmptyModCommand(commands, instance, reporter);
    await invoke('modbench.mod.createEmpty');

    expect(reporter.reports).toEqual([{
      severity: 'error',
      message: 'Failed to create "New Mod".',
      detail: 'A mod named "New Mod" already exists.',
    }]);
  });
});

describe('registerModContextCommands: modbench.mod.rename', () => {
  beforeEach(() => { vi.clearAllMocks(); progressSteps.length = 0; });

  const instance = {
    ...instanceThatReads,
    value: instanceValueFixture({
      activeProfile: 'Default',
      profiles: ['Default', 'Secondary'],
      mods: [{ kind: 'mod', name: 'Mod A', enabled: true }, { kind: 'mod', name: 'Mod B', enabled: true }],
    }),
  };
  const modA = new ModNode({ kind: 'mod', name: 'Mod A', enabled: true });
  const modB = new ModNode({ kind: 'mod', name: 'Mod B', enabled: true });
  const register = (reporter = recordingReporter(), selection: readonly ModlistNode[] = []) =>
    registerModContextCommands({ commands, instance, viewSelection: () => selection, reporter, ask: scriptedDialog(), trash: vi.fn(), log: vi.fn() });

  it('prompts with the right-clicked mod\'s name and renames it in every profile', async () => {
    renameMod.mockResolvedValue({ applied: true, lineRefusals: [] });
    showInputBox.mockResolvedValueOnce('Renamed');
    const reporter = recordingReporter();

    register(reporter);
    await invoke('modbench.mod.rename', modB, [modA, modB]);

    expect(showInputBox.mock.calls[0]?.[0]).toMatchObject({ prompt: 'Rename mod', value: 'Mod B' });
    expect(renameMod.mock.calls).toEqual([['Mod B', 'Renamed']]);
    expect(reporter.reports).toEqual([]);
  });

  it.each([['Esc', undefined], ['an empty name', ''], ['the same name', 'Mod A']])('renames nothing on %s', async (_, answer) => {
    showInputBox.mockResolvedValueOnce(answer);

    register();
    await invoke('modbench.mod.rename', modA);

    expect(renameMod).not.toHaveBeenCalled();
  });

  it('renames the one selected mod from F2', async () => {
    renameMod.mockResolvedValue({ applied: true, lineRefusals: [] });
    showInputBox.mockResolvedValueOnce('Renamed');

    register(recordingReporter(), [modA]);
    await invoke('modbench.mod.rename', MODS_KEY_ARGS);

    expect(renameMod).toHaveBeenCalledWith('Mod A', 'Renamed');
  });

  it('reports a refusal, the folder not having moved, as a failed rename', async () => {
    renameMod.mockResolvedValue({ applied: false, refusal: 'is in the way' });
    showInputBox.mockResolvedValueOnce('Renamed');
    const reporter = recordingReporter();

    register(reporter);
    await invoke('modbench.mod.rename', modA);

    expect(reporter.reports).toEqual([{ severity: 'error', message: 'Failed to rename mod.', detail: 'is in the way' }]);
  });

  it('warns once for each profile whose line could not be renamed, naming it and the mod order file', async () => {
    renameMod.mockResolvedValue({
      applied: true, lineRefusals: [{ profile: 'Default', refusal: 'disk full' }, { profile: 'Secondary', refusal: 'locked' }],
    });
    showInputBox.mockResolvedValueOnce('Renamed');
    const reporter = recordingReporter();

    register(reporter);
    await invoke('modbench.mod.rename', modA);

    expect(reporter.reports).toEqual([
      { severity: 'warning', message: '"Mod A" was renamed, but its modlist.txt line in profile "Default" could not be renamed.', detail: 'disk full' },
      { severity: 'warning', message: '"Mod A" was renamed, but its modlist.txt line in profile "Secondary" could not be renamed.', detail: 'locked' },
    ]);
  });
});

describe('registerModContextCommands: modbench.mod.uninstall over the selection', () => {
  beforeEach(() => { vi.clearAllMocks(); progressSteps.length = 0; });

  const instance = {
    ...instanceThatReads,
    value: instanceValueFixture({
      activeProfile: 'Default',
          }),
  };
  const trash = vi.fn(() => Promise.resolve());
  const log = vi.fn();
  const modA = new ModNode({ kind: 'mod', name: 'Mod A', enabled: true, installationFileName: 'mod-a.7z' });
  const modB = new ModNode({ kind: 'mod', name: 'Mod B', enabled: true });

  it('asks one modal naming the mod, then uninstalls it once confirmed', async () => {
    uninstallMods.mockResolvedValueOnce({ applied: true, outcome: { landed: [{ name: 'Mod A' }], refused: [] } });
    const ask = scriptedDialog('Uninstall');

    registerModContextCommands({ commands, instance, viewSelection: () => [], reporter: recordingReporter(), ask, trash, log });
    await invoke('modbench.mod.uninstall', modA);

    expect(ask.asked).toEqual([{
      message: 'Uninstall "Mod A"? Its folder will be moved to the system trash.',
      detail: undefined,
      buttons: ['Uninstall'],
    }]);
    expect(uninstallMods).toHaveBeenCalledWith(
      ['Mod A'], trash);
  });

  const facts = { holdsPlugin: true, sourceMod: true };

  it('warns, naming the source, of a mod uninstalled whose source could not be trashed, and does not report the uninstall failed', async () => {
    uninstallMods.mockResolvedValueOnce({
      applied: true, outcome: { landed: [{ name: 'Mod A', sourceRefusal: 'the trash refused it' }], refused: [] },
    });
    const reporter = recordingReporter();

    registerModContextCommands({ commands, instance, viewSelection: () => [], reporter, ask: scriptedDialog('Uninstall'), trash, log });
    await invoke('modbench.mod.uninstall', modA);

    expect(reporter.reports).toEqual([
      { severity: 'warning', message: '"Mod A" was uninstalled, but its source folder could not be moved to the trash.', detail: 'the trash refused it' },
    ]);
  });

  it('says the source goes to the trash with the folder of a source mod', async () => {
    uninstallMods.mockResolvedValueOnce({ applied: true, outcome: { landed: [{ name: 'Mod A' }], refused: [] } });
    const ask = scriptedDialog('Uninstall');

    registerModContextCommands({ commands, instance, viewSelection: () => [], reporter: recordingReporter(), ask, trash, log });
    await invoke('modbench.mod.uninstall', new ModNode(modA.mod, facts));

    expect(ask.asked[0]?.message).toBe('Uninstall "Mod A"? Its folder and its source will be moved to the system trash.');
  });

  it('names the source mods whose source goes with the folders, for a selection of several', async () => {
    uninstallMods.mockResolvedValueOnce({
      applied: true, outcome: { landed: [{ name: 'Mod A' }, { name: 'Mod B' }], refused: [] },
    });
    const ask = scriptedDialog('Uninstall');

    registerModContextCommands({ commands, instance, viewSelection: () => [], reporter: recordingReporter(), ask, trash, log });
    const sourceA = new ModNode(modA.mod, facts);
    await invoke('modbench.mod.uninstall', sourceA, [sourceA, modB]);

    expect(ask.asked[0]?.message).toBe(
      'Uninstall "Mod A", "Mod B"? Their folders will be moved to the system trash, and the source of "Mod A" with them.');
  });

  it('asks one modal listing every mod, for a selection of several', async () => {
    uninstallMods.mockResolvedValueOnce({
      applied: true, outcome: { landed: [{ name: 'Mod A' }, { name: 'Mod B' }], refused: [] },
    });
    const ask = scriptedDialog('Uninstall');

    registerModContextCommands({ commands, instance, viewSelection: () => [], reporter: recordingReporter(), ask, trash, log });
    await invoke('modbench.mod.uninstall', modA, [modA, modB]);

    assertAskedOnce(ask, { messageContains: '"Mod A", "Mod B"', buttons: ['Uninstall'] });
    expect(ask.asked[0]?.message).toContain('Their folders will be moved to the system trash.');
    expect(uninstallMods).toHaveBeenCalledWith(
      ['Mod A', 'Mod B'],
      trash,
    );
  });

  it('uninstalls nothing when the modal is dismissed', async () => {
    uninstallMods.mockResolvedValue({ applied: true, outcome: { landed: [], refused: [] } });

    registerModContextCommands({ commands, instance, viewSelection: () => [], reporter: recordingReporter(), ask: scriptedDialog(undefined), trash, log });
    await invoke('modbench.mod.uninstall', modA);

    expect(uninstallMods).not.toHaveBeenCalled();
  });

  it('says nothing extra for a fully landed uninstall with no failed mark', async () => {
    uninstallMods.mockResolvedValueOnce({ applied: true, outcome: { landed: [{ name: 'Mod A' }], refused: [] } });
    const reporter = recordingReporter();

    registerModContextCommands({ commands, instance, viewSelection: () => [], reporter, ask: scriptedDialog('Uninstall'), trash, log });
    await invoke('modbench.mod.uninstall', modA);

    expect(reporter.reports).toEqual([]);
    expect(log).not.toHaveBeenCalled();
  });

  it('a failed mark is one Output line and no notification; the uninstall it rides on stands landed', async () => {
    uninstallMods.mockResolvedValueOnce({
      applied: true,
      outcome: { landed: [{ name: 'Mod A', markRefusal: 'disk full' }], refused: [] },
    });
    const reporter = recordingReporter();

    registerModContextCommands({ commands, instance, viewSelection: () => [], reporter, ask: scriptedDialog('Uninstall'), trash, log });
    await invoke('modbench.mod.uninstall', modA);

    expect(reporter.reports).toEqual([]);
    expect(log).toHaveBeenCalledWith(
      '"Mod A" was uninstalled, but its downloaded file could not be marked uninstalled: disk full');
  });

  it('a post-trash line failure is a warning notification naming the part that failed, not a failed uninstall', async () => {
    uninstallMods.mockResolvedValueOnce({
      applied: true,
      outcome: { landed: [{ name: 'Mod A', lineRefusal: 'disk full' }], refused: [] },
    });
    const reporter = recordingReporter();

    registerModContextCommands({ commands, instance, viewSelection: () => [], reporter, ask: scriptedDialog('Uninstall'), trash, log });
    await invoke('modbench.mod.uninstall', modA);

    expect(reporter.reports).toEqual([{
      severity: 'warning',
      message: '"Mod A" was uninstalled, but its modlist.txt line could not be removed.',
      detail: 'disk full',
    }]);
    expect(log).not.toHaveBeenCalled();
  });
});

describe('modbench.separator.delete: the whole selection of separators, asked once', () => {
  beforeEach(() => { vi.clearAllMocks(); progressSteps.length = 0; });

  const instance = { ...instanceThatReads, value: instanceValueFixture({ activeProfile: 'Default' }) };
  const trash = vi.fn(() => Promise.resolve());
  const groupA = new SeparatorNode({ kind: 'separator', name: 'Group A', enabled: true }, []);
  const groupB = new SeparatorNode({ kind: 'separator', name: 'Group B', enabled: true }, []);
  const modA = new ModNode({ kind: 'mod', name: 'Mod A', enabled: true });

  it('deletes every selected separator in one command, handing it the trash, and says nothing when all land', async () => {
    deleteSeparators.mockResolvedValue({
      applied: true, outcome: { landed: [{ name: 'Group A' }, { name: 'Group B' }], refused: [] },
    });
    const reporter = recordingReporter();

    registerSeparatorCommands(commands, instance, reporter, scriptedDialog('Delete'), trash, () => []);
    await invoke('modbench.separator.delete', groupB, [groupA, groupB]);

    expect(deleteSeparators.mock.calls).toEqual([[['Group A', 'Group B'], trash]]);
    expect(reporter.reports).toEqual([]);
  });

  it('asks one modal naming the separator and saying its mods stay', async () => {
    deleteSeparators.mockResolvedValue({ applied: true, outcome: { landed: [{ name: 'Group A' }], refused: [] } });
    const ask = scriptedDialog('Delete');

    registerSeparatorCommands(commands, instance, recordingReporter(), ask, trash, () => []);
    await invoke('modbench.separator.delete', groupA);

    expect(ask.asked).toEqual([{ message: 'Delete separator "Group A"? Its mods stay.', detail: undefined, buttons: ['Delete'] }]);
  });

  it('asks one modal listing every separator of a selection of several', async () => {
    deleteSeparators.mockResolvedValue({
      applied: true, outcome: { landed: [{ name: 'Group A' }, { name: 'Group B' }], refused: [] },
    });
    const ask = scriptedDialog('Delete');

    registerSeparatorCommands(commands, instance, recordingReporter(), ask, trash, () => []);
    await invoke('modbench.separator.delete', groupA, [groupA, groupB]);

    assertAskedOnce(ask, { messageContains: '"Group A", "Group B"', buttons: ['Delete'] });
    expect(ask.asked[0]?.message).toContain('Their mods stay.');
  });

  it('a cancelled question writes nothing', async () => {
    const ask = scriptedDialog(undefined);

    registerSeparatorCommands(commands, instance, recordingReporter(), ask, trash, () => []);
    await invoke('modbench.separator.delete', groupA, [groupA, groupB]);

    expect(deleteSeparators).not.toHaveBeenCalled();
  });

  it('takes only the separators of a selection mixing mods and separators', async () => {
    deleteSeparators.mockResolvedValue({ applied: true, outcome: { landed: [{ name: 'Group A' }], refused: [] } });

    registerSeparatorCommands(commands, instance, recordingReporter(), scriptedDialog('Delete'), trash, () => []);
    await invoke('modbench.separator.delete', groupA, [modA, groupA]);

    expect(deleteSeparators.mock.calls).toEqual([[['Group A'], trash]]);
  });

  it('calls nothing and reports nothing for a selection with no separator', async () => {
    const reporter = recordingReporter();

    registerSeparatorCommands(commands, instance, reporter, scriptedDialog('Delete'), trash, () => [modA]);
    await invoke('modbench.separator.delete');

    expect(deleteSeparators).not.toHaveBeenCalled();
    expect(reporter.reports).toEqual([]);
  });

  it('a post-trash line failure is a warning notification naming the part that failed, not a failed delete', async () => {
    deleteSeparators.mockResolvedValue({
      applied: true, outcome: { landed: [{ name: 'Group A', lineRefusal: 'disk full' }], refused: [] },
    });
    const reporter = recordingReporter();

    registerSeparatorCommands(commands, instance, reporter, scriptedDialog('Delete'), trash, () => []);
    await invoke('modbench.separator.delete', groupA);

    expect(reporter.reports).toEqual([{
      severity: 'warning',
      message: '"Group A" was deleted, but its modlist.txt line could not be removed.',
      detail: 'disk full',
    }]);
  });
});

const CLASH = 'A separator with this name already exists';

function optionsOfTheOneShowInputBoxCall(): InputBoxOptionsDoubleOfJustPromptAndValidateInput {
  const [call] = showInputBox.mock.calls;
  return present(call?.[0], 'the options of the one prompt the gesture opened');
}

describe('rename separator takes its separator through the gesture entry', () => {
  beforeEach(() => { vi.clearAllMocks(); progressSteps.length = 0; });

  const instance = {
    ...instanceThatReads,
    value: instanceValueFixture({
      activeProfile: 'Default',
      mods: [
        { kind: 'separator', name: 'Group A', enabled: true },
        { kind: 'mod', name: 'Mod A', enabled: true },
        { kind: 'separator', name: 'Group B', enabled: true },
      ],
    }),
  };
  const groupA = new SeparatorNode({ kind: 'separator', name: 'Group A', enabled: true }, []);
  const groupB = new SeparatorNode({ kind: 'separator', name: 'Group B', enabled: true }, []);

  it('prompts with the right-clicked separator\'s name and renames it, not the selection around it', async () => {
    renameSeparator.mockResolvedValue({ applied: true, wrote: true });
    showInputBox.mockResolvedValueOnce('Renamed');

    registerSeparatorCommands(commands, instance, recordingReporter(), scriptedDialog(), vi.fn(), () => [groupA, groupB]);
    await invoke('modbench.separator.rename', groupB, [groupA, groupB]);

    expect(optionsOfTheOneShowInputBoxCall()).toMatchObject({ prompt: 'Rename separator', value: 'Group B' });
    expect(renameSeparator.mock.calls).toEqual([['Group B', 'Renamed']]);
  });

  it('asks the command in the prompt whether the name is free of the other separators, passing the separator\'s own name, and asks nothing of an empty name', async () => {
    showInputBox.mockResolvedValueOnce(undefined);
    separatorNameRefusal.mockResolvedValueOnce(CLASH);

    registerSeparatorCommands(commands, instance, recordingReporter(), scriptedDialog(), vi.fn(), () => []);
    await invoke('modbench.separator.rename', groupB);

    const validate = present(optionsOfTheOneShowInputBoxCall().validateInput, 'the rename prompt\'s validateInput');
    expect(await validate('group a')).toBe(CLASH);
    expect(separatorNameRefusal).toHaveBeenCalledWith('group a', 'Group B');
    expect(await validate('')).toBeUndefined();
    expect(separatorNameRefusal).toHaveBeenCalledTimes(1);
  });

  it('reports the refusal of a name another separator took after the prompt closed', async () => {
    renameSeparator.mockResolvedValue({ applied: false, refusal: CLASH });
    showInputBox.mockResolvedValueOnce('Taken Meanwhile');
    const reporter = recordingReporter();

    registerSeparatorCommands(commands, instance, reporter, scriptedDialog(), vi.fn(), () => []);
    await invoke('modbench.separator.rename', groupB);

    expect(reporter.reports).toEqual([{ severity: 'error', message: 'Failed to rename separator.', detail: CLASH }]);
  });

  it('renames nothing when the prompt is cancelled (Esc) or left empty', async () => {
    showInputBox.mockResolvedValueOnce(undefined).mockResolvedValueOnce('');

    registerSeparatorCommands(commands, instance, recordingReporter(), scriptedDialog(), vi.fn(), () => []);
    await invoke('modbench.separator.rename', groupA);
    await invoke('modbench.separator.rename', groupA);

    expect(renameSeparator).not.toHaveBeenCalled();
  });

  it('renames nothing when the prompt keeps the same name', async () => {
    showInputBox.mockResolvedValueOnce('Group A');

    registerSeparatorCommands(commands, instance, recordingReporter(), scriptedDialog(), vi.fn(), () => [groupA]);
    await invoke('modbench.separator.rename', groupA);

    expect(renameSeparator).not.toHaveBeenCalled();
  });

  it('renames the one selected separator from F2', async () => {
    renameSeparator.mockResolvedValue({ applied: true, wrote: true });
    showInputBox.mockResolvedValueOnce('Renamed');

    registerSeparatorCommands(commands, instance, recordingReporter(), scriptedDialog(), vi.fn(), () => [groupB]);
    await invoke('modbench.separator.rename', MODS_KEY_ARGS);

    expect(optionsOfTheOneShowInputBoxCall()).toMatchObject({ value: 'Group B' });
    expect(renameSeparator.mock.calls).toEqual([['Group B', 'Renamed']]);
  });
});

describe('add separator: one command for a mod anchor and a separator anchor', () => {
  beforeEach(() => { vi.clearAllMocks(); progressSteps.length = 0; });

  const instance = {
    ...instanceThatReads,
    value: instanceValueFixture({
      activeProfile: 'Default',
      mods: [{ kind: 'mod', name: 'Mod A', enabled: true }, { kind: 'separator', name: 'Group A', enabled: true }],
    }),
  };
  const modA = new ModNode({ kind: 'mod', name: 'Mod A', enabled: true });
  const groupA = new SeparatorNode({ kind: 'separator', name: 'Group A', enabled: true }, []);

  it('prompts and anchors the new separator on the right-clicked mod, not the selection around it', async () => {
    insertSeparator.mockResolvedValue({ applied: true, wrote: true });
    showInputBox.mockResolvedValueOnce('New Section');
    const otherMod = new ModNode({ kind: 'mod', name: 'Other Mod', enabled: true });

    registerSeparatorCommands(commands, instance, recordingReporter(), scriptedDialog(), vi.fn(), () => [otherMod, modA]);
    await invoke('modbench.separator.add', modA, [otherMod, modA]);

    expect(optionsOfTheOneShowInputBoxCall()).toMatchObject({ prompt: 'Separator name', placeHolder: 'My Group' });
    expect(insertSeparator.mock.calls).toEqual([['New Section', { kind: 'mod', name: 'Mod A' }]]);
  });

  it('asks the command in the prompt whether the name is free of the other separators, and asks nothing of an empty name', async () => {
    showInputBox.mockResolvedValueOnce(undefined);
    separatorNameRefusal.mockResolvedValueOnce(CLASH);

    registerSeparatorCommands(commands, instance, recordingReporter(), scriptedDialog(), vi.fn(), () => []);
    await invoke('modbench.separator.add', modA);

    const validate = present(optionsOfTheOneShowInputBoxCall().validateInput, 'the add prompt\'s validateInput');
    expect(await validate('Group A')).toBe(CLASH);
    expect(separatorNameRefusal).toHaveBeenCalledWith('Group A', undefined);
    expect(await validate('')).toBeUndefined();
    expect(separatorNameRefusal).toHaveBeenCalledTimes(1);
  });

  it('reports the refusal of a name another separator took after the prompt closed', async () => {
    insertSeparator.mockResolvedValue({ applied: false, refusal: CLASH });
    showInputBox.mockResolvedValueOnce('Taken Meanwhile');
    const reporter = recordingReporter();

    registerSeparatorCommands(commands, instance, reporter, scriptedDialog(), vi.fn(), () => []);
    await invoke('modbench.separator.add', modA);

    expect(reporter.reports).toEqual([{ severity: 'error', message: 'Failed to add separator.', detail: CLASH }]);
  });

  it('prompts and anchors the new separator on the right-clicked separator, not the selection around it', async () => {
    insertSeparator.mockResolvedValue({ applied: true, wrote: true });
    showInputBox.mockResolvedValueOnce('New Section');
    const otherGroup = new SeparatorNode({ kind: 'separator', name: 'Other Group', enabled: true }, []);

    registerSeparatorCommands(commands, instance, recordingReporter(), scriptedDialog(), vi.fn(), () => [otherGroup, groupA]);
    await invoke('modbench.separator.add', groupA, [otherGroup, groupA]);

    expect(insertSeparator.mock.calls).toEqual([['New Section', { kind: 'separator', name: 'Group A' }]]);
  });

  it('adds nothing when the prompt is cancelled (Esc)', async () => {
    showInputBox.mockResolvedValueOnce(undefined);

    registerSeparatorCommands(commands, instance, recordingReporter(), scriptedDialog(), vi.fn(), () => [modA]);
    await invoke('modbench.separator.add', modA);

    expect(insertSeparator).not.toHaveBeenCalled();
  });

  it('adds nothing for an empty name', async () => {
    showInputBox.mockResolvedValueOnce('');

    registerSeparatorCommands(commands, instance, recordingReporter(), scriptedDialog(), vi.fn(), () => [modA]);
    await invoke('modbench.separator.add', modA);

    expect(insertSeparator).not.toHaveBeenCalled();
  });

});

describe('modbench.mod.enable / modbench.mod.disable: the whole selection, one command per direction', () => {
  beforeEach(() => { vi.clearAllMocks(); progressSteps.length = 0; });

  const instance = { ...instanceThatReads, value: instanceValueFixture({ activeProfile: 'Default' }) };
  const modA = new ModNode({ kind: 'mod', name: 'Mod A', enabled: false });
  const modB = new ModNode({ kind: 'mod', name: 'Mod B', enabled: true });

  it('enable applies to every selected mod, whatever its own current state', async () => {
    setModsEnabled.mockResolvedValue({ applied: true, outcome: { landed: ['Mod A', 'Mod B'], refused: [] } });

    registerModEnableCommands(commands, instance, () => [], recordingReporter());
    await invoke('modbench.mod.enable', modA, [modA, modB]);

    expect(setModsEnabled).toHaveBeenCalledWith(['Mod A', 'Mod B'], true);
  });

  it('disable applies to every selected mod, whatever its own current state', async () => {
    setModsEnabled.mockResolvedValue({ applied: true, outcome: { landed: ['Mod A', 'Mod B'], refused: [] } });

    registerModEnableCommands(commands, instance, () => [], recordingReporter());
    await invoke('modbench.mod.disable', modB, [modA, modB]);

    expect(setModsEnabled).toHaveBeenCalledWith(['Mod A', 'Mod B'], false);
  });

  it('says nothing when the whole selection lands', async () => {
    setModsEnabled.mockResolvedValue({ applied: true, outcome: { landed: ['Mod A'], refused: [] } });
    const reporter = recordingReporter();

    registerModEnableCommands(commands, instance, () => [], reporter);
    await invoke('modbench.mod.enable', modA);

    expect(reporter.reports).toEqual([]);
  });
});

describe('modbench.mod.enable / modbench.mod.disable, called by the agent', () => {
  beforeEach(() => { vi.clearAllMocks(); progressSteps.length = 0; });

  const instance = { ...instanceThatReads, value: instanceValueFixture({ activeProfile: 'Default' }) };
  const selected = new ModNode({ kind: 'mod', name: 'Selected Mod', enabled: false });
  const outcome = { applied: true, outcome: { landed: ['Mod B'], refused: [{ item: 'Gone', reason: 'Mod not found in modlist: Gone' }] } };

  it.each([
    ['modbench.mod.enable', true],
    ['modbench.mod.disable', false],
  ])('%s acts on the mods given, never on the selection, and answers the outcome, reporting nothing', async (command, enabled) => {
    setModsEnabled.mockResolvedValue(outcome);
    const reporter = recordingReporter();
    registerModEnableCommands(commands, instance, () => [selected], reporter);

    const answered = await invoke(command, new AgentCall([{ kind: 'mod', name: 'Mod B' }, { kind: 'mod', name: 'Gone' }], {}));

    expect(setModsEnabled).toHaveBeenCalledWith(['Mod B', 'Gone'], enabled);
    expect(answered).toEqual(outcome);
    expect(reporter.reports).toEqual([]);
  });

  it('answers once the instance has been read again, so the agent\'s next read sees the change', async () => {
    setModsEnabled.mockImplementation(() => { progressSteps.push('modlist.txt written'); return Promise.resolve(outcome); });
    registerModEnableCommands(commands, instance, () => [], recordingReporter());

    await invoke('modbench.mod.enable', new AgentCall([{ kind: 'mod', name: 'Mod B' }], {}));

    expect(progressSteps).toEqual([
      'progress opens on modbench.modList', 'modlist.txt written', 'Instance loader: read every file again', 'progress closes',
    ]);
  });
});

describe('modbench.mod.move: the selection of mods or of separators, to a picked place', () => {
  beforeEach(() => { vi.clearAllMocks(); progressSteps.length = 0; shown = undefined; });

  const instance = {
    ...instanceThatReads,
    value: instanceValueFixture({
      activeProfile: 'Default',
      mods: [
        { kind: 'mod', name: 'Mod A', enabled: true },
        { kind: 'separator', name: 'Group A', enabled: true },
        { kind: 'mod', name: 'Mod B', enabled: true },
        { kind: 'separator', name: 'Group B', enabled: true },
        { kind: 'mod', name: 'Mod C', enabled: true },
      ],
    }),
  };
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
    moveMods.mockResolvedValue({ applied: true, outcome: { landed: ['Mod A', 'Mod C'], refused: [] } });

    registerModMoveCommand(commands, instance, losingAtTop, recordingReporter());
    await invoke('modbench.mod.move', modA, [modA, groupB, modC]);

    expect(pickedLabels()).toEqual(['Ungrouped', 'Group B', 'Group A']);
    expect(moveMods).toHaveBeenCalledWith(
      ['Mod A', 'Mod C'], { kind: 'separator', name: 'Group B' }, 'losing');
    expect(moveSeparators).not.toHaveBeenCalled();
  });

  it('right-clicked on a separator in a mixed selection, moves only the separators above the picked one', async () => {
    pickLabelled('Group A');
    moveSeparators.mockResolvedValue({ applied: true, outcome: { landed: ['Group B'], refused: [] } });

    registerModMoveCommand(commands, instance, losingAtTop, recordingReporter());
    await invoke('modbench.mod.move', groupB, [modA, groupB]);

    expect(pickedLabels()).toEqual(['Group A']);
    expect(moveSeparators).toHaveBeenCalledWith(['Group B'], { kind: 'separator', name: 'Group A' }, 'losing');
    expect(moveMods).not.toHaveBeenCalled();
  });

  it('with winning at the top, lands mods and separators toward the winning end, as the view shows it', async () => {
    const winningAtTop = { selection: () => [], direction: () => 'winningAtTop' as const };
    moveMods.mockResolvedValue({ applied: true, outcome: { landed: ['Mod C'], refused: [] } });
    moveSeparators.mockResolvedValue({ applied: true, outcome: { landed: ['Group B'], refused: [] } });

    registerModMoveCommand(commands, instance, winningAtTop, recordingReporter());
    pickLabelled('Group A');
    await invoke('modbench.mod.move', modC);
    pickLabelled('Group A');
    await invoke('modbench.mod.move', groupB);

    expect(moveMods).toHaveBeenCalledWith(['Mod C'], { kind: 'separator', name: 'Group A' }, 'winning');
    expect(moveSeparators).toHaveBeenCalledWith(['Group B'], { kind: 'separator', name: 'Group A' }, 'winning');
  });

  it('handed a target, as a drop hands one, moves there without a pick', async () => {
    moveMods.mockResolvedValue({ applied: true, outcome: { landed: ['Mod C'], refused: [] } });
    moveSeparators.mockResolvedValue({ applied: true, outcome: { landed: ['Group B'], refused: [] } });

    registerModMoveCommand(commands, instance, losingAtTop, recordingReporter());
    await invoke('modbench.mod.move', modC, [modC], { place: { kind: 'mod', name: 'Mod A' }, end: 'winning' });
    await invoke('modbench.mod.move', groupB, [groupB], { place: { kind: 'modOrder' }, end: 'winning' });

    expect(createQuickPick).not.toHaveBeenCalled();
    expect(moveMods).toHaveBeenCalledWith(['Mod C'], { kind: 'mod', name: 'Mod A' }, 'winning');
    expect(moveSeparators).toHaveBeenCalledWith(['Group B'], { kind: 'modOrder' }, 'winning');
  });

  it('offers the places in the order the view shows them', async () => {
    escapeAtPick();

    registerModMoveCommand(
      commands, instance, { selection: () => [], direction: () => 'winningAtTop' }, recordingReporter());
    await invoke('modbench.mod.move', modC);

    expect(pickedLabels()).toEqual(['Ungrouped', 'Group A', 'Group B']);
  });

  it('opens the mods pick on the place that holds the selected mods', async () => {
    escapeAtPick();

    registerModMoveCommand(commands, instance, losingAtTop, recordingReporter());
    await invoke('modbench.mod.move', modC);

    const { items, activeItems } = shownPick();
    expect(activeItems).toEqual([items.find((i) => i.description === 'current')]);
    expect(activeItems.map((i) => i.label)).toEqual(['Ungrouped']);
  });

  it('with the selected mods in several places, marks each and opens on none', async () => {
    escapeAtPick();

    registerModMoveCommand(commands, instance, losingAtTop, recordingReporter());
    await invoke('modbench.mod.move', modA, [modA, modC]);

    const { items, activeItems } = shownPick();
    expect(items.filter((i) => i.description === 'current').length).toBeGreaterThan(1);
    expect(activeItems).toEqual([]);
  });

  it('opens the separators pick on no item', async () => {
    escapeAtPick();

    registerModMoveCommand(commands, instance, losingAtTop, recordingReporter());
    await invoke('modbench.mod.move', groupB);

    expect(shownPick().activeItems).toEqual([]);
  });

  it('from the palette over a selection mixing mods and separators, moves nothing and says nothing', async () => {
    const reporter = recordingReporter();

    registerModMoveCommand(commands, instance, { ...losingAtTop, selection: () => [modA, groupA] }, reporter);
    await invoke('modbench.mod.move');

    expect(createQuickPick).not.toHaveBeenCalled();
    expect(moveMods).not.toHaveBeenCalled();
    expect(moveSeparators).not.toHaveBeenCalled();
    expect(reporter.reports).toEqual([]);
  });

  it('Esc at the pick moves nothing and says nothing', async () => {
    escapeAtPick();
    const reporter = recordingReporter();

    registerModMoveCommand(commands, instance, losingAtTop, reporter);
    await invoke('modbench.mod.move', modA);

    expect(moveMods).not.toHaveBeenCalled();
    expect(reporter.reports).toEqual([]);
  });

  it('Esc at the separator pick moves nothing and says nothing', async () => {
    escapeAtPick();
    const reporter = recordingReporter();

    registerModMoveCommand(commands, instance, losingAtTop, reporter);
    await invoke('modbench.mod.move', groupB);

    expect(createQuickPick).toHaveBeenCalledOnce();
    expect(moveSeparators).not.toHaveBeenCalled();
    expect(reporter.reports).toEqual([]);
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

  it('reveals the clicked mod\'s own folder, as the value names it', async () => {
    registerOpenFolderCommand(instance, recordingReporter(), () => []);
    await invoke('modbench.mod.openFolder', new ModNode({ kind: 'mod', name: 'My Mod', enabled: true }));

    expect(revealed()).toEqual(['/instance/mods/My Mod']);
  });

  it('refuses a mod no folder holds, naming it, rather than returning in silence', async () => {
    const reporter = recordingReporter();

    registerOpenFolderCommand(instance, reporter, () => []);
    await invoke('modbench.mod.openFolder', new ModNode({ kind: 'mod', name: 'Folderless Mod', enabled: true }));

    expect(revealed()).toEqual([]);
    expect(reporter.reports).toEqual([
      { severity: 'error', message: 'Failed to open the folder of "Folderless Mod".', detail: 'No folder holds it.' },
    ]);
  });

  it('refuses the Overwrite row while the value names no folder for it, rather than revealing an empty path', async () => {
    const reporter = recordingReporter();
    const unread = { value: instanceValueFixture({ paths: { ...instance.value.paths, overwriteDir: undefined } }) };

    registerOpenFolderCommand(unread, reporter, () => []);
    await invoke('modbench.mod.openFolder', new OverwriteNode([], 'MO2'));

    expect(revealed()).toEqual([]);
    expect(reporter.reports).toEqual([
      { severity: 'error', message: 'Failed to open the folder of "Overwrite".', detail: 'No folder holds it.' },
    ]);
  });

  it('reveals the overwrite folder from the Overwrite row', async () => {
    registerOpenFolderCommand(instance, recordingReporter(), () => []);
    await invoke('modbench.mod.openFolder', new OverwriteNode([], 'MO2'));

    expect(revealed()).toEqual(['/instance/overwrite']);
  });

  it.each<[string, ModlistNode[]]>([
    ['several rows', [new ModNode({ kind: 'mod', name: 'My Mod', enabled: true }), new OverwriteNode([], 'MO2')]],
    ['a separator', [new SeparatorNode({ kind: 'separator', name: 'Group', enabled: true }, [])]],
  ])('reveals nothing from the palette over a selection of %s', async (_what, selection) => {
    registerOpenFolderCommand(instance, recordingReporter(), () => selection);
    await invoke('modbench.mod.openFolder');

    expect(revealed()).toEqual([]);
  });

  const myMod = new ModNode({ kind: 'mod', name: 'My Mod', enabled: true });
  const linked = { relativePath: 'textures/a.dds', path: '/instance/mods/My Mod/textures/a.dds', sourcePath: '/elsewhere/a.dds', excluded: false, markedExcluded: false, includedPath: 'textures/a.dds' };
  const folder = new FolderNode(myMod, { kind: 'mod', name: 'My Mod' },
    { relativePath: 'textures', path: '/instance/mods/My Mod/textures', excluded: false }, [linked], [], 'textures');
  const leaf = new FileNode(folder, folder.origin, linked, 'a.dds');

  it('reveals a file where it sits in its mod, a link too, clicked or the one selected from the palette', async () => {
    registerOpenFolderCommand(instance, recordingReporter(), () => [leaf]);
    await invoke('modbench.mod.openFolder', leaf);
    await invoke('modbench.mod.openFolder');

    expect(revealed()).toEqual(['/instance/mods/My Mod/textures/a.dds', '/instance/mods/My Mod/textures/a.dds']);
  });

  it('reveals a folder where the value says it sits, clicked or the one selected from the palette', async () => {
    registerOpenFolderCommand(instance, recordingReporter(), () => [folder]);
    await invoke('modbench.mod.openFolder', folder);
    await invoke('modbench.mod.openFolder');

    expect(revealed()).toEqual(['/instance/mods/My Mod/textures', '/instance/mods/My Mod/textures']);
  });

  it('names the file by its path in its mod when its reveal fails', async () => {
    executeCommand.mockRejectedValueOnce(new Error('no explorer'));
    const reporter = recordingReporter();

    registerOpenFolderCommand(instance, reporter, () => []);
    await invoke('modbench.mod.openFolder', leaf);

    expect(reporter.reports).toEqual([
      { severity: 'error', message: 'Failed to open the folder of "textures/a.dds".', detail: 'no explorer' },
    ]);
  });

  it('reports a reveal that fails', async () => {
    executeCommand.mockRejectedValueOnce(new Error('no explorer'));
    const reporter = recordingReporter();

    registerOpenFolderCommand(instance, reporter, () => []);
    await invoke('modbench.mod.openFolder', new ModNode({ kind: 'mod', name: 'My Mod', enabled: true }));

    expect(reporter.reports).toEqual([
      { severity: 'error', message: 'Failed to open the folder of "My Mod".', detail: 'no explorer' },
    ]);
  });
});

describe('view on Nexus: one command for a mod and for a downloaded file', () => {
  beforeEach(() => { vi.clearAllMocks(); progressSteps.length = 0; });

  const instance = { ...instanceThatReads, value: instanceValueFixture({ gameName: 'Skyrim Special Edition' }) };
  const opened = (): string[] => openExternal.mock.calls.map((c) => String(c[0]));
  const downloadedFileRow = (nexusModId?: string): NexusModRow => ({ nexusModId });

  it('opens the mod\'s Nexus page from a mod row', async () => {
    registerViewOnNexusCommand(instance, recordingReporter(), () => undefined);
    await invoke('modbench.mod.viewOnNexus', new ModNode({ kind: 'mod', name: 'My Mod', enabled: true, nexusId: '42' }));

    expect(opened()).toEqual(['https://www.nexusmods.com/skyrimspecialedition/mods/42']);
  });

  it('opens the mod\'s Nexus page from a downloaded file row', async () => {
    registerViewOnNexusCommand(instance, recordingReporter(), () => undefined);
    await invoke('modbench.mod.viewOnNexus', downloadedFileRow('123'));

    expect(opened()).toEqual(['https://www.nexusmods.com/skyrimspecialedition/mods/123']);
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

describe('modsCopyValueText, one line for each selected row copy value takes', () => {
  const alpha = new ModNode({ kind: 'mod', name: 'Alpha', enabled: true });
  const groupA = new SeparatorNode({ kind: 'separator', name: 'Group A', enabled: true }, []);
  const beta = new ModNode({ kind: 'mod', name: 'Beta', enabled: true });
  const groupB = new SeparatorNode({ kind: 'separator', name: 'Group B', enabled: true }, []);
  const noSelection = (): ModlistNode[] => [];

  it('copies a single right-clicked mod\'s own name', () => {
    expect(modsCopyValueText(noSelection)(alpha, undefined)).toBe('Alpha');
  });

  it('copies a single right-clicked separator\'s own name', () => {
    expect(modsCopyValueText(noSelection)(groupA, undefined)).toBe('Group A');
  });

  it('copies every selected mod\'s and separator\'s name, one per line, when the selection mixes kinds', () => {
    const mixed = [alpha, groupA, beta, groupB];
    expect(modsCopyValueText(noSelection)(beta, mixed)).toBe('Alpha\nGroup A\nBeta\nGroup B');
    expect(modsCopyValueText(noSelection)(groupB, mixed)).toBe('Alpha\nGroup A\nBeta\nGroup B');
  });

  it('falls back to just the right-clicked row when nothing else is selected', () => {
    expect(modsCopyValueText(noSelection)(alpha, [])).toBe('Alpha');
  });

  it('excludes the Overwrite row from a selection that includes it', () => {
    const withOverwrite = [alpha, new OverwriteNode([], 'MO2')];
    expect(modsCopyValueText(noSelection)(alpha, withOverwrite)).toBe('Alpha');
  });

  it('is undefined for a row that is not a Mods row, so another surface\'s copy takes over', () => {
    expect(modsCopyValueText(noSelection)(new OverwriteNode([], 'MO2'), undefined)).toBeUndefined();
    expect(modsCopyValueText(noSelection)({ formKey: 'Fallout4.esm:000001' }, undefined)).toBeUndefined();
  });

  it('is undefined with no clicked row, even when the view has a selection', () => {
    const viewSelection = (): ModlistNode[] => [alpha, groupA];
    expect(modsCopyValueText(viewSelection)(undefined, undefined)).toBeUndefined();
  });

  it('copies the view\'s selection for the Mods key\'s own args', () => {
    const viewSelection = (): ModlistNode[] => [alpha, groupA, new OverwriteNode([], 'MO2')];
    expect(modsCopyValueText(viewSelection)(MODS_KEY_ARGS, undefined)).toBe('Alpha\nGroup A');
  });

  it('copies each selected file\'s and folder\'s path in its mod beside the mods\' names, from a click and from the key', () => {
    const armour = new ModNode({ kind: 'mod', name: 'Armour', enabled: true });
    const file = { relativePath: 'textures/armour/a.dds', path: '/instance/mods/Armour/textures/armour/a.dds', sourcePath: '/instance/mods/Armour/textures/armour/a.dds', excluded: false, markedExcluded: false, includedPath: 'textures/armour/a.dds' };
    const folder = new FolderNode(armour, { kind: 'mod', name: 'Armour' }, { relativePath: 'textures', path: '/instance/mods/Armour/textures', excluded: false }, [file], [], 'textures');
    const leaf = new FileNode(folder, folder.origin, file, 'a.dds');
    const selection = [alpha, folder, leaf];

    expect(modsCopyValueText(noSelection)(leaf, undefined)).toBe('textures/armour/a.dds');
    expect(modsCopyValueText(noSelection)(folder, selection)).toBe('Alpha\ntextures\ntextures/armour/a.dds');
    expect(modsCopyValueText(() => [leaf, folder])(MODS_KEY_ARGS, undefined)).toBe('textures/armour/a.dds\ntextures');
  });

  it('owns the Mods key\'s invocation with nothing to copy when nothing is selected', () => {
    expect(modsCopyValueText(noSelection)(MODS_KEY_ARGS, undefined)).toBe('');
  });
});

describe('modbench.mod.excludeFile / modbench.mod.includeFile: every selected file, in the right-clicked row\'s direction', () => {
  beforeEach(() => { vi.clearAllMocks(); progressSteps.length = 0; });

  const modRow = new ModNode({ kind: 'mod', name: 'M', enabled: true });
  const origin = { kind: 'mod', name: 'M' } as const;
  const fileRow = (relativePath: string, excluded: boolean) => new FileNode(
    modRow, origin, { relativePath, path: `/instance/mods/M/${relativePath}`, sourcePath: `/instance/mods/M/${relativePath}`, excluded, markedExcluded: excluded, includedPath: relativePath.replaceAll('.mohidden', '') },
    relativePath);
  const included = fileRow('a.dds', false);
  const excluded = fileRow('b.dds.mohidden', true);
  const refOf = (row: FileNode) => ({ origin: row.origin, relativePath: row.file.relativePath });
  const instance = {
    ...instanceThatReads,
    value: instanceValueFixture({
      listedSourceMods: new Set(['M']),
      paths: { overwriteDir: undefined, downloadsDir: '', modDirs: new Map(), sourceDirs: new Map([['M', '/instance/source/M']]) },
    }),
  };

  it('sends every selected file to the write, whatever the view shows each as, and nothing else', async () => {
    markFiles.mockResolvedValue({ applied: true, outcome: { landed: [], refused: [] } });
    const reporter = recordingReporter();

    registerFileExclusionCommands(commands, instance, () => [], reporter);
    await invoke('modbench.mod.excludeFile', included, [included, excluded, modRow]);

    expect(markFiles).toHaveBeenCalledWith([refOf(included), refOf(excluded)], 'Excluded');
    expect(reporter.reports).toEqual([]);
  });

  it('includes the view\'s selection from the palette, where no row is right-clicked', async () => {
    markFiles.mockResolvedValue({ applied: true, outcome: { landed: [], refused: [] } });

    registerFileExclusionCommands(commands, instance, () => [excluded], recordingReporter());
    await invoke('modbench.mod.includeFile');

    expect(markFiles).toHaveBeenCalledWith([refOf(excluded)], 'Included');
  });

  it.each([
    ['excludeFile', 'Excluded', included], ['includeFile', 'Included', excluded],
  ] as const)('%s takes a file its folder excludes by its own name, with the selection\'s others', async (verb, mark, clicked) => {
    const hidingFolder = new FolderNode(
      modRow, origin, { relativePath: 'x.mohidden', path: '/instance/mods/M/x.mohidden', excluded: true }, [], [], 'x.mohidden');
    const inFolder = (relativePath: string, markedExcluded: boolean) => new FileNode(hidingFolder, origin,
      { relativePath, path: `/instance/mods/M/${relativePath}`, sourcePath: `/instance/mods/M/${relativePath}`, excluded: true, markedExcluded, includedPath: relativePath.replaceAll('.mohidden', '') },
      relativePath);
    markFiles.mockResolvedValue({ applied: true, outcome: { landed: [], refused: [] } });
    const reporter = recordingReporter();

    registerFileExclusionCommands(commands, instance, () => [], reporter);
    await invoke(`modbench.mod.${verb}`, clicked, [clicked, inFolder('x.mohidden/c.dds', false), inFolder('x.mohidden/d.dds.mohidden', true)]);

    expect(markFiles).toHaveBeenCalledWith([
      refOf(clicked), { origin, relativePath: 'x.mohidden/c.dds' }, { origin, relativePath: 'x.mohidden/d.dds.mohidden' },
    ], mark);
    expect(reporter.reports).toEqual([]);
  });

  it('calls nothing and reports nothing over a selection with no file', async () => {
    const reporter = recordingReporter();

    registerFileExclusionCommands(commands, instance, () => [modRow], reporter);
    await invoke('modbench.mod.excludeFile');

    expect(markFiles).not.toHaveBeenCalled();
    expect(reporter.reports).toEqual([]);
  });
});

describe('a Mods gesture that writes ends on the Instance loader\'s read, with the view\'s progress bar open throughout', () => {
  beforeEach(() => { vi.clearAllMocks(); progressSteps.length = 0; });

  const instance = { ...instanceThatReads, value: instanceValueFixture({ activeProfile: 'Default' }) };
  const modA = new ModNode({ kind: 'mod', name: 'Mod A', enabled: true });
  const groupA = new SeparatorNode({ kind: 'separator', name: 'Group A', enabled: true }, []);
  const fileRow = new FileNode(
    modA, { kind: 'mod', name: 'Mod A' },
    { relativePath: 'a.dds', path: '/a.dds', sourcePath: '/a.dds', excluded: false, markedExcluded: false, includedPath: 'a.dds' }, 'a.dds');
  const written = (write: ReturnType<typeof vi.fn>, result: unknown) =>
    write.mockImplementation(() => { progressSteps.push('write'); return Promise.resolve(result); });
  const landed = { applied: true, outcome: { landed: ['Mod A'], refused: [] } };
  const endsOnTheRead = ['progress opens on modbench.modList', 'write', 'Instance loader: read every file again', 'progress closes'];
  const reporter = () => recordingReporter();

  it.each<[string, () => Promise<unknown>]>([
    ['enable', () => {
      written(setModsEnabled, landed);
      registerModEnableCommands(commands, instance, () => [], reporter());
      return invoke('modbench.mod.enable', modA);
    }],
    ['a refused enable', () => {
      written(setModsEnabled, { applied: false, refusal: 'unreadable' });
      registerModEnableCommands(commands, instance, () => [], reporter());
      return invoke('modbench.mod.enable', modA);
    }],
    ['move', () => {
      written(moveMods, landed);
      registerModMoveCommand(commands, instance, { selection: () => [], direction: () => 'losingAtTop' }, reporter());
      return invoke('modbench.mod.move', modA, [modA], { place: { kind: 'ungrouped' }, end: 'losing' });
    }],
    ['uninstall', () => {
      written(uninstallMods, { applied: true, outcome: { landed: [{ name: 'Mod A' }], refused: [] } });
      registerModContextCommands({
        commands, instance, viewSelection: () => [], reporter: reporter(), ask: scriptedDialog('Uninstall'), trash: vi.fn(), log: vi.fn(),
      });
      return invoke('modbench.mod.uninstall', modA);
    }],
    ['separator delete', () => {
      written(deleteSeparators, { applied: true, outcome: { landed: [{ name: 'Group A' }], refused: [] } });
      registerSeparatorCommands(commands, instance, reporter(), scriptedDialog('Delete'), vi.fn(), () => []);
      return invoke('modbench.separator.delete', groupA);
    }],
    ['separator rename', () => {
      showInputBox.mockResolvedValueOnce('Renamed');
      written(renameSeparator, { applied: true });
      registerSeparatorCommands(commands, instance, reporter(), scriptedDialog(), vi.fn(), () => []);
      return invoke('modbench.separator.rename', groupA);
    }],
    ['separator add', () => {
      showInputBox.mockResolvedValueOnce('New Group');
      written(insertSeparator, { applied: true });
      registerSeparatorCommands(commands, instance, reporter(), scriptedDialog(), vi.fn(), () => []);
      return invoke('modbench.separator.add', groupA);
    }],
    ['create empty mod', () => {
      showInputBox.mockResolvedValueOnce('New Mod');
      written(createEmptyMod, { applied: true, wrote: true });
      registerCreateEmptyModCommand(commands, instance, reporter());
      return invoke('modbench.mod.createEmpty');
    }],
    ['exclude file', () => {
      written(markFiles, { landed: [], refused: [] });
      registerFileExclusionCommands(commands, instance, () => [], reporter());
      return invoke('modbench.mod.excludeFile', fileRow);
    }],
  ])('%s', async (_name, run) => {
    await run();

    expect(progressSteps).toEqual(endsOnTheRead);
  });

  it('a selection runs its command once, then one read', async () => {
    const modB = new ModNode({ kind: 'mod', name: 'Mod B', enabled: true });
    written(setModsEnabled, landed);
    registerModEnableCommands(commands, instance, () => [], reporter());

    await invoke('modbench.mod.disable', modA, [modA, modB]);

    expect(progressSteps).toEqual(endsOnTheRead);
    expect(setModsEnabled).toHaveBeenCalledTimes(1);
  });

  it('excluding a file the view shows already excluded still writes, since the disk decides', async () => {
    const stale = new FileNode(
      modA, { kind: 'mod', name: 'Mod A' },
      { relativePath: 'a.dds.mohidden', path: '/a', sourcePath: '/a', excluded: true, markedExcluded: true, includedPath: 'a.dds.mohidden' }, 'a.dds.mohidden');
    written(markFiles, { landed: [], refused: [] });
    registerFileExclusionCommands(commands, instance, () => [], reporter());

    await invoke('modbench.mod.excludeFile', stale);

    expect(progressSteps).toEqual(endsOnTheRead);
  });
});

describe('rename mod refuses in its prompt', () => {
  beforeEach(() => { vi.clearAllMocks(); progressSteps.length = 0; });

  const MOD_CLASH = 'A mod with this name already exists';
  const instance = {
    ...instanceThatReads,
    value: instanceValueFixture({
      activeProfile: 'Default', profiles: ['Default'],
      mods: [{ kind: 'mod', name: 'Mod A', enabled: true }, { kind: 'mod', name: 'Mod B', enabled: true }],
    }),
  };
  const modB = new ModNode({ kind: 'mod', name: 'Mod B', enabled: true });

  async function validatorOver(): Promise<(value: string) => unknown> {
    showInputBox.mockResolvedValueOnce(undefined);
    registerModContextCommands({
      commands, instance, viewSelection: () => [], reporter: recordingReporter(),
      ask: scriptedDialog(), trash: vi.fn(), log: vi.fn(),
    });
    await invoke('modbench.mod.rename', modB);
    return present(optionsOfTheOneShowInputBoxCall().validateInput, 'the rename prompt\'s validateInput');
  }

  it('asks the command whether the name is free of the other mods, passing the mod\'s own name, and asks nothing of an empty name', async () => {
    renameModNameRefusal.mockResolvedValueOnce(MOD_CLASH);
    const validate = await validatorOver();

    expect(await validate('mod a')).toBe(MOD_CLASH);
    expect(renameModNameRefusal).toHaveBeenCalledWith('mod a', 'Mod B');
    expect(await validate('')).toBeUndefined();
    expect(renameModNameRefusal).toHaveBeenCalledTimes(1);
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
    const mod = new ModNode({ kind: 'mod', name: 'Source Mod', enabled: true });

    registerOpenSourceCommand(instance, recordingReporter(), () => [mod, mod]);
    await invoke('modbench.mod.openSource');

    expect(revealed()).toEqual([]);
  });
});

describe('the mod gestures, called by the agent', () => {
  beforeEach(() => {
    vi.clearAllMocks(); progressSteps.length = 0;
    renameModNameRefusal.mockReset(); newModNameRefusal.mockReset();
  });

  const instance = {
    ...instanceThatReads,
    value: instanceValueFixture({
      activeProfile: 'Default',
      profiles: ['Default', 'Secondary'],
      mods: [
        { kind: 'mod', name: 'Mod A', enabled: true, installationFileName: 'mod-a.7z' },
        { kind: 'mod', name: 'Mod B', enabled: true },
        { kind: 'separator', name: 'Group', enabled: true },
      ],
    }),
  };
  const selected = new ModNode({ kind: 'mod', name: 'Selected Mod', enabled: true });
  const ofMods = (...names: string[]) => new AgentCall(names.map((name) => ({ kind: 'mod' as const, name })), {});
  const nothingOpened = () => {
    expect(showInputBox).not.toHaveBeenCalled();
    expect(createQuickPick).not.toHaveBeenCalled();
  };

  describe('modbench.mod.move', () => {
    const group = { kind: 'separator', name: 'Group' } as const;
    const moveCall = (place: typeof group | { kind: 'mod'; name: string }) =>
      new AgentCall([{ kind: 'mod', name: 'Mod A' }, { kind: 'mod', name: 'Mod B' }], { place, end: 'winning' });
    const view = { selection: () => [selected], direction: () => 'losingAtTop' as const };

    it('moves the mods given to the place given, never the selection, opening no pick, and answers the outcome', async () => {
      const outcome = { applied: true, outcome: { landed: ['Mod A', 'Mod B'], refused: [] } };
      moveMods.mockResolvedValue(outcome);
      const reporter = recordingReporter();
      registerModMoveCommand(commands, instance, view, reporter);

      const answered = await invoke('modbench.mod.move', moveCall(group));

      expect(moveMods).toHaveBeenCalledWith(['Mod A', 'Mod B'], group, 'winning');
      expect(answered).toEqual(outcome);
      expect(reporter.reports).toEqual([]);
      nothingOpened();
    });

    it('moves separators given as separators to a separator place, never the selection, and answers the outcome', async () => {
      const outcome = { applied: true, outcome: { landed: ['Group'], refused: [] } };
      moveSeparators.mockResolvedValue(outcome);
      registerModMoveCommand(commands, instance, view, recordingReporter());
      const above = { kind: 'separator', name: 'Group B' } as const;

      const answered = await invoke('modbench.mod.move', new AgentCall([{ kind: 'separator', name: 'Group' }], { place: above, end: 'winning' }));

      expect(moveSeparators).toHaveBeenCalledWith(['Group'], above, 'winning');
      expect(moveMods).not.toHaveBeenCalled();
      expect(answered).toEqual(outcome);
      nothingOpened();
    });

    it('refuses an Argument that mixes mods and separators, as the view moves neither', async () => {
      registerModMoveCommand(commands, instance, view, recordingReporter());

      await expect(invoke('modbench.mod.move', new AgentCall([{ kind: 'mod', name: 'Mod A' }, { kind: 'separator', name: 'Group' }], { place: group, end: 'winning' })))
        .rejects.toBeInstanceOf(Refusal);

      expect(moveMods).not.toHaveBeenCalled();
      expect(moveSeparators).not.toHaveBeenCalled();
    });

    it('answers a refusal of the whole move with its detail, reporting nothing', async () => {
      moveMods.mockResolvedValue({ applied: false, refusal: 'ENOENT: modlist.txt' });
      const reporter = recordingReporter();
      registerModMoveCommand(commands, instance, view, reporter);

      const answered = await invoke('modbench.mod.move', moveCall(group));

      expect(answered).toEqual({ applied: false, refusal: 'Failed to move mods.', detail: 'ENOENT: modlist.txt' });
      expect(reporter.reports).toEqual([]);
    });
  });

  describe('modbench.mod.rename', () => {
    const renameCall = (name: string) => new AgentCall([{ kind: 'mod', name: 'Mod A' }], { name });
    const register = (reporter = recordingReporter()) =>
      registerModContextCommands({ commands, instance, viewSelection: () => [selected], reporter, ask: scriptedDialog(), trash: vi.fn(), log: vi.fn() });

    it('renames the mod given to the name given, never the selection, asking nothing, and answers the outcome', async () => {
      renameMod.mockResolvedValue({ applied: true, lineRefusals: [] });
      const reporter = recordingReporter();
      register(reporter);

      const answered = await invoke('modbench.mod.rename', renameCall('Renamed'));

      expect(renameMod).toHaveBeenCalledWith('Mod A', 'Renamed');
      expect(answered).toEqual({ applied: true, outcome: { landed: ['Renamed'], refused: [] }, partial: [] });
      expect(reporter.reports).toEqual([]);
      nothingOpened();
    });

    it('answers a rename to the mod\'s own name as nothing landed and nothing refused, reporting nothing', async () => {
      renameMod.mockResolvedValue({ applied: true, lineRefusals: [], unchanged: true });
      const reporter = recordingReporter();
      register(reporter);

      const answered = await invoke('modbench.mod.rename', renameCall('Mod A'));

      expect(answered).toEqual({ applied: true, outcome: { landed: [], refused: [] } });
      expect(reporter.reports).toEqual([]);
    });

    it('answers a profile whose line could not be renamed as a partial failure, reporting nothing itself', async () => {
      renameMod.mockResolvedValue({ applied: true, lineRefusals: [{ profile: 'Secondary', refusal: 'disk full' }] });
      const reporter = recordingReporter();
      register(reporter);

      const answered = await invoke('modbench.mod.rename', renameCall('Renamed'));

      expect(answered).toEqual({
        applied: true, outcome: { landed: ['Renamed'], refused: [] },
        partial: [{ message: '"Mod A" was renamed, but its modlist.txt line in profile "Secondary" could not be renamed.', detail: 'disk full', severity: 'warning' }],
      });
      expect(reporter.reports).toEqual([]);
    });

    it('refuses an Argument of more than one mod', async () => {
      register();

      await expect(invoke('modbench.mod.rename', new AgentCall([{ kind: 'mod', name: 'Mod A' }, { kind: 'mod', name: 'Mod B' }], { name: 'X' }))).rejects.toBeInstanceOf(Refusal);

      expect(renameMod).not.toHaveBeenCalled();
    });
  });

  describe('modbench.mod.uninstall', () => {
    it('uninstalls the mods given, never the selection, confirming nothing', async () => {
      const outcome = { applied: true, outcome: { landed: [{ name: 'Mod A' }, { name: 'Mod B' }], refused: [] } };
      uninstallMods.mockResolvedValue(outcome);
      const ask = scriptedDialog();
      const trash = vi.fn();
      registerModContextCommands({ commands, instance, viewSelection: () => [selected], reporter: recordingReporter(), ask, trash, log: vi.fn() });

      const answered = await invoke('modbench.mod.uninstall', ofMods('Mod A', 'Mod B'));

      expect(uninstallMods).toHaveBeenCalledWith(
        ['Mod A', 'Mod B'], trash);
      expect(answered).toEqual({ ...outcome, partial: [] });
      expect(ask.asked).toEqual([]);
    });

    it('answers each part of a landed mod that failed as a partial failure, the unmarked downloaded file as a log one', async () => {
      uninstallMods.mockResolvedValue({ applied: true, outcome: { refused: [], landed: [
        { name: 'Mod A', sourceRefusal: 'in use', lineRefusal: 'disk full' }, { name: 'Mod B', markRefusal: 'gone' }, { name: 'Mod C', tagRefusal: 'not JSON' },
      ] } });
      registerModContextCommands({ commands, instance, viewSelection: () => [], reporter: recordingReporter(), ask: scriptedDialog(), trash: vi.fn(), log: vi.fn() });

      const answered = await invoke('modbench.mod.uninstall', ofMods('Mod A', 'Mod B', 'Mod C'));

      expect(answered).toMatchObject({ partial: [
        { message: '"Mod A" was uninstalled, but its source folder could not be moved to the trash.', detail: 'in use', severity: 'warning' },
        { message: '"Mod A" was uninstalled, but its modlist.txt line could not be removed.', detail: 'disk full', severity: 'warning' },
        { message: '"Mod B" was uninstalled, but its downloaded file could not be marked uninstalled', detail: 'gone', severity: 'log' },
        { message: '"Mod C" was uninstalled, but its publisher tags could not be removed.', detail: 'not JSON', severity: 'warning' },
      ] });
    });

    it('answers a refusal of the whole selection as the failure the view reports', async () => {
      uninstallMods.mockResolvedValue({ applied: false, refusal: 'ENOENT: modlist.txt' });
      registerModContextCommands({ commands, instance, viewSelection: () => [], reporter: recordingReporter(), ask: scriptedDialog(), trash: vi.fn(), log: vi.fn() });

      const answered = await invoke('modbench.mod.uninstall', ofMods('Mod A'));

      expect(answered).toEqual({ applied: false, refusal: 'Failed to uninstall mods.', detail: 'ENOENT: modlist.txt' });
    });
  });

  describe('modbench.mod.createEmpty', () => {
    const createCall = (name: string) => new AgentCall([], { name });

    it('creates the mod named, prompting for nothing, and answers the outcome', async () => {
      createEmptyMod.mockResolvedValue({ applied: true, wrote: true });
      const reporter = recordingReporter();
      registerCreateEmptyModCommand(commands, instance, reporter);

      const answered = await invoke('modbench.mod.createEmpty', createCall('New Mod'));

      expect(createEmptyMod).toHaveBeenCalledWith('New Mod');
      expect(answered).toEqual({ applied: true, outcome: { landed: ['New Mod'], refused: [] }, partial: [] });
      expect(reporter.reports).toEqual([]);
      nothingOpened();
    });

    it('refuses a name a folder holds as a Refusal, creating nothing', async () => {
      newModNameRefusal.mockResolvedValueOnce('"Mod A" already exists');
      registerCreateEmptyModCommand(commands, instance, recordingReporter());

      await expect(invoke('modbench.mod.createEmpty', createCall('Mod A'))).rejects.toEqual(new Refusal('"Mod A" already exists'));

      expect(createEmptyMod).not.toHaveBeenCalled();
    });

    it('leaves a blank name to the command, which refuses it for the view as for the agent', async () => {
      createEmptyMod.mockResolvedValue({ applied: false, refusal: 'A mod name cannot be empty.' });
      const reporter = recordingReporter();
      registerCreateEmptyModCommand(commands, instance, reporter);

      const answered = await invoke('modbench.mod.createEmpty', createCall('  '));
      showInputBox.mockResolvedValueOnce('  ');
      await invoke('modbench.mod.createEmpty');

      expect(createEmptyMod.mock.calls).toEqual([['  '], ['  ']]);
      expect(answered).toEqual({ applied: false, refusal: 'Failed to create "  ".', detail: 'A mod name cannot be empty.' });
      expect(reporter.reports).toEqual([{ severity: 'error', message: 'Failed to create "  ".', detail: 'A mod name cannot be empty.' }]);
    });

    it('answers a line that could not be written as a partial failure, reporting nothing itself', async () => {
      createEmptyMod.mockResolvedValue({ applied: true, wrote: false, lineRefusal: 'disk full' });
      const reporter = recordingReporter();
      registerCreateEmptyModCommand(commands, instance, reporter);

      const answered = await invoke('modbench.mod.createEmpty', createCall('New Mod'));

      expect(answered).toMatchObject({ partial: [{ message: '"New Mod" was created, but its modlist.txt line could not be written.', detail: 'disk full', severity: 'warning' }] });
      expect(reporter.reports).toEqual([]);
    });

    it('answers a failed create with its detail, reporting nothing', async () => {
      createEmptyMod.mockResolvedValue({ applied: false, refusal: 'disk full' });
      const reporter = recordingReporter();
      registerCreateEmptyModCommand(commands, instance, reporter);

      const answered = await invoke('modbench.mod.createEmpty', createCall('New Mod'));

      expect(answered).toEqual({ applied: false, refusal: 'Failed to create "New Mod".', detail: 'disk full' });
      expect(reporter.reports).toEqual([]);
    });
  });

  describe.each([
    ['modbench.mod.excludeFile', 'Excluded'],
    ['modbench.mod.includeFile', 'Included'],
  ])('%s', (command, mark) => {
    const origin = { kind: 'mod', name: 'Mod A' } as const;
    const inSelection = new FileNode(selected, origin, { relativePath: 'sel.dds', path: '/p/sel.dds', sourcePath: '/p/sel.dds', excluded: false, markedExcluded: false, includedPath: 'sel.dds' }, 'sel.dds');

    it('marks the files given, never the selection, and answers the outcome', async () => {
      const outcome = { applied: true, outcome: { landed: [{ origin, relativePath: 'a.dds' }], refused: [] } };
      markFiles.mockResolvedValue(outcome);
      const reporter = recordingReporter();
      registerFileExclusionCommands(commands, instance, () => [inSelection], reporter);

      const answered = await invoke(command, new AgentCall([{ kind: 'file', origin, relativePath: 'a.dds' }], {}));

      expect(markFiles).toHaveBeenCalledWith([{ origin, relativePath: 'a.dds' }], mark);
      expect(answered).toEqual(outcome);
      expect(reporter.reports).toEqual([]);
      nothingOpened();
    });

    it('answers a refusal of the whole selection as the failure the view reports', async () => {
      markFiles.mockResolvedValue({ applied: false, refusal: 'mEdit could not be reached.' });
      registerFileExclusionCommands(commands, instance, () => [], recordingReporter());

      const answered = await invoke(command, new AgentCall([{ kind: 'file', origin, relativePath: 'a.dds' }], {}));

      expect(answered).toEqual({ applied: false, refusal: `Could not ${mark === 'Excluded' ? 'exclude' : 'include'} 1 files.`, detail: 'mEdit could not be reached.' });
    });
  });
});

describe('the separator gestures, called by the agent', () => {
  beforeEach(() => {
    vi.clearAllMocks(); progressSteps.length = 0;
    separatorNameRefusal.mockReset();
  });

  const instance = {
    ...instanceThatReads,
    value: instanceValueFixture({
      activeProfile: 'Default',
      mods: [
        { kind: 'separator', name: 'Group A', enabled: true },
        { kind: 'mod', name: 'Mod A', enabled: true },
        { kind: 'separator', name: 'Group B', enabled: true },
      ],
    }),
  };
  const selected = new SeparatorNode({ kind: 'separator', name: 'Selected Group', enabled: true }, []);
  const register = (reporter = recordingReporter(), ask = scriptedDialog()) =>
    registerSeparatorCommands(commands, instance, reporter, ask, vi.fn(), () => [selected]);
  const group = (name: string) => ({ kind: 'separator' as const, name });
  const nothingOpened = (ask: ReturnType<typeof scriptedDialog>) => {
    expect(showInputBox).not.toHaveBeenCalled();
    expect(ask.asked).toEqual([]);
  };

  describe('modbench.separator.add', () => {
    it.each([
      ['a mod', { kind: 'mod', name: 'Mod A' }],
      ['a separator', group('Group A')],
    ] as const)('adds the separator named beside %s given, never the selection, asking nothing, and answers the outcome', async (_, anchor) => {
      insertSeparator.mockResolvedValue({ applied: true, wrote: true, name: 'Written Name' });
      const reporter = recordingReporter();
      const ask = scriptedDialog();
      register(reporter, ask);

      const answered = await invoke('modbench.separator.add', new AgentCall([anchor], { name: 'New Section' }));

      expect(insertSeparator.mock.calls).toEqual([['New Section', anchor]]);
      expect(answered).toEqual({ applied: true, outcome: { landed: ['Written Name'], refused: [] } });
      expect(reporter.reports).toEqual([]);
      nothingOpened(ask);
    });

    it('answers a refusal of the command as the failure the view reports', async () => {
      insertSeparator.mockResolvedValue({ applied: false, refusal: 'A separator name cannot be empty.' });
      const reporter = recordingReporter();
      register(reporter);

      const answered = await invoke('modbench.separator.add', new AgentCall([group('Group A')], { name: ' ' }));

      expect(answered).toEqual({ applied: false, refusal: 'Failed to add separator.', detail: 'A separator name cannot be empty.' });
      expect(reporter.reports).toEqual([]);
    });

    it('refuses an Argument of more than one entry, adding nothing', async () => {
      register();

      await expect(invoke('modbench.separator.add', new AgentCall([group('Group A'), group('Group B')], { name: 'X' }))).rejects.toBeInstanceOf(Refusal);

      expect(insertSeparator).not.toHaveBeenCalled();
    });
  });

  describe('modbench.separator.rename', () => {
    const renameCall = (name: string) => new AgentCall([group('Group A')], { name });

    it('renames the separator given to the name given, never the selection, asking nothing, and answers the outcome', async () => {
      renameSeparator.mockResolvedValue({ applied: true, wrote: true, name: 'Written Name' });
      const reporter = recordingReporter();
      const ask = scriptedDialog();
      register(reporter, ask);

      const answered = await invoke('modbench.separator.rename', renameCall('Renamed'));

      expect(renameSeparator.mock.calls).toEqual([['Group A', 'Renamed']]);
      expect(answered).toEqual({ applied: true, outcome: { landed: ['Written Name'], refused: [] } });
      expect(reporter.reports).toEqual([]);
      nothingOpened(ask);
    });

    it('answers a rename that wrote nothing as nothing landed and nothing refused', async () => {
      renameSeparator.mockResolvedValue({ applied: true, wrote: false, name: 'Group A' });
      register();

      expect(await invoke('modbench.separator.rename', renameCall('Group A'))).toEqual({ applied: true, outcome: { landed: [], refused: [] } });
    });

    it('answers a refusal of the command as the failure the view reports', async () => {
      renameSeparator.mockResolvedValue({ applied: false, refusal: 'A separator name cannot be empty.' });
      const reporter = recordingReporter();
      register(reporter);

      const answered = await invoke('modbench.separator.rename', renameCall(' '));

      expect(answered).toEqual({ applied: false, refusal: 'Failed to rename separator.', detail: 'A separator name cannot be empty.' });
      expect(reporter.reports).toEqual([]);
    });

    it('refuses an Argument of more than one separator, renaming nothing', async () => {
      register();

      await expect(invoke('modbench.separator.rename', new AgentCall([group('Group A'), group('Group B')], { name: 'X' }))).rejects.toBeInstanceOf(Refusal);

      expect(renameSeparator).not.toHaveBeenCalled();
    });
  });

  describe('modbench.separator.delete', () => {
    const deleteCall = new AgentCall([group('Group A'), group('Group B')], {});

    it('deletes the separators given, never the selection, asking nothing, and answers the outcome', async () => {
      const outcome = { applied: true, outcome: { landed: [{ name: 'Group A' }, { name: 'Group B' }], refused: [] } };
      deleteSeparators.mockResolvedValue(outcome);
      const reporter = recordingReporter();
      const ask = scriptedDialog();
      register(reporter, ask);

      const answered = await invoke('modbench.separator.delete', deleteCall);

      expect(deleteSeparators).toHaveBeenCalledWith(['Group A', 'Group B'], expect.any(Function));
      expect(answered).toEqual({ ...outcome, partial: [] });
      expect(reporter.reports).toEqual([]);
      nothingOpened(ask);
    });

    it('answers a line that could not be removed as a partial failure, reporting nothing itself', async () => {
      deleteSeparators.mockResolvedValue({ applied: true, outcome: { landed: [{ name: 'Group A', lineRefusal: 'disk full' }], refused: [] } });
      const reporter = recordingReporter();
      register(reporter);

      const answered = await invoke('modbench.separator.delete', new AgentCall([group('Group A')], {}));

      expect(answered).toMatchObject({ partial: [{ message: '"Group A" was deleted, but its modlist.txt line could not be removed.', detail: 'disk full', severity: 'warning' }] });
      expect(reporter.reports).toEqual([]);
    });

    it('answers a refusal of the whole selection as the failure the view reports', async () => {
      deleteSeparators.mockResolvedValue({ applied: false, refusal: 'ENOENT: modlist.txt' });
      register();

      expect(await invoke('modbench.separator.delete', deleteCall)).toEqual({ applied: false, refusal: 'Failed to delete separators.', detail: 'ENOENT: modlist.txt' });
    });
  });
});

describe('a Mods selection gesture reports a refusal through the shared reporter, once', () => {
  beforeEach(() => { vi.clearAllMocks(); progressSteps.length = 0; });

  const instance = {
    ...instanceThatReads,
    value: instanceValueFixture({
      activeProfile: 'Default',
      mods: [
        { kind: 'separator', name: 'Group A', enabled: true },
        { kind: 'mod', name: 'Mod A', enabled: true },
        { kind: 'separator', name: 'Group B', enabled: true },
        { kind: 'mod', name: 'Mod C', enabled: true },
      ],
      listedSourceMods: new Set(['M']),
    }),
  };
  const modA = new ModNode({ kind: 'mod', name: 'Mod A', enabled: true });
  const modB = new ModNode({ kind: 'mod', name: 'Mod B', enabled: true });
  const modC = new ModNode({ kind: 'mod', name: 'Mod C', enabled: true });
  const groupA = new SeparatorNode({ kind: 'separator', name: 'Group A', enabled: true }, []);
  const groupB = new SeparatorNode({ kind: 'separator', name: 'Group B', enabled: true }, []);
  const modRow = new ModNode({ kind: 'mod', name: 'M', enabled: true });
  const fileRow = (relativePath: string) => new FileNode(
    modRow, { kind: 'mod', name: 'M' }, { relativePath, path: `/instance/mods/M/${relativePath}`, sourcePath: `/instance/mods/M/${relativePath}`, excluded: false, markedExcluded: false, includedPath: relativePath },
    relativePath);
  const included = fileRow('a.dds');
  const gone = fileRow('c.dds');
  const trash = vi.fn(() => Promise.resolve());
  const pickPlace = (label: string) => createQuickPick.mockImplementationOnce(() => quickPickChoosing<{ label: string }>((items) => items.find((i) => i.label === label)));

  interface Gesture {
    readonly refused: unknown;
    readonly answer: (result: unknown) => void;
    readonly run: (reporter: ReturnType<typeof recordingReporter>) => Promise<unknown>;
  }
  const gestures = {
    uninstall: {
      refused: { name: 'Mod B' },
      answer: (result) => uninstallMods.mockResolvedValueOnce(result),
      run: (reporter) => {
        registerModContextCommands({ commands, instance, viewSelection: () => [], reporter, ask: scriptedDialog('Uninstall'), trash, log: vi.fn() });
        return invoke('modbench.mod.uninstall', modA, [modA, modB]);
      },
    },
    'separator delete': {
      refused: { name: 'Group B' },
      answer: (result) => deleteSeparators.mockResolvedValue(result),
      run: (reporter) => {
        registerSeparatorCommands(commands, instance, reporter, scriptedDialog('Delete'), trash, () => []);
        return invoke('modbench.separator.delete', groupA, [groupA, groupB]);
      },
    },
    enable: {
      refused: 'Mod B',
      answer: (result) => setModsEnabled.mockResolvedValue(result),
      run: (reporter) => {
        registerModEnableCommands(commands, instance, () => [], reporter);
        return invoke('modbench.mod.enable', modA, [modA, modB]);
      },
    },
    move: {
      refused: 'Mod C',
      answer: (result) => {
        pickPlace('Ungrouped');
        moveMods.mockResolvedValue(result);
      },
      run: (reporter) => {
        registerModMoveCommand(commands, instance, { selection: () => [], direction: () => 'losingAtTop' }, reporter);
        return invoke('modbench.mod.move', modA, [modA, modC]);
      },
    },
    'exclude file': {
      refused: { origin: gone.origin, relativePath: 'c.dds' },
      answer: (result) => markFiles.mockResolvedValue(result),
      run: (reporter) => {
        registerFileExclusionCommands(commands, instance, () => [], reporter);
        return invoke('modbench.mod.excludeFile', included, [included, gone]);
      },
    },
  } satisfies Record<string, Gesture>;

  it.each([
    ['uninstall', 'Could not uninstall 1 of 2 mods.', '"Mod B" (trash unavailable)'],
    ['separator delete', 'Could not delete 1 of 2 separators.', '"Group B" (trash unavailable)'],
    ['enable', 'Could not enable 1 of 2 mods.', '"Mod B" (trash unavailable)'],
    ['move', 'Could not move 1 of 2 mods.', '"Mod C" (trash unavailable)'],
    ['exclude file', 'Could not exclude 1 of 2 files.', '"M/c.dds" (trash unavailable)'],
  ] as const)('%s names the refused item and why, while the others land', async (name, message, detail) => {
    const gesture: Gesture = gestures[name];
    gesture.answer({ applied: true, outcome: { landed: [], refused: [{ item: gesture.refused, reason: 'trash unavailable' }] } });
    const reporter = recordingReporter();

    await gesture.run(reporter);

    expect(reporter.reports).toEqual([{ severity: 'error', message, detail }]);
  });

  it.each([
    ['uninstall', 'Failed to uninstall mods.'],
    ['separator delete', 'Failed to delete separators.'],
    ['enable', 'Failed to enable mods.'],
    ['move', 'Failed to move mods.'],
    ['exclude file', 'Could not exclude 2 files.'],
  ] as const)('%s reports a refusal of the whole selection with its cause', async (name, message) => {
    const gesture: Gesture = gestures[name];
    gesture.answer({ applied: false, refusal: 'ENOENT: modlist.txt' });
    const reporter = recordingReporter();

    await gesture.run(reporter);

    expect(reporter.reports).toEqual([{ severity: 'error', message, detail: 'ENOENT: modlist.txt' }]);
  });
});

describe('a Mods gesture called by the agent refuses an Argument of a kind it does not take, writing nothing', () => {
  beforeEach(() => { vi.clearAllMocks(); progressSteps.length = 0; });

  const instance = { ...instanceThatReads, value: instanceValueFixture({ activeProfile: 'Default' }) };
  const plugin = { kind: 'plugin', plugin: { name: 'A.esp', origin: 'Mod A' } } as const;
  const mod = { kind: 'mod', name: 'Mod A' } as const;
  const registerContext = () =>
    registerModContextCommands({ commands, instance, viewSelection: () => [], reporter: recordingReporter(), ask: scriptedDialog(), trash: vi.fn(), log: vi.fn() });
  const registerSeparators = () => registerSeparatorCommands(commands, instance, recordingReporter(), scriptedDialog(), vi.fn(), () => []);

  it.each([
    ['modbench.mod.enable', plugin, () => registerModEnableCommands(commands, instance, () => [], recordingReporter()), setModsEnabled],
    ['modbench.mod.disable', plugin, () => registerModEnableCommands(commands, instance, () => [], recordingReporter()), setModsEnabled],
    ['modbench.mod.move', plugin, () => registerModMoveCommand(commands, instance, { selection: () => [], direction: () => 'losingAtTop' }, recordingReporter()), moveMods],
    ['modbench.mod.uninstall', plugin, registerContext, uninstallMods],
    ['modbench.mod.rename', plugin, registerContext, renameMod],
    ['modbench.mod.excludeFile', mod, () => registerFileExclusionCommands(commands, instance, () => [], recordingReporter()), markFiles],
    ['modbench.mod.includeFile', mod, () => registerFileExclusionCommands(commands, instance, () => [], recordingReporter()), markFiles],
    ['modbench.separator.add', plugin, registerSeparators, insertSeparator],
    ['modbench.separator.rename', mod, registerSeparators, renameSeparator],
    ['modbench.separator.delete', mod, registerSeparators, deleteSeparators],
  ] as const)('%s', async (command, argument, register, write) => {
    register();

    await expect(invoke(command, new AgentCall([argument], { name: 'X' }))).rejects.toBeInstanceOf(Refusal);

    expect(write).not.toHaveBeenCalled();
  });
});
