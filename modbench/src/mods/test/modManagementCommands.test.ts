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
  uninstallMod, deleteSeparator, renameSeparator, insertSeparator, createEmptyMod, setModsEnabled, moveMods, moveSeparators,
} = vi.hoisted(() => ({
  uninstallMod: vi.fn(), deleteSeparator: vi.fn(), renameSeparator: vi.fn(), insertSeparator: vi.fn(),
  createEmptyMod: vi.fn(), setModsEnabled: vi.fn(), moveMods: vi.fn(), moveSeparators: vi.fn(),
}));

vi.mock('../../modlist/modlist', () => ({
  createEmptyMod, deleteSeparator, insertSeparator,
  moveMods, moveSeparators, renameSeparator, uninstallMod, setModsEnabled,
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
import { recordingReporter, scriptedDialog } from '../../test/surfacingDoubles';
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


// Uninstall is the Mods tree's one destructive gesture, so the modal it asks and what a cancel
// leaves untouched are the behaviour worth pinning (ADR-0019's dialog seam).
describe('registerModContextCommands: the uninstall confirmation', () => {
  beforeEach(() => vi.clearAllMocks());

  const instance = { value: instanceValueFixture({ activeProfile: 'Default' }) };
  const modNode = new ModNode({ kind: 'mod', name: 'My Mod', enabled: true, archiveFilename: 'my-mod.7z' });
  const runModAction = async (_label: string, _fail: string, action: () => Promise<void>) => action();

  it('asks one modal naming the mod, then deletes the folder once it is confirmed', async () => {
    uninstallMod.mockResolvedValueOnce({ applied: true });
    const ask = scriptedDialog('Uninstall');

    registerModContextCommands('/instance', instance, runModAction, ask);
    await invoke('modbench.mod.uninstall', modNode);

    expect(ask.asked).toEqual([{
      message: 'Uninstall "My Mod"? This will permanently delete the mod folder from disk.',
      detail: undefined,
      buttons: ['Uninstall'],
    }]);
    expect(uninstallMod).toHaveBeenCalledWith('/instance', 'Default', 'My Mod', 'my-mod.7z');
  });

  it('uninstalls nothing when the modal is dismissed', async () => {
    uninstallMod.mockResolvedValue({ applied: true }); // so a lost guard would get all the way through

    registerModContextCommands('/instance', instance, runModAction, scriptedDialog(undefined));
    await invoke('modbench.mod.uninstall', modNode);

    expect(uninstallMod).not.toHaveBeenCalled();
  });
});

// VS Code hands every row gesture of a multi-select tree the right-clicked row and the selection.
// debt #975: the destructive Mods gestures take the right-clicked row alone.
describe('the destructive Mods row gestures take the right-clicked row, not the selection', () => {
  beforeEach(() => vi.clearAllMocks());

  const instance = { value: instanceValueFixture({ activeProfile: 'Default' }) };
  const runModAction = async (_label: string, _fail: string, action: () => Promise<void>) => action();

  it('uninstall asks about and uninstalls the right-clicked mod alone', async () => {
    uninstallMod.mockResolvedValue({ applied: true });
    const other = new ModNode({ kind: 'mod', name: 'Other Mod', enabled: true });
    const clicked = new ModNode({ kind: 'mod', name: 'My Mod', enabled: true, archiveFilename: 'my-mod.7z' });
    const ask = scriptedDialog('Uninstall');

    registerModContextCommands('/instance', instance, runModAction, ask);
    await invoke('modbench.mod.uninstall', clicked, [other, clicked]);

    expect(ask.asked.map((q) => q.message)).toEqual([
      'Uninstall "My Mod"? This will permanently delete the mod folder from disk.',
    ]);
    expect(uninstallMod.mock.calls).toEqual([['/instance', 'Default', 'My Mod', 'my-mod.7z']]);
  });

  it('delete separator deletes the right-clicked separator alone', async () => {
    deleteSeparator.mockResolvedValue({ applied: true });
    const other = new SeparatorNode({ kind: 'separator', name: 'Other Group', enabled: true }, []);
    const clicked = new SeparatorNode({ kind: 'separator', name: 'My Group', enabled: true }, []);

    registerSeparatorCommands('/instance', instance, runModAction, () => []);
    await invoke('modbench.separator.delete', clicked, [other, clicked]);

    expect(deleteSeparator.mock.calls).toEqual([['/instance', 'Default', 'My Group']]);
  });
});

describe('rename separator takes its separator through the gesture entry', () => {
  beforeEach(() => vi.clearAllMocks());

  const instance = { value: instanceValueFixture({ activeProfile: 'Default' }) };
  const runModAction = async (_label: string, _fail: string, action: () => Promise<void>) => action();
  const groupA = new SeparatorNode({ kind: 'separator', name: 'Group A', enabled: true }, []);
  const groupB = new SeparatorNode({ kind: 'separator', name: 'Group B', enabled: true }, []);

  it('prompts with the right-clicked separator\'s name and renames it, not the selection around it', async () => {
    renameSeparator.mockResolvedValue({ applied: true, wrote: true });
    showInputBox.mockResolvedValueOnce('Renamed');

    registerSeparatorCommands('/instance', instance, runModAction, () => [groupA, groupB]);
    await invoke('modbench.separator.rename', groupB, [groupA, groupB]);

    expect(showInputBox).toHaveBeenCalledWith({ prompt: 'Rename separator', value: 'Group B' });
    expect(renameSeparator.mock.calls).toEqual([['/instance', 'Default', 'Group B', 'Renamed']]);
  });

  it('renames nothing when the prompt keeps the same name', async () => {
    showInputBox.mockResolvedValueOnce('Group A');

    registerSeparatorCommands('/instance', instance, runModAction, () => [groupA]);
    await invoke('modbench.separator.rename', groupA);

    expect(renameSeparator).not.toHaveBeenCalled();
  });

  it('asks nothing and renames nothing from the palette, where no row is right-clicked', async () => {
    registerSeparatorCommands('/instance', instance, runModAction, () => [groupA]);
    await invoke('modbench.separator.rename');

    expect(showInputBox).not.toHaveBeenCalled();
    expect(renameSeparator).not.toHaveBeenCalled();
  });
});

describe('add separator: one command for a mod anchor and a separator anchor', () => {
  beforeEach(() => vi.clearAllMocks());

  const instance = { value: instanceValueFixture({ activeProfile: 'Default' }) };
  const runModAction = async (_label: string, _fail: string, action: () => Promise<void>) => action();
  const modA = new ModNode({ kind: 'mod', name: 'Mod A', enabled: true });
  const groupA = new SeparatorNode({ kind: 'separator', name: 'Group A', enabled: true }, []);

  it('prompts and anchors the new separator on the right-clicked mod, not the selection around it', async () => {
    insertSeparator.mockResolvedValue({ applied: true, wrote: true });
    showInputBox.mockResolvedValueOnce('New Section');
    const otherMod = new ModNode({ kind: 'mod', name: 'Other Mod', enabled: true });

    registerSeparatorCommands('/instance', instance, runModAction, () => [otherMod, modA]);
    await invoke('modbench.separator.add', modA, [otherMod, modA]);

    expect(showInputBox).toHaveBeenCalledWith({ prompt: 'Separator name', placeHolder: 'My Group' });
    expect(insertSeparator.mock.calls).toEqual([['/instance', 'Default', 'New Section', 'Mod A']]);
  });

  it('prompts and anchors the new separator on the right-clicked separator, not the selection around it', async () => {
    insertSeparator.mockResolvedValue({ applied: true, wrote: true });
    showInputBox.mockResolvedValueOnce('New Section');
    const otherGroup = new SeparatorNode({ kind: 'separator', name: 'Other Group', enabled: true }, []);

    registerSeparatorCommands('/instance', instance, runModAction, () => [otherGroup, groupA]);
    await invoke('modbench.separator.add', groupA, [otherGroup, groupA]);

    expect(insertSeparator.mock.calls).toEqual([['/instance', 'Default', 'New Section', 'Group A']]);
  });

  it('adds nothing when the prompt is cancelled (Esc)', async () => {
    showInputBox.mockResolvedValueOnce(undefined);

    registerSeparatorCommands('/instance', instance, runModAction, () => [modA]);
    await invoke('modbench.separator.add', modA);

    expect(insertSeparator).not.toHaveBeenCalled();
  });

  it('adds nothing for an empty name', async () => {
    showInputBox.mockResolvedValueOnce('');

    registerSeparatorCommands('/instance', instance, runModAction, () => [modA]);
    await invoke('modbench.separator.add', modA);

    expect(insertSeparator).not.toHaveBeenCalled();
  });

  it('asks nothing and adds nothing from the palette, where no row is right-clicked or focused', async () => {
    registerSeparatorCommands('/instance', instance, runModAction, () => [modA]);
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
    expect(moveSeparators).toHaveBeenCalledWith('/instance', 'Default', ['Group B'], 'Group A', 'losing');
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
    expect(moveSeparators).toHaveBeenCalledWith('/instance', 'Default', ['Group B'], 'Group A', 'winning');
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

  // A key or the palette invokes with no arguments at all, unlike a context menu.
  it('with no clicked row, copies the view\'s own current selection', () => {
    const viewSelection = (): ModlistNode[] => [alpha, groupA];
    expect(modsCopyValueText(viewSelection)(undefined, undefined)).toBe('Alpha\nGroup A');
  });

  it('is undefined with no clicked row and nothing selected in the view, so another surface\'s copy takes over', () => {
    expect(modsCopyValueText(noSelection)(undefined, undefined)).toBeUndefined();
  });
});
