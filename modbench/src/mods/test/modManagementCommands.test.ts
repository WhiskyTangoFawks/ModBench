import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TreeItem, TreeItemCollapsibleState, TreeItemCheckboxState, EventEmitter, ThemeIcon, ThemeColor, MarkdownString, uriFile, uriFrom } from '../../test/vscodeMock';

interface InputBoxOptionsDoubleOfJustPromptAndValidateInput {
  prompt?: string;
  value?: string;
  placeHolder?: string;
  validateInput?: (value: string) => Thenable<string | undefined> | string | undefined;
}

const { registerCommand, executeCommand, showOpenDialog, showInputBox, showQuickPick, openExternal } = vi.hoisted(() => ({
  registerCommand: vi.fn((_id: string, handler: (...args: unknown[]) => unknown) => ({ dispose: vi.fn(), handler })),
  executeCommand: vi.fn((_command: string, _uri?: { fsPath: string }) => Promise.resolve()),
  showOpenDialog: vi.fn(),
  showInputBox: vi.fn<(options?: InputBoxOptionsDoubleOfJustPromptAndValidateInput) => Promise<string | undefined>>(),
  showQuickPick: vi.fn<(items: readonly { label: string }[]) => Promise<unknown>>(),
  openExternal: vi.fn(),
}));

vi.mock('vscode', async () => {
  const { recordedWithProgress } = await import('../../test/recordedProgress');
  return {
    commands: { registerCommand, executeCommand },
    window: { showOpenDialog, showInputBox, showQuickPick, withProgress: recordedWithProgress },
    env: { openExternal },
    TreeItem, TreeItemCollapsibleState, TreeItemCheckboxState, EventEmitter, ThemeIcon, ThemeColor, MarkdownString,
    Uri: { file: uriFile, from: uriFrom, parse: (s: string) => ({ toString: () => s }) },
  };
});

import { progressSteps } from '../../test/recordedProgress';

const {
  uninstallMods, deleteSeparators, renameSeparator, insertSeparator, createEmptyMod, setModsEnabled, moveMods, moveSeparators, markFiles,
} = vi.hoisted(() => ({
  uninstallMods: vi.fn(), deleteSeparators: vi.fn(), renameSeparator: vi.fn(), insertSeparator: vi.fn(),
  createEmptyMod: vi.fn(), setModsEnabled: vi.fn(), moveMods: vi.fn(), moveSeparators: vi.fn(), markFiles: vi.fn(),
}));

vi.mock('../../modlist/modlist', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../modlist/modlist')>()),
  createEmptyMod, deleteSeparators, insertSeparator,
  moveMods, moveSeparators, renameSeparator, uninstallMods, setModsEnabled, markFiles,
}));

import {
  registerCreateEmptyModCommand, registerModContextCommands, registerModEnableCommands, registerFileExclusionCommands,
  registerModMoveCommand,
  registerModListCoreCommands, registerOpenFolderCommand, registerSeparatorCommands, registerViewOnNexusCommand,
  modsCopyValueText,
  type NexusModRow,
} from '../modManagementCommands';
import { ModNode, OverwriteNode, SeparatorNode, type ModlistNode } from '../ModListProvider';
import { MODS_KEY_ARGS } from '../gestureEntry';
import { FileNode, FolderNode } from '../modFiles';
import { recordingReporter, scriptedDialog, assertAskedOnce } from '../../test/surfacingDoubles';
import { present } from '../../ports/present';
import { instanceValueFixture } from '../../test/mo2/instanceValueFixture';
import { accessTo } from '../../test/mo2/adapterOver';
import { cloneCorpusFixture } from '../../test/mo2/corpusFixture';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function invoke(commandId: string, ...args: unknown[]): Promise<unknown> {
  const call = registerCommand.mock.calls.find((c) => c[0] === commandId);
  if (!call) throw new Error(`command not registered: ${commandId}`);
  return Promise.resolve(call[1](...args));
}

const access = accessTo('/instance');
const instanceThatReads = {
  refresh: () => { progressSteps.push('Instance loader: read every file again'); return Promise.resolve(); },
};

describe('the sort direction', () => {
  beforeEach(() => { vi.clearAllMocks(); progressSteps.length = 0; });

  const directionKeys = () => executeCommand.mock.calls
    .filter((c) => c[0] === 'setContext' && (c as unknown[])[1] === 'modbench.mod.winningAtTop')
    .map((c) => (c as unknown[])[2]);

  it('starts losing at the top, and the title-bar icon agrees, since a context key outlives an extension host restart and the provider\'s direction does not', () => {
    const setViewDirection = vi.fn();
    registerModListCoreCommands({ setViewDirection });

    expect(setViewDirection).not.toHaveBeenCalled();
    expect(directionKeys()).toEqual([false]);
  });

  it('each title-bar icon sets its own direction, whatever the view last showed', async () => {
    const setViewDirection = vi.fn();
    registerModListCoreCommands({ setViewDirection });

    await invoke('modbench.mod.sortLosingAtTop');
    await invoke('modbench.mod.sortWinningAtTop');
    await invoke('modbench.mod.sortWinningAtTop');

    expect(setViewDirection.mock.calls).toEqual([['losingAtTop'], ['winningAtTop'], ['winningAtTop']]);
    expect(directionKeys()).toEqual([false, false, true, true]);
  });
});

