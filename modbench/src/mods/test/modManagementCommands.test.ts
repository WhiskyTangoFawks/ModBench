import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TreeItem, TreeItemCollapsibleState, TreeItemCheckboxState, EventEmitter, ThemeIcon, ThemeColor, MarkdownString, uriFile } from '../../test/vscodeMock';

// Narrow enough for what these tests read back off a call: the prompt text and its own
// validateInput, the one seam a prompt-refusal test can reach without a real VS Code window.
interface InputBoxOptionsDouble {
  prompt?: string;
  value?: string;
  placeHolder?: string;
  validateInput?: (value: string) => string | undefined;
}

const { registerCommand, executeCommand, showOpenDialog, showInputBox, showQuickPick, openExternal } = vi.hoisted(() => ({
  registerCommand: vi.fn((_id: string, handler: (...args: unknown[]) => unknown) => ({ dispose: vi.fn(), handler })),
  executeCommand: vi.fn((_command: string, _uri?: { fsPath: string }) => Promise.resolve()),
  showOpenDialog: vi.fn(),
  showInputBox: vi.fn<(options?: InputBoxOptionsDouble) => Promise<string | undefined>>(),
  showQuickPick: vi.fn(),
  openExternal: vi.fn(),
}));

vi.mock('vscode', () => ({
  commands: { registerCommand, executeCommand },
  window: { showOpenDialog, showInputBox, showQuickPick },
  env: { openExternal },
  TreeItem, TreeItemCollapsibleState, TreeItemCheckboxState, EventEmitter, ThemeIcon, ThemeColor, MarkdownString,
  Uri: { file: uriFile, parse: (s: string) => ({ toString: () => s }) },
}));

const { installFromArchive, installFromFolder } = vi.hoisted(() => ({
  installFromArchive: vi.fn(),
  installFromFolder: vi.fn(),
}));

vi.mock('../../install/install', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../install/install')>()),
  installFromArchive, installFromFolder,
}));

const {
  uninstallMods, deleteSeparators, renameSeparator, insertSeparator, createEmptyMod, setModsEnabled, moveMods, moveSeparators,
} = vi.hoisted(() => ({
  uninstallMods: vi.fn(), deleteSeparators: vi.fn(), renameSeparator: vi.fn(), insertSeparator: vi.fn(),
  createEmptyMod: vi.fn(), setModsEnabled: vi.fn(), moveMods: vi.fn(), moveSeparators: vi.fn(),
}));

vi.mock('../../modlist/modlist', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../modlist/modlist')>()),
  createEmptyMod, deleteSeparators, insertSeparator,
  moveMods, moveSeparators, renameSeparator, uninstallMods, setModsEnabled,
}));

import {
  registerCreateEmptyModCommand, registerModContextCommands, registerModEnableCommands, registerModInstallCommands,
  registerModMoveCommand,
  registerModListCoreCommands, registerOpenFolderCommand, registerSeparatorCommands, registerViewOnNexusCommand,
  modsCopyValueText,
  type ModInstallDeps,
} from '../modManagementCommands';
import { ModNode, OverwriteNode, SeparatorNode, type ModlistNode } from '../ModListProvider';
import { ARCHIVE_EXTENSIONS } from '../../install/install';
import { DownloadNode } from '../../downloads/DownloadsProvider';
import { recordingReporter, scriptedDialog, assertAskedOnce } from '../../test/surfacingDoubles';
import { present } from '../../ports/present';
import { instanceValueFixture } from '../../test/mo2/instanceValueFixture';
import { downloadRowFixture } from '../../test/mo2/downloadRowFixture';

function invoke(commandId: string, ...args: unknown[]): Promise<unknown> {
  const call = registerCommand.mock.calls.find((c) => c[0] === commandId);
  if (!call) throw new Error(`command not registered: ${commandId}`);
  return Promise.resolve(call[1](...args));
}


// Deliberately not the fixture's usual game: a gameName hardcoded at the call site would pass
// against Fallout 4 and reach meta.ini wrong for every other install.
const GAME_RELEASE = 'Skyrim Special Edition';

function deps(over: Partial<ModInstallDeps> = {}): ModInstallDeps {
  return {
    instanceRoot: '/instance',
    instance: { value: instanceValueFixture({ gameRelease: GAME_RELEASE }) },
    runModAction: async (_label, _fail, action) => action(),
    promptModName: vi.fn(),
    warnIfFomod: vi.fn(),
    ...over,
  };
}