describe('modbench.mod.createEmpty: the prompt refuses in install\'s own words', () => {
  beforeEach(() => { vi.clearAllMocks(); progressSteps.length = 0; });

  const instance = { ...instanceThatReads, value: instanceValueFixture({ activeProfile: 'Default', mods: [{ kind: 'mod', name: 'Existing Mod', enabled: true }] }) };

  it('Esc creates nothing', async () => {
    showInputBox.mockResolvedValueOnce(undefined);
    const reporter = recordingReporter();

    registerCreateEmptyModCommand(access, instance, reporter);
    await invoke('modbench.mod.createEmpty');

    expect(createEmptyMod).not.toHaveBeenCalled();
    expect(reporter.reports).toEqual([]);
  });

  it('the prompt\'s validateInput refuses a taken name, in the words install refuses it with', async () => {
    const root = cloneCorpusFixture();
    try {
      registerCreateEmptyModCommand(accessTo(root), instance, recordingReporter());
      await invoke('modbench.mod.createEmpty');

      const [options] = present(showInputBox.mock.calls[0], 'the one showInputBox call');
      const validateInput = present(options?.validateInput, 'validateInput on the input box options');
      expect(await validateInput('Harder VATS')).toMatch(/"Harder VATS" already exists/);
      expect(await validateInput('A New Name')).toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('creates the folder and its line, and reports nothing when both land', async () => {
    showInputBox.mockResolvedValueOnce('New Mod');
    createEmptyMod.mockResolvedValueOnce({ applied: true, wrote: true });
    const reporter = recordingReporter();

    registerCreateEmptyModCommand(access, instance, reporter);
    await invoke('modbench.mod.createEmpty');

    expect(createEmptyMod).toHaveBeenCalledWith(access, 'Default', 'New Mod');
    expect(reporter.reports).toEqual([]);
  });

  it('reports a landed-but-partial line failure as a warning, not a failed create', async () => {
    showInputBox.mockResolvedValueOnce('New Mod');
    createEmptyMod.mockResolvedValueOnce({ applied: true, wrote: false, lineRefusal: 'disk full' });
    const reporter = recordingReporter();

    registerCreateEmptyModCommand(access, instance, reporter);
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
    const another = { ...instanceThatReads, value: instanceValueFixture({ managerNames: { manager: 'Another Manager', modOrderFile: 'order.txt' } }) };

    registerCreateEmptyModCommand(access, another, reporter);
    await invoke('modbench.mod.createEmpty');

    expect(reporter.reports.map((r) => r.message)).toEqual(['"New Mod" was created, but its order.txt line could not be written.']);
  });

  it('reports a name-collision refusal as a failed create', async () => {
    showInputBox.mockResolvedValueOnce('New Mod');
    createEmptyMod.mockResolvedValueOnce({ applied: false, refusal: 'A mod named "New Mod" already exists.' });
    const reporter = recordingReporter();

    registerCreateEmptyModCommand(access, instance, reporter);
    await invoke('modbench.mod.createEmpty');

    expect(reporter.reports).toEqual([{
      severity: 'error',
      message: 'Failed to create "New Mod".',
      detail: 'A mod named "New Mod" already exists.',
    }]);
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
  const modA = new ModNode({ kind: 'mod', name: 'Mod A', enabled: true, archiveFilename: 'mod-a.7z' });
  const modB = new ModNode({ kind: 'mod', name: 'Mod B', enabled: true });

  it('asks one modal naming the mod, then uninstalls it once confirmed', async () => {
    uninstallMods.mockResolvedValueOnce({ applied: true, outcome: { landed: [{ name: 'Mod A' }], refused: [] } });
    const ask = scriptedDialog('Uninstall');

    registerModContextCommands({ access, instance, viewSelection: () => [], reporter: recordingReporter(), ask, trash, log });
    await invoke('modbench.mod.uninstall', modA);

    expect(ask.asked).toEqual([{
      message: 'Uninstall "Mod A"? Its folder will be moved to the system trash.',
      detail: undefined,
      buttons: ['Uninstall'],
    }]);
    expect(uninstallMods).toHaveBeenCalledWith(
      access, 'Default', [{ name: 'Mod A', archiveFilename: 'mod-a.7z' }], trash);
  });

  it('asks one modal listing every mod, for a selection of several', async () => {
    uninstallMods.mockResolvedValueOnce({
      applied: true, outcome: { landed: [{ name: 'Mod A' }, { name: 'Mod B' }], refused: [] },
    });
    const ask = scriptedDialog('Uninstall');

    registerModContextCommands({ access, instance, viewSelection: () => [], reporter: recordingReporter(), ask, trash, log });
    await invoke('modbench.mod.uninstall', modA, [modA, modB]);

    assertAskedOnce(ask, { messageContains: '"Mod A", "Mod B"', buttons: ['Uninstall'] });
    expect(ask.asked[0]?.message).toContain('Their folders will be moved to the system trash.');
    expect(uninstallMods).toHaveBeenCalledWith(
      access, 'Default',
      [{ name: 'Mod A', archiveFilename: 'mod-a.7z' }, { name: 'Mod B', archiveFilename: undefined }],
      trash,
    );
  });

  it('uninstalls nothing when the modal is dismissed', async () => {
    uninstallMods.mockResolvedValue({ applied: true, outcome: { landed: [], refused: [] } });

    registerModContextCommands({ access, instance, viewSelection: () => [], reporter: recordingReporter(), ask: scriptedDialog(undefined), trash, log });
    await invoke('modbench.mod.uninstall', modA);

    expect(uninstallMods).not.toHaveBeenCalled();
  });

  it('falls back to the view selection from a key, where no row is right-clicked', async () => {
    uninstallMods.mockResolvedValueOnce({ applied: true, outcome: { landed: [{ name: 'Mod A' }], refused: [] } });

    registerModContextCommands({ access, instance, viewSelection: () => [modA], reporter: recordingReporter(), ask: scriptedDialog('Uninstall'), trash, log });
    await invoke('modbench.mod.uninstall');

    expect(uninstallMods).toHaveBeenCalledWith(
      access, 'Default', [{ name: 'Mod A', archiveFilename: 'mod-a.7z' }], trash);
  });

  it('an empty selection asks nothing and uninstalls nothing', async () => {
    const ask = scriptedDialog('Uninstall');

    registerModContextCommands({ access, instance, viewSelection: () => [], reporter: recordingReporter(), ask, trash, log });
    await invoke('modbench.mod.uninstall');

    expect(ask.asked).toEqual([]);
    expect(uninstallMods).not.toHaveBeenCalled();
  });

  it('reports a refused mod by name, once, while the others land', async () => {
    uninstallMods.mockResolvedValueOnce({
      applied: true,
      outcome: { landed: [{ name: 'Mod A' }], refused: [{ item: { name: 'Mod B' }, reason: 'trash unavailable' }] },
    });
    const reporter = recordingReporter();

    registerModContextCommands({ access, instance, viewSelection: () => [], reporter, ask: scriptedDialog('Uninstall'), trash, log });
    await invoke('modbench.mod.uninstall', modA, [modA, modB]);

    expect(reporter.reports).toEqual([{
      severity: 'error', message: 'Could not uninstall 1 of 2 mods.', detail: '"Mod B" (trash unavailable)',
    }]);
  });

  it('reports a refusal of the whole selection once, when modlist.txt cannot be read at all', async () => {
    uninstallMods.mockResolvedValueOnce({ applied: false, refusal: 'ENOENT: modlist.txt' });
    const reporter = recordingReporter();

    registerModContextCommands({ access, instance, viewSelection: () => [], reporter, ask: scriptedDialog('Uninstall'), trash, log });
    await invoke('modbench.mod.uninstall', modA);

    expect(reporter.reports).toEqual([
      { severity: 'error', message: 'Failed to uninstall mods.', detail: 'ENOENT: modlist.txt' },
    ]);
  });

  it('says nothing extra for a fully landed uninstall with no failed mark', async () => {
    uninstallMods.mockResolvedValueOnce({ applied: true, outcome: { landed: [{ name: 'Mod A' }], refused: [] } });
    const reporter = recordingReporter();

    registerModContextCommands({ access, instance, viewSelection: () => [], reporter, ask: scriptedDialog('Uninstall'), trash, log });
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

    registerModContextCommands({ access, instance, viewSelection: () => [], reporter, ask: scriptedDialog('Uninstall'), trash, log });
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

    registerModContextCommands({ access, instance, viewSelection: () => [], reporter, ask: scriptedDialog('Uninstall'), trash, log });
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

    registerSeparatorCommands(access, instance, reporter, scriptedDialog('Delete'), trash, () => []);
    await invoke('modbench.separator.delete', groupB, [groupA, groupB]);

    expect(deleteSeparators.mock.calls).toEqual([[access, 'Default', ['Group A', 'Group B'], trash]]);
    expect(reporter.reports).toEqual([]);
  });

  it('asks one modal naming the separator and saying its mods stay', async () => {
    deleteSeparators.mockResolvedValue({ applied: true, outcome: { landed: [{ name: 'Group A' }], refused: [] } });
    const ask = scriptedDialog('Delete');

    registerSeparatorCommands(access, instance, recordingReporter(), ask, trash, () => []);
    await invoke('modbench.separator.delete', groupA);

    expect(ask.asked).toEqual([{ message: 'Delete separator "Group A"? Its mods stay.', detail: undefined, buttons: ['Delete'] }]);
  });

  it('asks one modal listing every separator of a selection of several', async () => {
    deleteSeparators.mockResolvedValue({
      applied: true, outcome: { landed: [{ name: 'Group A' }, { name: 'Group B' }], refused: [] },
    });
    const ask = scriptedDialog('Delete');

    registerSeparatorCommands(access, instance, recordingReporter(), ask, trash, () => []);
    await invoke('modbench.separator.delete', groupA, [groupA, groupB]);

    assertAskedOnce(ask, { messageContains: '"Group A", "Group B"', buttons: ['Delete'] });
    expect(ask.asked[0]?.message).toContain('Their mods stay.');
  });

  it('a cancelled question writes nothing', async () => {
    const ask = scriptedDialog(undefined);

    registerSeparatorCommands(access, instance, recordingReporter(), ask, trash, () => []);
    await invoke('modbench.separator.delete', groupA, [groupA, groupB]);

    expect(deleteSeparators).not.toHaveBeenCalled();
  });

  it('takes only the separators of a selection mixing mods and separators', async () => {
    deleteSeparators.mockResolvedValue({ applied: true, outcome: { landed: [{ name: 'Group A' }], refused: [] } });

    registerSeparatorCommands(access, instance, recordingReporter(), scriptedDialog('Delete'), trash, () => []);
    await invoke('modbench.separator.delete', groupA, [modA, groupA]);

    expect(deleteSeparators.mock.calls).toEqual([[access, 'Default', ['Group A'], trash]]);
  });

  it('falls back to the view selection from a key, where no row is right-clicked', async () => {
    deleteSeparators.mockResolvedValue({
      applied: true, outcome: { landed: [{ name: 'Group A' }, { name: 'Group B' }], refused: [] },
    });

    registerSeparatorCommands(access, instance, recordingReporter(), scriptedDialog('Delete'), trash, () => [groupA, groupB]);
    await invoke('modbench.separator.delete');

    expect(deleteSeparators.mock.calls).toEqual([[access, 'Default', ['Group A', 'Group B'], trash]]);
  });

  it('calls nothing and reports nothing for a selection with no separator', async () => {
    const reporter = recordingReporter();

    registerSeparatorCommands(access, instance, reporter, scriptedDialog('Delete'), trash, () => [modA]);
    await invoke('modbench.separator.delete');

    expect(deleteSeparators).not.toHaveBeenCalled();
    expect(reporter.reports).toEqual([]);
  });

  it('reports each refused separator, naming why, once, while the others land', async () => {
    deleteSeparators.mockResolvedValue({
      applied: true,
      outcome: { landed: [{ name: 'Group A' }], refused: [{ item: { name: 'Group B' }, reason: 'trash unavailable' }] },
    });
    const reporter = recordingReporter();

    registerSeparatorCommands(access, instance, reporter, scriptedDialog('Delete'), trash, () => []);
    await invoke('modbench.separator.delete', groupA, [groupA, groupB]);

    expect(reporter.reports).toEqual([{
      severity: 'error', message: 'Could not delete 1 of 2 separators.', detail: '"Group B" (trash unavailable)',
    }]);
  });

  it('reports a refusal of the whole selection once', async () => {
    deleteSeparators.mockResolvedValue({ applied: false, refusal: 'ENOENT: modlist.txt' });
    const reporter = recordingReporter();

    registerSeparatorCommands(access, instance, reporter, scriptedDialog('Delete'), trash, () => []);
    await invoke('modbench.separator.delete', groupA, [groupA, groupB]);

    expect(reporter.reports).toEqual([
      { severity: 'error', message: 'Failed to delete separators.', detail: 'ENOENT: modlist.txt' },
    ]);
  });

  it('a post-trash line failure is a warning notification naming the part that failed, not a failed delete', async () => {
    deleteSeparators.mockResolvedValue({
      applied: true, outcome: { landed: [{ name: 'Group A', lineRefusal: 'disk full' }], refused: [] },
    });
    const reporter = recordingReporter();

    registerSeparatorCommands(access, instance, reporter, scriptedDialog('Delete'), trash, () => []);
    await invoke('modbench.separator.delete', groupA);

    expect(reporter.reports).toEqual([{
      severity: 'warning',
      message: '"Group A" was deleted, but its modlist.txt line could not be removed.',
      detail: 'disk full',
    }]);
  });
});

const CLASH = 'A separator with this name already exists';

async function instanceWithFoldersLeftByAnotherToolAndModOrderListing(
  folders: readonly string[], entries: readonly { kind: 'mod' | 'separator'; name: string }[] = [],
): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'mod-folders-'));
  for (const folder of folders) await mkdir(join(root, 'mods', folder), { recursive: true });
  await mkdir(join(root, 'profiles', 'Default'), { recursive: true });
  await writeFile(join(root, 'profiles', 'Default', 'modlist.txt'), '');
  await accessTo(root).adapter.changeModOrder('Default', () =>
    entries.map((entry) => ({ kind: 'addAtWinningEnd', entry })));
  return root;
}

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

    registerSeparatorCommands(access, instance, recordingReporter(), scriptedDialog(), vi.fn(), () => [groupA, groupB]);
    await invoke('modbench.separator.rename', groupB, [groupA, groupB]);

    expect(optionsOfTheOneShowInputBoxCall()).toMatchObject({ prompt: 'Rename separator', value: 'Group B' });
    expect(renameSeparator.mock.calls).toEqual([[access, 'Default', 'Group B', 'Renamed']]);
  });

  it('refuses in the prompt a name another separator\'s folder holds, in any case (MO2 keys separators by name without case), and takes its own name or a mod\'s', async () => {
    const root = await instanceWithFoldersLeftByAnotherToolAndModOrderListing(['Group A_separator', 'Group B_separator', 'Mod A']);
    try {
      showInputBox.mockResolvedValueOnce(undefined);

      registerSeparatorCommands(accessTo(root), instance, recordingReporter(), scriptedDialog(), vi.fn(), () => []);
      await invoke('modbench.separator.rename', groupB);

      const validate = present(optionsOfTheOneShowInputBoxCall().validateInput, 'the rename prompt\'s validateInput');
      expect(await validate('group a')).toBe(CLASH);
      expect(await validate('GROUP B')).toBeUndefined();
      expect(await validate('Mod A')).toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('refuses in the prompt a name a separator with no folder has, in any case, since a line in mod order is a separator whose folder may be gone, and takes its own', async () => {
    const root = await instanceWithFoldersLeftByAnotherToolAndModOrderListing([], [
      { kind: 'separator', name: 'Group A' }, { kind: 'mod', name: 'Mod A' }, { kind: 'separator', name: 'Group B' },
    ]);
    try {
      showInputBox.mockResolvedValueOnce(undefined);

      registerSeparatorCommands(accessTo(root), instance, recordingReporter(), scriptedDialog(), vi.fn(), () => []);
      await invoke('modbench.separator.rename', groupB);

      const validate = present(optionsOfTheOneShowInputBoxCall().validateInput, 'the rename prompt\'s validateInput');
      expect(await validate('group a')).toBe(CLASH);
      expect(await validate('GROUP B')).toBeUndefined();
      expect(await validate('Mod A')).toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('reports the refusal of a name another separator took after the prompt closed', async () => {
    renameSeparator.mockResolvedValue({ applied: false, refusal: CLASH });
    showInputBox.mockResolvedValueOnce('Taken Meanwhile');
    const reporter = recordingReporter();

    registerSeparatorCommands(access, instance, reporter, scriptedDialog(), vi.fn(), () => []);
    await invoke('modbench.separator.rename', groupB);

    expect(reporter.reports).toEqual([{ severity: 'error', message: 'Failed to rename separator.', detail: CLASH }]);
  });

  it('renames nothing when the prompt is cancelled (Esc) or left empty', async () => {
    showInputBox.mockResolvedValueOnce(undefined).mockResolvedValueOnce('');

    registerSeparatorCommands(access, instance, recordingReporter(), scriptedDialog(), vi.fn(), () => []);
    await invoke('modbench.separator.rename', groupA);
    await invoke('modbench.separator.rename', groupA);

    expect(renameSeparator).not.toHaveBeenCalled();
  });

  it('renames nothing when the prompt keeps the same name', async () => {
    showInputBox.mockResolvedValueOnce('Group A');

    registerSeparatorCommands(access, instance, recordingReporter(), scriptedDialog(), vi.fn(), () => [groupA]);
    await invoke('modbench.separator.rename', groupA);

    expect(renameSeparator).not.toHaveBeenCalled();
  });

  it.each([['F2', [MODS_KEY_ARGS]], ['the palette', []]])('renames the one selected separator from %s', async (_from, args) => {
    renameSeparator.mockResolvedValue({ applied: true, wrote: true });
    showInputBox.mockResolvedValueOnce('Renamed');

    registerSeparatorCommands(access, instance, recordingReporter(), scriptedDialog(), vi.fn(), () => [groupB]);
    await invoke('modbench.separator.rename', ...args);

    expect(optionsOfTheOneShowInputBoxCall()).toMatchObject({ value: 'Group B' });
    expect(renameSeparator.mock.calls).toEqual([[access, 'Default', 'Group B', 'Renamed']]);
  });

  it.each([['F2', [MODS_KEY_ARGS]], ['the palette', []]])('asks nothing from %s while several rows are selected', async (_from, args) => {
    registerSeparatorCommands(access, instance, recordingReporter(), scriptedDialog(), vi.fn(), () => [groupA, groupB]);
    await invoke('modbench.separator.rename', ...args);

    expect(showInputBox).not.toHaveBeenCalled();
    expect(renameSeparator).not.toHaveBeenCalled();
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

    registerSeparatorCommands(access, instance, recordingReporter(), scriptedDialog(), vi.fn(), () => [otherMod, modA]);
    await invoke('modbench.separator.add', modA, [otherMod, modA]);

    expect(optionsOfTheOneShowInputBoxCall()).toMatchObject({ prompt: 'Separator name', placeHolder: 'My Group' });
    expect(insertSeparator.mock.calls).toEqual([[access, 'Default', 'New Section', { kind: 'mod', name: 'Mod A' }]]);
  });

  it('refuses in the prompt a name another separator\'s folder holds, as MO2 would name it, and takes a mod\'s', async () => {
    const root = await instanceWithFoldersLeftByAnotherToolAndModOrderListing(['Group A_separator', 'Mod A']);
    try {
      showInputBox.mockResolvedValueOnce(undefined);

      registerSeparatorCommands(accessTo(root), instance, recordingReporter(), scriptedDialog(), vi.fn(), () => []);
      await invoke('modbench.separator.add', modA);

      const validate = present(optionsOfTheOneShowInputBoxCall().validateInput, 'the add prompt\'s validateInput');
      expect(await validate('Group A')).toBe(CLASH);
      expect(await validate(' Group A. ')).toBe(CLASH);
      expect(await validate('Mod A')).toBeUndefined();
      expect(await validate('')).toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('refuses in the prompt a name a separator with no folder has, in any case, since a line in mod order is a separator whose folder may be gone', async () => {
    const root = await instanceWithFoldersLeftByAnotherToolAndModOrderListing([], [{ kind: 'mod', name: 'Mod A' }, { kind: 'separator', name: 'Group A' }]);
    try {
      showInputBox.mockResolvedValueOnce(undefined);

      registerSeparatorCommands(accessTo(root), instance, recordingReporter(), scriptedDialog(), vi.fn(), () => []);
      await invoke('modbench.separator.add', modA);

      const validate = present(optionsOfTheOneShowInputBoxCall().validateInput, 'the add prompt\'s validateInput');
      expect(await validate('group a')).toBe(CLASH);
      expect(await validate('Mod A')).toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('reports the refusal of a name another separator took after the prompt closed', async () => {
    insertSeparator.mockResolvedValue({ applied: false, refusal: CLASH });
    showInputBox.mockResolvedValueOnce('Taken Meanwhile');
    const reporter = recordingReporter();

    registerSeparatorCommands(access, instance, reporter, scriptedDialog(), vi.fn(), () => []);
    await invoke('modbench.separator.add', modA);

    expect(reporter.reports).toEqual([{ severity: 'error', message: 'Failed to add separator.', detail: CLASH }]);
  });

  it('prompts and anchors the new separator on the right-clicked separator, not the selection around it', async () => {
    insertSeparator.mockResolvedValue({ applied: true, wrote: true });
    showInputBox.mockResolvedValueOnce('New Section');
    const otherGroup = new SeparatorNode({ kind: 'separator', name: 'Other Group', enabled: true }, []);

    registerSeparatorCommands(access, instance, recordingReporter(), scriptedDialog(), vi.fn(), () => [otherGroup, groupA]);
    await invoke('modbench.separator.add', groupA, [otherGroup, groupA]);

    expect(insertSeparator.mock.calls).toEqual([[access, 'Default', 'New Section', { kind: 'separator', name: 'Group A' }]]);
  });

  it('adds nothing when the prompt is cancelled (Esc)', async () => {
    showInputBox.mockResolvedValueOnce(undefined);

    registerSeparatorCommands(access, instance, recordingReporter(), scriptedDialog(), vi.fn(), () => [modA]);
    await invoke('modbench.separator.add', modA);

    expect(insertSeparator).not.toHaveBeenCalled();
  });

  it('adds nothing for an empty name', async () => {
    showInputBox.mockResolvedValueOnce('');

    registerSeparatorCommands(access, instance, recordingReporter(), scriptedDialog(), vi.fn(), () => [modA]);
    await invoke('modbench.separator.add', modA);

    expect(insertSeparator).not.toHaveBeenCalled();
  });

  it('anchors the new separator on the one selected row from the palette', async () => {
    insertSeparator.mockResolvedValue({ applied: true, wrote: true });
    showInputBox.mockResolvedValueOnce('New Section');

    registerSeparatorCommands(access, instance, recordingReporter(), scriptedDialog(), vi.fn(), () => [modA]);
    await invoke('modbench.separator.add');

    expect(insertSeparator.mock.calls).toEqual([[access, 'Default', 'New Section', { kind: 'mod', name: 'Mod A' }]]);
  });

  it('asks nothing and adds nothing from the palette while several rows are selected', async () => {
    registerSeparatorCommands(access, instance, recordingReporter(), scriptedDialog(), vi.fn(), () => [modA, groupA]);
    await invoke('modbench.separator.add');

    expect(showInputBox).not.toHaveBeenCalled();
    expect(insertSeparator).not.toHaveBeenCalled();
  });
});

describe('modbench.mod.enable / modbench.mod.disable: the whole selection, one command per direction', () => {
  beforeEach(() => { vi.clearAllMocks(); progressSteps.length = 0; });

  const instance = { ...instanceThatReads, value: instanceValueFixture({ activeProfile: 'Default' }) };
  const modA = new ModNode({ kind: 'mod', name: 'Mod A', enabled: false });
  const modB = new ModNode({ kind: 'mod', name: 'Mod B', enabled: true });
  const groupA = new SeparatorNode({ kind: 'separator', name: 'Group A', enabled: true }, []);

  it('enable applies to every selected mod, whatever its own current state', async () => {
    setModsEnabled.mockResolvedValue({ applied: true, outcome: { landed: ['Mod A', 'Mod B'], refused: [] } });

    registerModEnableCommands(access, instance, () => [], recordingReporter());
    await invoke('modbench.mod.enable', modA, [modA, modB]);

    expect(setModsEnabled).toHaveBeenCalledWith(access, 'Default', ['Mod A', 'Mod B'], true);
  });

  it('disable applies to every selected mod, whatever its own current state', async () => {
    setModsEnabled.mockResolvedValue({ applied: true, outcome: { landed: ['Mod A', 'Mod B'], refused: [] } });

    registerModEnableCommands(access, instance, () => [], recordingReporter());
    await invoke('modbench.mod.disable', modB, [modA, modB]);

    expect(setModsEnabled).toHaveBeenCalledWith(access, 'Default', ['Mod A', 'Mod B'], false);
  });

  it('takes only the mods of a selection mixing mods and separators, anchored on the clicked mod', async () => {
    setModsEnabled.mockResolvedValue({ applied: true, outcome: { landed: ['Mod A'], refused: [] } });

    registerModEnableCommands(access, instance, () => [], recordingReporter());
    await invoke('modbench.mod.enable', modA, [modA, groupA]);

    expect(setModsEnabled).toHaveBeenCalledWith(access, 'Default', ['Mod A'], true);
  });

  it('falls back to the view selection from the palette, where no row is right-clicked', async () => {
    setModsEnabled.mockResolvedValue({ applied: true, outcome: { landed: ['Mod A'], refused: [] } });

    registerModEnableCommands(access, instance, () => [modA], recordingReporter());
    await invoke('modbench.mod.enable');

    expect(setModsEnabled).toHaveBeenCalledWith(access, 'Default', ['Mod A'], true);
  });

  it('calls nothing and reports nothing for an empty selection', async () => {
    const reporter = recordingReporter();

    registerModEnableCommands(access, instance, () => [], reporter);
    await invoke('modbench.mod.enable');

    expect(setModsEnabled).not.toHaveBeenCalled();
    expect(reporter.reports).toEqual([]);
  });

  it('says nothing when the whole selection lands', async () => {
    setModsEnabled.mockResolvedValue({ applied: true, outcome: { landed: ['Mod A'], refused: [] } });
    const reporter = recordingReporter();

    registerModEnableCommands(access, instance, () => [], reporter);
    await invoke('modbench.mod.enable', modA);

    expect(reporter.reports).toEqual([]);
  });

  it('reports a gone mod by name through the shared selectionOutcome reporter, once, while the rest land', async () => {
    setModsEnabled.mockResolvedValue({
      applied: true,
      outcome: { landed: ['Mod A'], refused: [{ item: 'Mod B', reason: 'Mod not found in modlist: Mod B' }] },
    });
    const reporter = recordingReporter();

    registerModEnableCommands(access, instance, () => [], reporter);
    await invoke('modbench.mod.enable', modA, [modA, modB]);

    expect(reporter.reports).toEqual([{
      severity: 'error',
      message: 'Could not enable 1 of 2 mods.',
      detail: '"Mod B" (Mod not found in modlist: Mod B)',
    }]);
  });

  it('reports a global refusal once, naming no mod, when a cause no mod can escape, an unreadable modlist.txt, stops the whole selection before any write', async () => {
    setModsEnabled.mockResolvedValue({ applied: false, refusal: 'ENOENT: modlist.txt' });
    const reporter = recordingReporter();

    registerModEnableCommands(access, instance, () => [], reporter);
    await invoke('modbench.mod.disable', modB);

    expect(reporter.reports).toEqual([
      { severity: 'error', message: 'Failed to disable mods.', detail: 'ENOENT: modlist.txt' },
    ]);
  });
});

describe('modbench.mod.move: the selection of mods or of separators, to a picked place', () => {
  beforeEach(() => { vi.clearAllMocks(); progressSteps.length = 0; });

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
  const pickedLabels = (): string[] => {
    const [items] = present(showQuickPick.mock.calls[0], 'the one showQuickPick call');
    return items.map((item) => item.label);
  };
  const pickLabelled = (label: string) => showQuickPick.mockImplementationOnce(
    (items: readonly { label: string }[]) => Promise.resolve(items.find((i) => i.label === label)));

  it('right-clicked on a mod in a mixed selection, moves only the mods to the picked separator', async () => {
    pickLabelled('Group B');
    moveMods.mockResolvedValue({ applied: true, outcome: { landed: ['Mod A', 'Mod C'], refused: [] } });

    registerModMoveCommand(access, instance, losingAtTop, recordingReporter());
    await invoke('modbench.mod.move', modA, [modA, groupB, modC]);

    expect(pickedLabels()).toEqual(['Ungrouped', 'Group B', 'Group A']);
    expect(moveMods).toHaveBeenCalledWith(
      access, 'Default', ['Mod A', 'Mod C'], { kind: 'separator', name: 'Group B' }, 'losing');
    expect(moveSeparators).not.toHaveBeenCalled();
  });

  it('right-clicked on a separator in a mixed selection, moves only the separators above the picked one', async () => {
    pickLabelled('Group A');
    moveSeparators.mockResolvedValue({ applied: true, outcome: { landed: ['Group B'], refused: [] } });

    registerModMoveCommand(access, instance, losingAtTop, recordingReporter());
    await invoke('modbench.mod.move', groupB, [modA, groupB]);

    expect(pickedLabels()).toEqual(['Group A']);
    expect(moveSeparators).toHaveBeenCalledWith(access, 'Default', ['Group B'], { kind: 'separator', name: 'Group A' }, 'losing');
    expect(moveMods).not.toHaveBeenCalled();
  });

  it('with winning at the top, lands mods and separators toward the winning end, as the view shows it', async () => {
    const winningAtTop = { selection: () => [], direction: () => 'winningAtTop' as const };
    moveMods.mockResolvedValue({ applied: true, outcome: { landed: ['Mod C'], refused: [] } });
    moveSeparators.mockResolvedValue({ applied: true, outcome: { landed: ['Group B'], refused: [] } });

    registerModMoveCommand(access, instance, winningAtTop, recordingReporter());
    pickLabelled('Group A');
    await invoke('modbench.mod.move', modC);
    pickLabelled('Group A');
    await invoke('modbench.mod.move', groupB);

    expect(moveMods).toHaveBeenCalledWith(access, 'Default', ['Mod C'], { kind: 'separator', name: 'Group A' }, 'winning');
    expect(moveSeparators).toHaveBeenCalledWith(access, 'Default', ['Group B'], { kind: 'separator', name: 'Group A' }, 'winning');
  });

  it('handed a target, as a drop hands one, moves there without a pick', async () => {
    moveMods.mockResolvedValue({ applied: true, outcome: { landed: ['Mod C'], refused: [] } });
    moveSeparators.mockResolvedValue({ applied: true, outcome: { landed: ['Group B'], refused: [] } });

    registerModMoveCommand(access, instance, losingAtTop, recordingReporter());
    await invoke('modbench.mod.move', modC, [modC], { place: { kind: 'mod', name: 'Mod A' }, end: 'winning' });
    await invoke('modbench.mod.move', groupB, [groupB], { place: { kind: 'modOrder' }, end: 'winning' });

    expect(showQuickPick).not.toHaveBeenCalled();
    expect(moveMods).toHaveBeenCalledWith(access, 'Default', ['Mod C'], { kind: 'mod', name: 'Mod A' }, 'winning');
    expect(moveSeparators).toHaveBeenCalledWith(access, 'Default', ['Group B'], { kind: 'modOrder' }, 'winning');
  });

  it('handed a target no separator can take, refuses it once, saying why, and moves nothing', async () => {
    const reporter = recordingReporter();

    registerModMoveCommand(access, instance, losingAtTop, reporter);
    await invoke('modbench.mod.move', groupB, [groupB], { place: { kind: 'mod', name: 'Mod A' }, end: 'losing' });

    expect(showQuickPick).not.toHaveBeenCalled();
    expect(moveSeparators).not.toHaveBeenCalled();
    expect(reporter.reports).toEqual([{
      severity: 'error', message: 'Failed to move separators.',
      detail: 'A separator lands beside another separator or at an end of mod order, never beside a mod or among the ungrouped mods.',
    }]);
  });

  it('offers the places in the order the view shows them', async () => {
    showQuickPick.mockResolvedValueOnce(undefined);

    registerModMoveCommand(
      access, instance, { selection: () => [], direction: () => 'winningAtTop' }, recordingReporter());
    await invoke('modbench.mod.move', modC);

    expect(pickedLabels()).toEqual(['Ungrouped', 'Group A', 'Group B']);
  });

  it('from the palette over a selection mixing mods and separators, moves nothing and says nothing', async () => {
    const reporter = recordingReporter();

    registerModMoveCommand(access, instance, { ...losingAtTop, selection: () => [modA, groupA] }, reporter);
    await invoke('modbench.mod.move');

    expect(showQuickPick).not.toHaveBeenCalled();
    expect(moveMods).not.toHaveBeenCalled();
    expect(moveSeparators).not.toHaveBeenCalled();
    expect(reporter.reports).toEqual([]);
  });

  it('Esc at the pick moves nothing and says nothing', async () => {
    showQuickPick.mockResolvedValueOnce(undefined);
    const reporter = recordingReporter();

    registerModMoveCommand(access, instance, losingAtTop, reporter);
    await invoke('modbench.mod.move', modA);

    expect(moveMods).not.toHaveBeenCalled();
    expect(reporter.reports).toEqual([]);
  });

  it('Esc at the separator pick moves nothing and says nothing', async () => {
    showQuickPick.mockResolvedValueOnce(undefined);
    const reporter = recordingReporter();

    registerModMoveCommand(access, instance, losingAtTop, reporter);
    await invoke('modbench.mod.move', groupB);

    expect(showQuickPick).toHaveBeenCalledOnce();
    expect(moveSeparators).not.toHaveBeenCalled();
    expect(reporter.reports).toEqual([]);
  });

  it('reports a gone mod by name, once, while the others land', async () => {
    pickLabelled('Ungrouped');
    moveMods.mockResolvedValue({
      applied: true,
      outcome: { landed: ['Mod A'], refused: [{ item: 'Mod C', reason: 'Mod not found in modlist: Mod C' }] },
    });
    const reporter = recordingReporter();

    registerModMoveCommand(access, instance, losingAtTop, reporter);
    await invoke('modbench.mod.move', modA, [modA, modC]);

    expect(reporter.reports).toEqual([{
      severity: 'error', message: 'Could not move 1 of 2 mods.', detail: '"Mod C" (Mod not found in modlist: Mod C)',
    }]);
  });

  it('reports a refusal of the whole selection once', async () => {
    pickLabelled('Group A');
    moveSeparators.mockResolvedValue({ applied: false, refusal: 'ENOENT: modlist.txt' });
    const reporter = recordingReporter();

    registerModMoveCommand(access, instance, losingAtTop, reporter);
    await invoke('modbench.mod.move', groupB);

    expect(reporter.reports).toEqual([
      { severity: 'error', message: 'Failed to move separators.', detail: 'ENOENT: modlist.txt' },
    ]);
  });
});

describe('open folder: one command for a mod, the Overwrite row, a file and a folder', () => {
  beforeEach(() => { vi.clearAllMocks(); progressSteps.length = 0; });

  const instance = {
    ...instanceThatReads,
    value: instanceValueFixture({
      paths: { overwriteDir: '/instance/overwrite', downloadsDir: '', modDirs: new Map([['My Mod', '/instance/mods/My Mod']]) },
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

  it.each<[string, ModlistNode, string]>([
    ['mod', new ModNode({ kind: 'mod', name: 'My Mod', enabled: true }), '/instance/mods/My Mod'],
    ['Overwrite', new OverwriteNode([], 'MO2'), '/instance/overwrite'],
  ])('reveals the one selected %s row\'s folder from the palette, which hands the gesture no row', async (_kind, selected, folder) => {
    registerOpenFolderCommand(instance, recordingReporter(), () => [selected]);
    await invoke('modbench.mod.openFolder');

    expect(revealed()).toEqual([folder]);
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
  const linked = { relativePath: 'textures/a.dds', path: '/instance/mods/My Mod/textures/a.dds', sourcePath: '/elsewhere/a.dds', excluded: false, excludedByName: false };
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

  const instance = { ...instanceThatReads, value: instanceValueFixture({ nexusSlug: 'skyrimspecialedition' }) };
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
    const file = { relativePath: 'textures/armour/a.dds', path: '/instance/mods/Armour/textures/armour/a.dds', sourcePath: '/instance/mods/Armour/textures/armour/a.dds', excluded: false, excludedByName: false };
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
    modRow, origin, { relativePath, path: `/instance/mods/M/${relativePath}`, sourcePath: `/instance/mods/M/${relativePath}`, excluded, excludedByName: excluded },
    relativePath);
  const included = fileRow('a.dds', false);
  const excluded = fileRow('b.dds.mohidden', true);
  const refOf = (row: FileNode) => ({ origin: row.origin, relativePath: row.file.relativePath });

  it('excludes each selected file its own name leaves included, and leaves the rest alone', async () => {
    markFiles.mockResolvedValue({ landed: [], refused: [] });
    const reporter = recordingReporter();

    registerFileExclusionCommands(access, instanceThatReads, () => [], reporter);
    await invoke('modbench.mod.excludeFile', included, [included, excluded, modRow]);

    expect(markFiles).toHaveBeenCalledWith(access, [refOf(included)], 'Excluded');
    expect(reporter.reports).toEqual([]);
  });

  it('includes the view\'s selection from the palette, where no row is right-clicked', async () => {
    markFiles.mockResolvedValue({ landed: [], refused: [] });

    registerFileExclusionCommands(access, instanceThatReads, () => [excluded], recordingReporter());
    await invoke('modbench.mod.includeFile');

    expect(markFiles).toHaveBeenCalledWith(access, [refOf(excluded)], 'Included');
  });

  it('reports each refused file by its mod and path, once, out of the files it wrote, while the rest land', async () => {
    const gone = fileRow('c.dds', false);
    markFiles.mockResolvedValue({ landed: [], refused: [{ item: refOf(gone), reason: '"c.dds" is gone from disk.' }] });
    const reporter = recordingReporter();

    registerFileExclusionCommands(access, instanceThatReads, () => [], reporter);
    await invoke('modbench.mod.excludeFile', included, [included, excluded, gone]);

    expect(reporter.reports).toEqual([{
      severity: 'error', message: 'Could not exclude 1 of 2 files.', detail: '"M/c.dds" ("c.dds" is gone from disk.)',
    }]);
  });

  it.each([
    ['excludeFile', 'Excluded', included, 'x.mohidden/c.dds'], ['includeFile', 'Included', excluded, 'x.mohidden/d.dds.mohidden'],
  ] as const)('%s takes a file its folder excludes by its own name, leaving alone the one already so', async (verb, mark, clicked, changed) => {
    const hidingFolder = new FolderNode(
      modRow, origin, { relativePath: 'x.mohidden', path: '/instance/mods/M/x.mohidden', excluded: true }, [], [], 'x.mohidden');
    const inFolder = (relativePath: string, excludedByName: boolean) => new FileNode(hidingFolder, origin,
      { relativePath, path: `/instance/mods/M/${relativePath}`, sourcePath: `/instance/mods/M/${relativePath}`, excluded: true, excludedByName },
      relativePath);
    markFiles.mockResolvedValue({ landed: [], refused: [] });
    const reporter = recordingReporter();

    registerFileExclusionCommands(access, instanceThatReads, () => [], reporter);
    await invoke(`modbench.mod.${verb}`, clicked, [clicked, inFolder('x.mohidden/c.dds', false), inFolder('x.mohidden/d.dds.mohidden', true)]);

    expect(markFiles).toHaveBeenCalledWith(access, [refOf(clicked), { origin, relativePath: changed }], mark);
    expect(reporter.reports).toEqual([]);
  });

  it('calls nothing and reports nothing over a selection with no file', async () => {
    const reporter = recordingReporter();

    registerFileExclusionCommands(access, instanceThatReads, () => [modRow], reporter);
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
  const written = (write: ReturnType<typeof vi.fn>, result: unknown) =>
    write.mockImplementation(() => { progressSteps.push('write'); return Promise.resolve(result); });
  const landed = { applied: true, outcome: { landed: ['Mod A'], refused: [] } };
  const endsOnTheRead = ['progress opens on modbench.modList', 'write', 'Instance loader: read every file again', 'progress closes'];

  it('enable', async () => {
    written(setModsEnabled, landed);
    registerModEnableCommands(access, instance, () => [], recordingReporter());

    await invoke('modbench.mod.enable', modA);

    expect(progressSteps).toEqual(endsOnTheRead);
  });

  it('a refused enable still ends on the read', async () => {
    written(setModsEnabled, { applied: false, refusal: 'unreadable' });
    registerModEnableCommands(access, instance, () => [], recordingReporter());

    await invoke('modbench.mod.enable', modA);

    expect(progressSteps).toEqual(endsOnTheRead);
  });

  it('a selection runs its command once, then one read', async () => {
    const modB = new ModNode({ kind: 'mod', name: 'Mod B', enabled: true });
    written(setModsEnabled, landed);
    registerModEnableCommands(access, instance, () => [], recordingReporter());

    await invoke('modbench.mod.disable', modA, [modA, modB]);

    expect(progressSteps).toEqual(endsOnTheRead);
    expect(setModsEnabled).toHaveBeenCalledTimes(1);
  });

  it('move', async () => {
    written(moveMods, landed);
    registerModMoveCommand(access, instance, { selection: () => [], direction: () => 'losingAtTop' }, recordingReporter());

    await invoke('modbench.mod.move', modA, [modA], { place: { kind: 'ungrouped' }, end: 'losing' });

    expect(progressSteps).toEqual(endsOnTheRead);
  });

  it('uninstall', async () => {
    written(uninstallMods, { applied: true, outcome: { landed: [{ name: 'Mod A' }], refused: [] } });
    registerModContextCommands({
      access, instance, viewSelection: () => [], reporter: recordingReporter(), ask: scriptedDialog('Uninstall'),
      trash: vi.fn(), log: vi.fn(),
    });

    await invoke('modbench.mod.uninstall', modA);

    expect(progressSteps).toEqual(endsOnTheRead);
  });

  it('separator delete', async () => {
    written(deleteSeparators, { applied: true, outcome: { landed: [{ name: 'Group A' }], refused: [] } });
    registerSeparatorCommands(access, instance, recordingReporter(), scriptedDialog('Delete'), vi.fn(), () => []);

    await invoke('modbench.separator.delete', groupA);

    expect(progressSteps).toEqual(endsOnTheRead);
  });

  it('separator rename', async () => {
    showInputBox.mockResolvedValueOnce('Renamed');
    written(renameSeparator, { applied: true });
    registerSeparatorCommands(access, instance, recordingReporter(), scriptedDialog(), vi.fn(), () => []);

    await invoke('modbench.separator.rename', groupA);

    expect(progressSteps).toEqual(endsOnTheRead);
  });

  it('separator add', async () => {
    showInputBox.mockResolvedValueOnce('New Group');
    written(insertSeparator, { applied: true });
    registerSeparatorCommands(access, instance, recordingReporter(), scriptedDialog(), vi.fn(), () => []);

    await invoke('modbench.separator.add', groupA);

    expect(progressSteps).toEqual(endsOnTheRead);
  });

  it('create empty mod', async () => {
    showInputBox.mockResolvedValueOnce('New Mod');
    written(createEmptyMod, { applied: true, wrote: true });
    registerCreateEmptyModCommand(access, instance, recordingReporter());

    await invoke('modbench.mod.createEmpty');

    expect(progressSteps).toEqual(endsOnTheRead);
  });

  it('exclude file', async () => {
    const fileRow = new FileNode(
      modA, { kind: 'mod', name: 'Mod A' },
      { relativePath: 'a.dds', path: '/a.dds', sourcePath: '/a.dds', excluded: false, excludedByName: false }, 'a.dds');
    written(markFiles, { landed: [], refused: [] });
    registerFileExclusionCommands(access, instance, () => [], recordingReporter());

    await invoke('modbench.mod.excludeFile', fileRow);

    expect(progressSteps).toEqual(endsOnTheRead);
  });
});