describe('the sort direction', () => {
  beforeEach(() => vi.clearAllMocks());

  const directionKeys = () => executeCommand.mock.calls
    .filter((c) => c[0] === 'setContext' && (c as unknown[])[1] === 'modbench.mod.winningAtTop')
    .map((c) => (c as unknown[])[2]);

  // A context key outlives an extension host restart; the provider's direction does not.
  it('starts losing at the top, and the title-bar icon agrees', () => {
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

describe('modbench.mod.install: archive or folder, asked first', () => {
  beforeEach(() => vi.clearAllMocks());

  it('Esc at the archive-or-folder pick installs nothing', async () => {
    showQuickPick.mockResolvedValueOnce(undefined);

    registerModInstallCommands(deps());
    const succeeded = await invoke('modbench.mod.install');

    expect(showOpenDialog).not.toHaveBeenCalled();
    expect(succeeded).toEqual({ installed: false });
  });

  it('asks archive or folder before either OS picker opens', async () => {
    showQuickPick.mockResolvedValueOnce({ sourceKind: 'archive' });
    showOpenDialog.mockResolvedValueOnce(undefined);

    registerModInstallCommands(deps());
    await invoke('modbench.mod.install');

    expect(showQuickPick).toHaveBeenCalledWith(
      [expect.objectContaining({ sourceKind: 'archive' }), expect.objectContaining({ sourceKind: 'folder' })],
      expect.anything(),
    );
    const [quickPickOrder] = showQuickPick.mock.invocationCallOrder;
    const [openDialogOrder] = showOpenDialog.mock.invocationCallOrder;
    if (quickPickOrder === undefined || openDialogOrder === undefined) {
      throw new Error('expected both showQuickPick and showOpenDialog to have been called');
    }
    expect(quickPickOrder).toBeLessThan(openDialogOrder);
  });

  it('archive: Esc at the OS picker installs nothing', async () => {
    showQuickPick.mockResolvedValueOnce({ sourceKind: 'archive' });
    showOpenDialog.mockResolvedValueOnce(undefined);

    registerModInstallCommands(deps());
    const succeeded = await invoke('modbench.mod.install');

    expect(installFromArchive).not.toHaveBeenCalled();
    expect(succeeded).toEqual({ installed: false });
  });

  // The picker's filters name install's own extension list, never a copy of it: a rival that
  // hardcodes its own array here would drift silently the day install's list changes.
  it('archive: the OS picker offers install\'s own archive extensions', async () => {
    const promptModName = vi.fn().mockResolvedValueOnce('New Mod');
    showQuickPick.mockResolvedValueOnce({ sourceKind: 'archive' });
    showOpenDialog.mockResolvedValueOnce([{ fsPath: '/somewhere/foo.zip' }]);
    installFromArchive.mockResolvedValueOnce({ applied: true, wrote: true, isFomod: false });

    registerModInstallCommands(deps({ promptModName }));
    await invoke('modbench.mod.install');

    expect(showOpenDialog).toHaveBeenCalledWith(expect.objectContaining({
      filters: { 'Mod archives': [...ARCHIVE_EXTENSIONS] },
    }));
  });

  it('archive: installs as a new mod under the name prompted, prefilled from the archive', async () => {
    const promptModName = vi.fn().mockResolvedValueOnce('New Mod');
    showQuickPick.mockResolvedValueOnce({ sourceKind: 'archive' });
    showOpenDialog.mockResolvedValueOnce([{ fsPath: '/archive/foo.7z' }]);
    installFromArchive.mockResolvedValueOnce({ applied: true, wrote: true, isFomod: false });

    registerModInstallCommands(deps({ promptModName }));
    const succeeded = await invoke('modbench.mod.install');

    expect(promptModName).toHaveBeenCalledWith('foo', expect.any(Function));
    expect(installFromArchive).toHaveBeenCalledWith(
      '/instance', { kind: 'new', name: 'New Mod' }, '/archive/foo.7z', { gameName: GAME_RELEASE },
    );
    expect(succeeded).toEqual({ installed: true });
  });

  it('archive: a cancelled name prompt installs nothing', async () => {
    const promptModName = vi.fn().mockResolvedValueOnce(undefined);
    showQuickPick.mockResolvedValueOnce({ sourceKind: 'archive' });
    showOpenDialog.mockResolvedValueOnce([{ fsPath: '/archive/foo.7z' }]);

    registerModInstallCommands(deps({ promptModName }));
    const succeeded = await invoke('modbench.mod.install');

    expect(installFromArchive).not.toHaveBeenCalled();
    expect(succeeded).toEqual({ installed: false });
  });

  it('folder: Esc at the OS picker installs nothing', async () => {
    showQuickPick.mockResolvedValueOnce({ sourceKind: 'folder' });
    showOpenDialog.mockResolvedValueOnce(undefined);

    registerModInstallCommands(deps());
    const succeeded = await invoke('modbench.mod.install');

    expect(installFromFolder).not.toHaveBeenCalled();
    expect(succeeded).toEqual({ installed: false });
  });

  it('folder: installs as a new mod under the name prompted, prefilled from the folder', async () => {
    const promptModName = vi.fn().mockResolvedValueOnce('New Mod');
    showQuickPick.mockResolvedValueOnce({ sourceKind: 'folder' });
    showOpenDialog.mockResolvedValueOnce([{ fsPath: '/somewhere/Loose Files' }]);
    installFromFolder.mockResolvedValueOnce({ applied: true, wrote: true, isFomod: false });

    registerModInstallCommands(deps({ promptModName }));
    const succeeded = await invoke('modbench.mod.install');

    expect(showOpenDialog).toHaveBeenCalledWith(expect.objectContaining({
      canSelectFiles: false, canSelectFolders: true, canSelectMany: false,
    }));
    expect(promptModName).toHaveBeenCalledWith('Loose Files', expect.any(Function));
    expect(installFromFolder).toHaveBeenCalledWith(
      '/instance', { kind: 'new', name: 'New Mod' }, '/somewhere/Loose Files', { gameName: GAME_RELEASE },
    );
    expect(succeeded).toEqual({ installed: true });
  });
});

describe('modbench.mod.createEmpty: the prompt refuses in install\'s own words', () => {
  beforeEach(() => vi.clearAllMocks());

  const instance = { value: instanceValueFixture({ activeProfile: 'Default', mods: [{ kind: 'mod', name: 'Existing Mod', enabled: true }] }) };

  it('Esc creates nothing', async () => {
    showInputBox.mockResolvedValueOnce(undefined);
    const reporter = recordingReporter();

    registerCreateEmptyModCommand('/instance', instance, reporter);
    await invoke('modbench.mod.createEmpty');

    expect(createEmptyMod).not.toHaveBeenCalled();
    expect(reporter.reports).toEqual([]);
  });

  it('the prompt\'s validateInput refuses a taken name, in the words collidingModName gives install', async () => {
    registerCreateEmptyModCommand('/instance', instance, recordingReporter());
    await invoke('modbench.mod.createEmpty');

    const [options] = showInputBox.mock.calls[0] ?? [];
    const validateInput = options?.validateInput;
    if (!validateInput) throw new Error('expected validateInput on the input box options');
    expect(validateInput('Existing Mod')).toMatch(/"Existing Mod" already exists/);
    expect(validateInput('A New Name')).toBeUndefined();
  });

  it('creates the folder and its line, and reports nothing when both land', async () => {
    showInputBox.mockResolvedValueOnce('New Mod');
    createEmptyMod.mockResolvedValueOnce({ applied: true, wrote: true });
    const reporter = recordingReporter();

    registerCreateEmptyModCommand('/instance', instance, reporter);
    await invoke('modbench.mod.createEmpty');

    expect(createEmptyMod).toHaveBeenCalledWith('/instance', 'Default', 'New Mod', instance.value.modFolders ?? []);
    expect(reporter.reports).toEqual([]);
  });

  it('reports a landed-but-partial line failure as a warning, not a failed create', async () => {
    showInputBox.mockResolvedValueOnce('New Mod');
    createEmptyMod.mockResolvedValueOnce({ applied: true, wrote: false, lineRefusal: 'disk full' });
    const reporter = recordingReporter();

    registerCreateEmptyModCommand('/instance', instance, reporter);
    await invoke('modbench.mod.createEmpty');

    expect(reporter.reports).toEqual([{
      severity: 'warning',
      message: '"New Mod" was created, but its modlist.txt line could not be written.',
      detail: 'disk full',
    }]);
  });

  it('reports a name-collision refusal as a failed create', async () => {
    showInputBox.mockResolvedValueOnce('New Mod');
    createEmptyMod.mockResolvedValueOnce({ applied: false, refusal: 'A mod named "New Mod" already exists.' });
    const reporter = recordingReporter();

    registerCreateEmptyModCommand('/instance', instance, reporter);
    await invoke('modbench.mod.createEmpty');

    expect(reporter.reports).toEqual([{
      severity: 'error',
      message: 'Failed to create "New Mod".',
      detail: 'A mod named "New Mod" already exists.',
    }]);
  });
});


// Uninstall is the Mods tree's one destructive gesture, over the whole selection.
// ADR-0019's dialog and reporting seams.
describe('registerModContextCommands: modbench.mod.uninstall over the selection', () => {
  beforeEach(() => vi.clearAllMocks());

  const instance = { value: instanceValueFixture({ activeProfile: 'Default' }) };
  const trash = vi.fn(() => Promise.resolve());
  const log = vi.fn();
  const modA = new ModNode({ kind: 'mod', name: 'Mod A', enabled: true, archiveFilename: 'mod-a.7z' });
  const modB = new ModNode({ kind: 'mod', name: 'Mod B', enabled: true });

  it('asks one modal naming the mod, then uninstalls it once confirmed', async () => {
    uninstallMods.mockResolvedValueOnce({ applied: true, outcome: { landed: [{ name: 'Mod A' }], refused: [] } });
    const ask = scriptedDialog('Uninstall');

    registerModContextCommands('/instance', instance, () => [], recordingReporter(), ask, trash, log);
    await invoke('modbench.mod.uninstall', modA);

    expect(ask.asked).toEqual([{
      message: 'Uninstall "Mod A"? Its folder will be moved to the system trash.',
      detail: undefined,
      buttons: ['Uninstall'],
    }]);
    expect(uninstallMods).toHaveBeenCalledWith(
      '/instance', 'Default', [{ name: 'Mod A', archiveFilename: 'mod-a.7z' }], trash);
  });

  it('asks one modal listing every mod, for a selection of several', async () => {
    uninstallMods.mockResolvedValueOnce({
      applied: true, outcome: { landed: [{ name: 'Mod A' }, { name: 'Mod B' }], refused: [] },
    });
    const ask = scriptedDialog('Uninstall');

    registerModContextCommands('/instance', instance, () => [], recordingReporter(), ask, trash, log);
    await invoke('modbench.mod.uninstall', modA, [modA, modB]);

    assertAskedOnce(ask, { messageContains: '"Mod A", "Mod B"', buttons: ['Uninstall'] });
    expect(ask.asked[0]?.message).toContain('Their folders will be moved to the system trash.');
    expect(uninstallMods).toHaveBeenCalledWith(
      '/instance', 'Default',
      [{ name: 'Mod A', archiveFilename: 'mod-a.7z' }, { name: 'Mod B', archiveFilename: undefined }],
      trash,
    );
  });

  it('uninstalls nothing when the modal is dismissed', async () => {
    uninstallMods.mockResolvedValue({ applied: true, outcome: { landed: [], refused: [] } });

    registerModContextCommands('/instance', instance, () => [], recordingReporter(), scriptedDialog(undefined), trash, log);
    await invoke('modbench.mod.uninstall', modA);

    expect(uninstallMods).not.toHaveBeenCalled();
  });

  it('takes the whole selection, not the right-clicked row alone', async () => {
    uninstallMods.mockResolvedValueOnce({
      applied: true, outcome: { landed: [{ name: 'Mod A' }, { name: 'Mod B' }], refused: [] },
    });

    registerModContextCommands('/instance', instance, () => [], recordingReporter(), scriptedDialog('Uninstall'), trash, log);
    await invoke('modbench.mod.uninstall', modA, [modA, modB]);

    expect(uninstallMods.mock.calls).toEqual([[
      '/instance', 'Default',
      [{ name: 'Mod A', archiveFilename: 'mod-a.7z' }, { name: 'Mod B', archiveFilename: undefined }],
      trash,
    ]]);
  });

  it('falls back to the view selection from a key, where no row is right-clicked', async () => {
    uninstallMods.mockResolvedValueOnce({ applied: true, outcome: { landed: [{ name: 'Mod A' }], refused: [] } });

    registerModContextCommands('/instance', instance, () => [modA], recordingReporter(), scriptedDialog('Uninstall'), trash, log);
    await invoke('modbench.mod.uninstall');

    expect(uninstallMods).toHaveBeenCalledWith(
      '/instance', 'Default', [{ name: 'Mod A', archiveFilename: 'mod-a.7z' }], trash);
  });

  it('an empty selection asks nothing and uninstalls nothing', async () => {
    const ask = scriptedDialog('Uninstall');

    registerModContextCommands('/instance', instance, () => [], recordingReporter(), ask, trash, log);
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

    registerModContextCommands('/instance', instance, () => [], reporter, scriptedDialog('Uninstall'), trash, log);
    await invoke('modbench.mod.uninstall', modA, [modA, modB]);

    expect(reporter.reports).toEqual([{
      severity: 'error', message: 'Could not uninstall 1 of 2 mods.', detail: '"Mod B" (trash unavailable)',
    }]);
  });

  it('reports a refusal of the whole selection once, when modlist.txt cannot be read at all', async () => {
    uninstallMods.mockResolvedValueOnce({ applied: false, refusal: 'ENOENT: modlist.txt' });
    const reporter = recordingReporter();

    registerModContextCommands('/instance', instance, () => [], reporter, scriptedDialog('Uninstall'), trash, log);
    await invoke('modbench.mod.uninstall', modA);

    expect(reporter.reports).toEqual([
      { severity: 'error', message: 'Failed to uninstall mods.', detail: 'ENOENT: modlist.txt' },
    ]);
  });

  it('says nothing extra for a fully landed uninstall with no failed mark', async () => {
    uninstallMods.mockResolvedValueOnce({ applied: true, outcome: { landed: [{ name: 'Mod A' }], refused: [] } });
    const reporter = recordingReporter();

    registerModContextCommands('/instance', instance, () => [], reporter, scriptedDialog('Uninstall'), trash, log);
    await invoke('modbench.mod.uninstall', modA);

    expect(reporter.reports).toEqual([]);
    expect(log).not.toHaveBeenCalled();
  });

  // common.md, Reporting: a failed mark is never a failure notification, and the uninstall it
  // rides on stands landed.
  it('a failed mark is one Output line and no notification; the uninstall it rides on stands landed', async () => {
    uninstallMods.mockResolvedValueOnce({
      applied: true,
      outcome: { landed: [{ name: 'Mod A', markRefusal: 'disk full' }], refused: [] },
    });
    const reporter = recordingReporter();

    registerModContextCommands('/instance', instance, () => [], reporter, scriptedDialog('Uninstall'), trash, log);
    await invoke('modbench.mod.uninstall', modA);

    expect(reporter.reports).toEqual([]);
    expect(log).toHaveBeenCalledWith(
      '"Mod A" was uninstalled, but its downloaded file could not be marked uninstalled: disk full');
  });
});

// mods.md, Delete separator: "A separator delete does not ask: no mod is lost, and the
// separator's folder goes to the trash."
describe('modbench.separator.delete: the whole selection of separators, asked nothing', () => {
  beforeEach(() => vi.clearAllMocks());

  const instance = { value: instanceValueFixture({ activeProfile: 'Default' }) };
  const trash = vi.fn(() => Promise.resolve());
  const groupA = new SeparatorNode({ kind: 'separator', name: 'Group A', enabled: true }, []);
  const groupB = new SeparatorNode({ kind: 'separator', name: 'Group B', enabled: true }, []);
  const modA = new ModNode({ kind: 'mod', name: 'Mod A', enabled: true });

  it('deletes every selected separator in one command, handing it the trash, and says nothing when all land', async () => {
    deleteSeparators.mockResolvedValue({ applied: true, outcome: { landed: ['Group A', 'Group B'], refused: [] } });
    const reporter = recordingReporter();

    registerSeparatorCommands('/instance', instance, reporter, trash, () => []);
    await invoke('modbench.separator.delete', groupB, [groupA, groupB]);

    expect(deleteSeparators.mock.calls).toEqual([['/instance', 'Default', ['Group A', 'Group B'], trash]]);
    expect(reporter.reports).toEqual([]);
  });

  it('takes only the separators of a selection mixing mods and separators', async () => {
    deleteSeparators.mockResolvedValue({ applied: true, outcome: { landed: ['Group A'], refused: [] } });

    registerSeparatorCommands('/instance', instance, recordingReporter(), trash, () => []);
    await invoke('modbench.separator.delete', groupA, [modA, groupA]);

    expect(deleteSeparators.mock.calls).toEqual([['/instance', 'Default', ['Group A'], trash]]);
  });

  it('falls back to the view selection from a key, where no row is right-clicked', async () => {
    deleteSeparators.mockResolvedValue({ applied: true, outcome: { landed: ['Group A', 'Group B'], refused: [] } });

    registerSeparatorCommands('/instance', instance, recordingReporter(), trash, () => [groupA, groupB]);
    await invoke('modbench.separator.delete');

    expect(deleteSeparators.mock.calls).toEqual([['/instance', 'Default', ['Group A', 'Group B'], trash]]);
  });

  it('calls nothing and reports nothing for a selection with no separator', async () => {
    const reporter = recordingReporter();

    registerSeparatorCommands('/instance', instance, reporter, trash, () => [modA]);
    await invoke('modbench.separator.delete');

    expect(deleteSeparators).not.toHaveBeenCalled();
    expect(reporter.reports).toEqual([]);
  });

  it('reports each refused separator, naming why, once, while the others land', async () => {
    deleteSeparators.mockResolvedValue({
      applied: true,
      outcome: { landed: ['Group A'], refused: [{ item: 'Group B', reason: 'trash unavailable' }] },
    });
    const reporter = recordingReporter();

    registerSeparatorCommands('/instance', instance, reporter, trash, () => []);
    await invoke('modbench.separator.delete', groupA, [groupA, groupB]);

    expect(reporter.reports).toEqual([{
      severity: 'error', message: 'Could not delete 1 of 2 separators.', detail: '"Group B" (trash unavailable)',
    }]);
  });

  it('reports a refusal of the whole selection once', async () => {
    deleteSeparators.mockResolvedValue({ applied: false, refusal: 'ENOENT: modlist.txt' });
    const reporter = recordingReporter();

    registerSeparatorCommands('/instance', instance, reporter, trash, () => []);
    await invoke('modbench.separator.delete', groupA, [groupA, groupB]);

    expect(reporter.reports).toEqual([
      { severity: 'error', message: 'Failed to delete separators.', detail: 'ENOENT: modlist.txt' },
    ]);
  });
});

const CLASH = 'A separator with this name already exists';

// The prompt's own options off the one showInputBox call a gesture made.
function promptOptions(): InputBoxOptionsDouble {
  const [call] = showInputBox.mock.calls;
  return present(call?.[0], 'the options of the one prompt the gesture opened');
}

describe('rename separator takes its separator through the gesture entry', () => {
  beforeEach(() => vi.clearAllMocks());

  const instance = {
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

    registerSeparatorCommands('/instance', instance, recordingReporter(), vi.fn(), () => [groupA, groupB]);
    await invoke('modbench.separator.rename', groupB, [groupA, groupB]);

    expect(promptOptions()).toMatchObject({ prompt: 'Rename separator', value: 'Group B' });
    expect(renameSeparator.mock.calls).toEqual([['/instance', 'Default', 'Group B', 'Renamed']]);
  });

  it('refuses in the prompt a name another separator has, and takes its own name or a mod\'s', async () => {
    showInputBox.mockResolvedValueOnce(undefined);

    registerSeparatorCommands('/instance', instance, recordingReporter(), vi.fn(), () => []);
    await invoke('modbench.separator.rename', groupB);

    const validate = present(promptOptions().validateInput, 'the rename prompt\'s validateInput');
    expect(validate('Group A')).toBe(CLASH);
    expect(validate('Group B')).toBeUndefined();
    expect(validate('Mod A')).toBeUndefined();
  });

  it('reports the refusal of a name another separator took after the prompt closed', async () => {
    renameSeparator.mockResolvedValue({ applied: false, refusal: CLASH });
    showInputBox.mockResolvedValueOnce('Taken Meanwhile');
    const reporter = recordingReporter();

    registerSeparatorCommands('/instance', instance, reporter, vi.fn(), () => []);
    await invoke('modbench.separator.rename', groupB);

    expect(reporter.reports).toEqual([{ severity: 'error', message: 'Failed to rename separator.', detail: CLASH }]);
  });

  it('renames nothing when the prompt is cancelled (Esc) or left empty', async () => {
    showInputBox.mockResolvedValueOnce(undefined).mockResolvedValueOnce('');

    registerSeparatorCommands('/instance', instance, recordingReporter(), vi.fn(), () => []);
    await invoke('modbench.separator.rename', groupA);
    await invoke('modbench.separator.rename', groupA);

    expect(renameSeparator).not.toHaveBeenCalled();
  });

  it('renames nothing when the prompt keeps the same name', async () => {
    showInputBox.mockResolvedValueOnce('Group A');

    registerSeparatorCommands('/instance', instance, recordingReporter(), vi.fn(), () => [groupA]);
    await invoke('modbench.separator.rename', groupA);

    expect(renameSeparator).not.toHaveBeenCalled();
  });

  it('asks nothing and renames nothing from the palette, where no row is right-clicked', async () => {
    registerSeparatorCommands('/instance', instance, recordingReporter(), vi.fn(), () => [groupA]);
    await invoke('modbench.separator.rename');

    expect(showInputBox).not.toHaveBeenCalled();
    expect(renameSeparator).not.toHaveBeenCalled();
  });
});

describe('add separator: one command for a mod anchor and a separator anchor', () => {
  beforeEach(() => vi.clearAllMocks());

  const instance = {
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

    registerSeparatorCommands('/instance', instance, recordingReporter(), vi.fn(), () => [otherMod, modA]);
    await invoke('modbench.separator.add', modA, [otherMod, modA]);

    expect(promptOptions()).toMatchObject({ prompt: 'Separator name', placeHolder: 'My Group' });
    expect(insertSeparator.mock.calls).toEqual([['/instance', 'Default', 'New Section', { kind: 'mod', name: 'Mod A' }]]);
  });

  it('refuses in the prompt a name another separator has, and takes a mod\'s', async () => {
    showInputBox.mockResolvedValueOnce(undefined);

    registerSeparatorCommands('/instance', instance, recordingReporter(), vi.fn(), () => []);
    await invoke('modbench.separator.add', modA);

    const validate = present(promptOptions().validateInput, 'the add prompt\'s validateInput');
    expect(validate('Group A')).toBe(CLASH);
    expect(validate(' Group A ')).toBe(CLASH);
    expect(validate('Mod A')).toBeUndefined();
    expect(validate('')).toBeUndefined();
    expect(validate('CON')).toBe('Not a valid separator name: "CON"');
  });

  it('reports the refusal of a name another separator took after the prompt closed', async () => {
    insertSeparator.mockResolvedValue({ applied: false, refusal: CLASH });
    showInputBox.mockResolvedValueOnce('Taken Meanwhile');
    const reporter = recordingReporter();

    registerSeparatorCommands('/instance', instance, reporter, vi.fn(), () => []);
    await invoke('modbench.separator.add', modA);

    expect(reporter.reports).toEqual([{ severity: 'error', message: 'Failed to add separator.', detail: CLASH }]);
  });

  it('prompts and anchors the new separator on the right-clicked separator, not the selection around it', async () => {
    insertSeparator.mockResolvedValue({ applied: true, wrote: true });
    showInputBox.mockResolvedValueOnce('New Section');
    const otherGroup = new SeparatorNode({ kind: 'separator', name: 'Other Group', enabled: true }, []);

    registerSeparatorCommands('/instance', instance, recordingReporter(), vi.fn(), () => [otherGroup, groupA]);
    await invoke('modbench.separator.add', groupA, [otherGroup, groupA]);

    expect(insertSeparator.mock.calls).toEqual([['/instance', 'Default', 'New Section', { kind: 'separator', name: 'Group A' }]]);
  });

  it('adds nothing when the prompt is cancelled (Esc)', async () => {
    showInputBox.mockResolvedValueOnce(undefined);

    registerSeparatorCommands('/instance', instance, recordingReporter(), vi.fn(), () => [modA]);
    await invoke('modbench.separator.add', modA);

    expect(insertSeparator).not.toHaveBeenCalled();
  });

  it('adds nothing for an empty name', async () => {
    showInputBox.mockResolvedValueOnce('');

    registerSeparatorCommands('/instance', instance, recordingReporter(), vi.fn(), () => [modA]);
    await invoke('modbench.separator.add', modA);

    expect(insertSeparator).not.toHaveBeenCalled();
  });

  it('asks nothing and adds nothing from the palette, where no row is right-clicked or focused', async () => {
    registerSeparatorCommands('/instance', instance, recordingReporter(), vi.fn(), () => [modA]);
    await invoke('modbench.separator.add');

    expect(showInputBox).not.toHaveBeenCalled();
    expect(insertSeparator).not.toHaveBeenCalled();
  });
});

// Which command the menu offers, by row state, is package.json's own `when` clause (mods.md,
// Menus and keys, story 3); these tests pin what each command does once invoked.
describe('modbench.mod.enable / modbench.mod.disable: the whole selection, one command per direction', () => {
  beforeEach(() => vi.clearAllMocks());

  const instance = { value: instanceValueFixture({ activeProfile: 'Default' }) };
  const modA = new ModNode({ kind: 'mod', name: 'Mod A', enabled: false });
  const modB = new ModNode({ kind: 'mod', name: 'Mod B', enabled: true });
  const groupA = new SeparatorNode({ kind: 'separator', name: 'Group A', enabled: true }, []);

  it('enable applies to every selected mod, whatever its own current state', async () => {
    setModsEnabled.mockResolvedValue({ applied: true, outcome: { landed: ['Mod A', 'Mod B'], refused: [] } });

    registerModEnableCommands('/instance', instance, () => [], recordingReporter());
    await invoke('modbench.mod.enable', modA, [modA, modB]);

    expect(setModsEnabled).toHaveBeenCalledWith('/instance', 'Default', ['Mod A', 'Mod B'], true);
  });

  it('disable applies to every selected mod, whatever its own current state', async () => {
    setModsEnabled.mockResolvedValue({ applied: true, outcome: { landed: ['Mod A', 'Mod B'], refused: [] } });

    registerModEnableCommands('/instance', instance, () => [], recordingReporter());
    await invoke('modbench.mod.disable', modB, [modA, modB]);

    expect(setModsEnabled).toHaveBeenCalledWith('/instance', 'Default', ['Mod A', 'Mod B'], false);
  });

  it('takes only the mods of a selection mixing mods and separators, anchored on the clicked mod', async () => {
    setModsEnabled.mockResolvedValue({ applied: true, outcome: { landed: ['Mod A'], refused: [] } });

    registerModEnableCommands('/instance', instance, () => [], recordingReporter());
    await invoke('modbench.mod.enable', modA, [modA, groupA]);

    expect(setModsEnabled).toHaveBeenCalledWith('/instance', 'Default', ['Mod A'], true);
  });

  it('falls back to the view selection from the palette, where no row is right-clicked', async () => {
    setModsEnabled.mockResolvedValue({ applied: true, outcome: { landed: ['Mod A'], refused: [] } });

    registerModEnableCommands('/instance', instance, () => [modA], recordingReporter());
    await invoke('modbench.mod.enable');

    expect(setModsEnabled).toHaveBeenCalledWith('/instance', 'Default', ['Mod A'], true);
  });

  it('calls nothing and reports nothing for an empty selection', async () => {
    const reporter = recordingReporter();

    registerModEnableCommands('/instance', instance, () => [], reporter);
    await invoke('modbench.mod.enable');

    expect(setModsEnabled).not.toHaveBeenCalled();
    expect(reporter.reports).toEqual([]);
  });

  it('says nothing when the whole selection lands', async () => {
    setModsEnabled.mockResolvedValue({ applied: true, outcome: { landed: ['Mod A'], refused: [] } });
    const reporter = recordingReporter();

    registerModEnableCommands('/instance', instance, () => [], reporter);
    await invoke('modbench.mod.enable', modA);

    expect(reporter.reports).toEqual([]);
  });

  it('reports a gone mod by name through the shared selectionOutcome reporter, once, while the rest land', async () => {
    setModsEnabled.mockResolvedValue({
      applied: true,
      outcome: { landed: ['Mod A'], refused: [{ item: 'Mod B', reason: 'Mod not found in modlist: Mod B' }] },
    });
    const reporter = recordingReporter();

    registerModEnableCommands('/instance', instance, () => [], reporter);
    await invoke('modbench.mod.enable', modA, [modA, modB]);

    expect(reporter.reports).toEqual([{
      severity: 'error',
      message: 'Could not enable 1 of 2 mods.',
      detail: '"Mod B" (Mod not found in modlist: Mod B)',
    }]);
  });

  // A cause no mod can escape (an unreadable modlist.txt) refuses the whole selection once,
  // before any write — the Core box's own `applied: false`, not a per-item SelectionOutcome.
  it('reports a global refusal once, naming no mod, when the whole selection cannot proceed', async () => {
    setModsEnabled.mockResolvedValue({ applied: false, refusal: 'ENOENT: modlist.txt' });
    const reporter = recordingReporter();

    registerModEnableCommands('/instance', instance, () => [], reporter);
    await invoke('modbench.mod.disable', modB);

    expect(reporter.reports).toEqual([
      { severity: 'error', message: 'Failed to disable mods.', detail: 'ENOENT: modlist.txt' },
    ]);
  });
});

describe('modbench.mod.move: the selection of mods or of separators, to a picked place', () => {
  beforeEach(() => vi.clearAllMocks());

  // modlist.txt order, winning first: Group A holds Mod A, Group B holds Mod B, Mod C is ungrouped.
  const instance = {
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
    const items: unknown = showQuickPick.mock.calls[0]?.[0];
    if (!Array.isArray(items)) return [];
    return items.map((item: unknown) =>
      (typeof item === 'object' && item !== null && 'label' in item ? String(item.label) : ''));
  };
  const pickLabelled = (label: string) => showQuickPick.mockImplementationOnce(
    (items: { label: string }[]) => Promise.resolve(items.find((i) => i.label === label)));

  it('right-clicked on a mod in a mixed selection, moves only the mods to the picked separator', async () => {
    pickLabelled('Group B');
    moveMods.mockResolvedValue({ applied: true, outcome: { landed: ['Mod A', 'Mod C'], refused: [] } });

    registerModMoveCommand('/instance', instance, losingAtTop, recordingReporter());
    await invoke('modbench.mod.move', modA, [modA, groupB, modC]);

    expect(pickedLabels()).toEqual(['Ungrouped', 'Group B', 'Group A']);
    expect(moveMods).toHaveBeenCalledWith(
      '/instance', 'Default', ['Mod A', 'Mod C'], { kind: 'separator', name: 'Group B' }, 'losing');
    expect(moveSeparators).not.toHaveBeenCalled();
  });

  it('right-clicked on a separator in a mixed selection, moves only the separators above the picked one', async () => {
    pickLabelled('Group A');
    moveSeparators.mockResolvedValue({ applied: true, outcome: { landed: ['Group B'], refused: [] } });

    registerModMoveCommand('/instance', instance, losingAtTop, recordingReporter());
    await invoke('modbench.mod.move', groupB, [modA, groupB]);

    expect(pickedLabels()).toEqual(['Group A']);
    expect(moveSeparators).toHaveBeenCalledWith('/instance', 'Default', ['Group B'], { kind: 'separator', name: 'Group A' }, 'losing');
    expect(moveMods).not.toHaveBeenCalled();
  });

  it('with winning at the top, lands mods and separators toward the winning end, as the view shows it', async () => {
    const winningAtTop = { selection: () => [], direction: () => 'winningAtTop' as const };
    moveMods.mockResolvedValue({ applied: true, outcome: { landed: ['Mod C'], refused: [] } });
    moveSeparators.mockResolvedValue({ applied: true, outcome: { landed: ['Group B'], refused: [] } });

    registerModMoveCommand('/instance', instance, winningAtTop, recordingReporter());
    pickLabelled('Group A');
    await invoke('modbench.mod.move', modC);
    pickLabelled('Group A');
    await invoke('modbench.mod.move', groupB);

    expect(moveMods).toHaveBeenCalledWith('/instance', 'Default', ['Mod C'], { kind: 'separator', name: 'Group A' }, 'winning');
    expect(moveSeparators).toHaveBeenCalledWith('/instance', 'Default', ['Group B'], { kind: 'separator', name: 'Group A' }, 'winning');
  });

  it('handed a target, as a drop hands one, moves there without a pick', async () => {
    moveMods.mockResolvedValue({ applied: true, outcome: { landed: ['Mod C'], refused: [] } });
    moveSeparators.mockResolvedValue({ applied: true, outcome: { landed: ['Group B'], refused: [] } });

    registerModMoveCommand('/instance', instance, losingAtTop, recordingReporter());
    await invoke('modbench.mod.move', modC, [modC], { place: { kind: 'mod', name: 'Mod A' }, end: 'winning' });
    await invoke('modbench.mod.move', groupB, [groupB], { place: { kind: 'modOrder' }, end: 'winning' });

    expect(showQuickPick).not.toHaveBeenCalled();
    expect(moveMods).toHaveBeenCalledWith('/instance', 'Default', ['Mod C'], { kind: 'mod', name: 'Mod A' }, 'winning');
    expect(moveSeparators).toHaveBeenCalledWith('/instance', 'Default', ['Group B'], { kind: 'modOrder' }, 'winning');
  });

  it('handed a target no separator can take, refuses it once, saying why, and moves nothing', async () => {
    const reporter = recordingReporter();

    registerModMoveCommand('/instance', instance, losingAtTop, reporter);
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
      '/instance', instance, { selection: () => [], direction: () => 'winningAtTop' }, recordingReporter());
    await invoke('modbench.mod.move', modC);

    expect(pickedLabels()).toEqual(['Ungrouped', 'Group A', 'Group B']);
  });

  it('from the palette over a selection mixing mods and separators, moves nothing and says nothing', async () => {
    const reporter = recordingReporter();

    registerModMoveCommand('/instance', instance, { ...losingAtTop, selection: () => [modA, groupA] }, reporter);
    await invoke('modbench.mod.move');

    expect(showQuickPick).not.toHaveBeenCalled();
    expect(moveMods).not.toHaveBeenCalled();
    expect(moveSeparators).not.toHaveBeenCalled();
    expect(reporter.reports).toEqual([]);
  });

  it('Esc at the pick moves nothing and says nothing', async () => {
    showQuickPick.mockResolvedValueOnce(undefined);
    const reporter = recordingReporter();

    registerModMoveCommand('/instance', instance, losingAtTop, reporter);
    await invoke('modbench.mod.move', modA);

    expect(moveMods).not.toHaveBeenCalled();
    expect(reporter.reports).toEqual([]);
  });

  it('Esc at the separator pick moves nothing and says nothing', async () => {
    showQuickPick.mockResolvedValueOnce(undefined);
    const reporter = recordingReporter();

    registerModMoveCommand('/instance', instance, losingAtTop, reporter);
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

    registerModMoveCommand('/instance', instance, losingAtTop, reporter);
    await invoke('modbench.mod.move', modA, [modA, modC]);

    expect(reporter.reports).toEqual([{
      severity: 'error', message: 'Could not move 1 of 2 mods.', detail: '"Mod C" (Mod not found in modlist: Mod C)',
    }]);
  });

  it('reports a refusal of the whole selection once', async () => {
    pickLabelled('Group A');
    moveSeparators.mockResolvedValue({ applied: false, refusal: 'ENOENT: modlist.txt' });
    const reporter = recordingReporter();

    registerModMoveCommand('/instance', instance, losingAtTop, reporter);
    await invoke('modbench.mod.move', groupB);

    expect(reporter.reports).toEqual([
      { severity: 'error', message: 'Failed to move separators.', detail: 'ENOENT: modlist.txt' },
    ]);
  });
});

describe('open folder: one command for a mod and for the Overwrite row', () => {
  beforeEach(() => vi.clearAllMocks());

  const instance = {
    value: instanceValueFixture({
      paths: { overwriteDir: '/instance/overwrite', downloadsDir: '', modDirs: new Map([['My Mod', '/instance/mods/My Mod']]) },
    }),
  };
  const revealed = (): (string | undefined)[] =>
    executeCommand.mock.calls.filter((c) => c[0] === 'revealInExplorer').map((c) => c[1]?.fsPath);

  it('reveals the clicked mod\'s own folder, as the value names it', async () => {
    registerOpenFolderCommand(instance, recordingReporter());
    await invoke('modbench.mod.openFolder', new ModNode({ kind: 'mod', name: 'My Mod', enabled: true }));

    expect(revealed()).toEqual(['/instance/mods/My Mod']);
  });

  it('reveals the overwrite folder from the Overwrite row', async () => {
    registerOpenFolderCommand(instance, recordingReporter());
    await invoke('modbench.mod.openFolder', new OverwriteNode(3));

    expect(revealed()).toEqual(['/instance/overwrite']);
  });

  it('reports a reveal that fails', async () => {
    executeCommand.mockRejectedValueOnce(new Error('no explorer'));
    const reporter = recordingReporter();

    registerOpenFolderCommand(instance, reporter);
    await invoke('modbench.mod.openFolder', new ModNode({ kind: 'mod', name: 'My Mod', enabled: true }));

    expect(reporter.reports).toEqual([
      { severity: 'error', message: 'Failed to open the folder of "My Mod".', detail: 'no explorer' },
    ]);
  });
});

describe('view on Nexus: one command for a mod and for a downloaded file', () => {
  beforeEach(() => vi.clearAllMocks());

  const instance = { value: instanceValueFixture({ nexusSlug: 'skyrimspecialedition' }) };
  const opened = (): string[] => openExternal.mock.calls.map((c) => String(c[0]));

  it('opens the mod\'s Nexus page from a mod row', async () => {
    registerViewOnNexusCommand(instance, recordingReporter());
    await invoke('modbench.mod.viewOnNexus', new ModNode({ kind: 'mod', name: 'My Mod', enabled: true, nexusId: '42' }));

    expect(opened()).toEqual(['https://www.nexusmods.com/skyrimspecialedition/mods/42']);
  });

  it('opens the mod\'s Nexus page from a downloaded file row', async () => {
    registerViewOnNexusCommand(instance, recordingReporter());
    await invoke('modbench.mod.viewOnNexus', new DownloadNode(downloadRowFixture('foo.7z', { modID: '123' })));

    expect(opened()).toEqual(['https://www.nexusmods.com/skyrimspecialedition/mods/123']);
  });

  it('reports a page that fails to open', async () => {
    openExternal.mockRejectedValueOnce(new Error('no browser'));
    const reporter = recordingReporter();

    registerViewOnNexusCommand(instance, reporter);
    await invoke('modbench.mod.viewOnNexus', new ModNode({ kind: 'mod', name: 'My Mod', enabled: true, nexusId: '42' }));

    expect(reporter.reports).toEqual([
      { severity: 'error', message: 'Failed to open the Nexus page of mod 42.', detail: 'no browser' },
    ]);
  });

  it('opens nothing for a row with no Nexus id', async () => {
    registerViewOnNexusCommand(instance, recordingReporter());
    await invoke('modbench.mod.viewOnNexus', new DownloadNode(downloadRowFixture('foo.7z')));
    await invoke('modbench.mod.viewOnNexus', new ModNode({ kind: 'mod', name: 'My Mod', enabled: true }));

    expect(openExternal).not.toHaveBeenCalled();
  });
});

// mods.md, Menus and keys, story 7: copy value copies each selected mod's or separator's name,
// one per line — Mods' own text for the catalog's one copy value id.
describe('modsCopyValueText', () => {
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
    const withOverwrite = [alpha, new OverwriteNode(3)];
    expect(modsCopyValueText(noSelection)(alpha, withOverwrite)).toBe('Alpha');
  });

  it('is undefined for a row that is not a Mods row, so another surface\'s copy takes over', () => {
    expect(modsCopyValueText(noSelection)(new OverwriteNode(0), undefined)).toBeUndefined();
    expect(modsCopyValueText(noSelection)({ formKey: 'Fallout4.esm:000001' }, undefined)).toBeUndefined();
  });

  // A key or the palette invokes with no arguments at all, unlike a context menu — and Mods has
  // no key or palette entry of its own in this slice, so it must never guess this is its row.
  it('is undefined with no clicked row, even when the view has a selection', () => {
    const viewSelection = (): ModlistNode[] => [alpha, groupA];
    expect(modsCopyValueText(viewSelection)(undefined, undefined)).toBeUndefined();
  });
});
