import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TreeItem, TreeItemCollapsibleState, TreeItemCheckboxState, EventEmitter, ThemeIcon, ThemeColor, MarkdownString, uriFile } from '../../test/vscodeMock';

const { registerCommand, executeCommand, showOpenDialog, showInputBox, openExternal } = vi.hoisted(() => ({
  registerCommand: vi.fn((_id: string, handler: (...args: unknown[]) => unknown) => ({ dispose: vi.fn(), handler })),
  executeCommand: vi.fn((_command: string, _uri?: { fsPath: string }) => Promise.resolve()),
  showOpenDialog: vi.fn(),
  showInputBox: vi.fn(),
  openExternal: vi.fn(),
}));

vi.mock('vscode', () => ({
  commands: { registerCommand, executeCommand },
  window: { showOpenDialog, showInputBox },
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

const { uninstallMod, deleteSeparator, renameSeparator, insertSeparator } = vi.hoisted(() => ({
  uninstallMod: vi.fn(), deleteSeparator: vi.fn(), renameSeparator: vi.fn(), insertSeparator: vi.fn(),
}));

vi.mock('../../modlist/modlist', () => ({
  createEmptyMod: vi.fn(), deleteSeparator, insertSeparator,
  moveModToSeparator: vi.fn(), renameSeparator, uninstallMod,
}));

import {
  registerModContextCommands, registerModInstallCommands, registerModListCoreCommands, registerOpenFolderCommand,
  registerSeparatorCommands, registerViewOnNexusCommand, type ModInstallDeps,
} from '../modManagementCommands';
import { ModNode, OverwriteNode, SeparatorNode } from '../ModListProvider';
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

describe('registerModInstallCommands: the install target', () => {
  beforeEach(() => vi.clearAllMocks());

  it('an upgrade choice bypasses the name prompt and installs as an upgrade of that mod', async () => {
    const promptModName = vi.fn();
    installFromArchive.mockResolvedValueOnce({ applied: true, wrote: true, isFomod: false });

    registerModInstallCommands(deps({ promptModName }));
    const succeeded = await invoke(
      'modbench.modList.installFromArchive', '/archive/foo.7z', '111', '222', '3.0',
      { kind: 'upgrade', name: 'Existing Mod' },
    );

    expect(promptModName).not.toHaveBeenCalled();
    expect(installFromArchive).toHaveBeenCalledWith(
      '/instance', { kind: 'upgrade', name: 'Existing Mod' }, '/archive/foo.7z',
      { gameName: GAME_RELEASE, modID: '111', fileID: '222', version: '3.0' },
    );
    expect(succeeded).toEqual({ installed: true });
  });

  it('a new-mod choice reaches the name prompt and installs as a new mod', async () => {
    const promptModName = vi.fn().mockResolvedValueOnce('New Mod');
    installFromArchive.mockResolvedValueOnce({ applied: true, wrote: true, isFomod: false });

    registerModInstallCommands(deps({ promptModName }));
    const succeeded = await invoke('modbench.modList.installFromArchive', '/archive/foo.7z', undefined, undefined, undefined, { kind: 'new' });

    expect(promptModName).toHaveBeenCalledWith('foo', expect.any(Function));
    expect(installFromArchive).toHaveBeenCalledWith(
      '/instance', { kind: 'new', name: 'New Mod' }, '/archive/foo.7z',
      { gameName: GAME_RELEASE, modID: undefined, fileID: undefined, version: undefined },
    );
    expect(succeeded).toEqual({ installed: true });
  });

  // Rival: default the absent choice to an upgrade of the prompted name. The Mods-view entry
  // would then adopt any folder that happens to share the name, and this fails.
  it('the Mods-view entry, invoked with no choice, installs as a new mod', async () => {
    const promptModName = vi.fn().mockResolvedValueOnce('New Mod');
    installFromArchive.mockResolvedValueOnce({ applied: true, wrote: true, isFomod: false });

    registerModInstallCommands(deps({ promptModName }));
    const succeeded = await invoke('modbench.modList.installFromArchive', '/archive/foo.7z');

    expect(promptModName).toHaveBeenCalledWith('foo', expect.any(Function));
    expect(installFromArchive).toHaveBeenCalledWith(
      '/instance', { kind: 'new', name: 'New Mod' }, '/archive/foo.7z',
      { gameName: GAME_RELEASE, modID: undefined, fileID: undefined, version: undefined },
    );
    expect(succeeded).toEqual({ installed: true });
  });

  it('no choice and a cancelled prompt installs nothing', async () => {
    const promptModName = vi.fn().mockResolvedValueOnce(undefined);

    registerModInstallCommands(deps({ promptModName }));
    const succeeded = await invoke('modbench.modList.installFromArchive', '/archive/foo.7z');

    expect(installFromArchive).not.toHaveBeenCalled();
    expect(succeeded).toEqual({ installed: false });
  });

  it('the Mods-view folder entry installs as a new mod under the prompted name', async () => {
    const promptModName = vi.fn().mockResolvedValueOnce('New Mod');
    showOpenDialog.mockResolvedValueOnce([{ fsPath: '/somewhere/Loose Files' }]);
    installFromFolder.mockResolvedValueOnce({ applied: true, wrote: true, isFomod: false });

    registerModInstallCommands(deps({ promptModName }));
    await invoke('modbench.modList.installFromFolder');

    expect(promptModName).toHaveBeenCalledWith('Loose Files', expect.any(Function));
    expect(installFromFolder).toHaveBeenCalledWith(
      '/instance', { kind: 'new', name: 'New Mod' }, '/somewhere/Loose Files', { gameName: GAME_RELEASE },
    );
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

// One command for both anchors (ticket: one add-separator command, not two legacy ones).
describe('add separator: one command for a mod anchor and a separator anchor', () => {
  beforeEach(() => vi.clearAllMocks());

  const instance = { value: instanceValueFixture({ activeProfile: 'Default' }) };
  const runModAction = async (_label: string, _fail: string, action: () => Promise<void>) => action();
  const modA = new ModNode({ kind: 'mod', name: 'Mod A', enabled: true });
  const groupA = new SeparatorNode({ kind: 'separator', name: 'Group A', enabled: true }, []);

  it('prompts and adds a separator after the right-clicked mod, not the selection around it', async () => {
    insertSeparator.mockResolvedValue({ applied: true, wrote: true });
    showInputBox.mockResolvedValueOnce('New Section');
    const otherMod = new ModNode({ kind: 'mod', name: 'Other Mod', enabled: true });

    registerSeparatorCommands('/instance', instance, runModAction, () => [otherMod, modA]);
    await invoke('modbench.separator.add', modA, [otherMod, modA]);

    expect(showInputBox).toHaveBeenCalledWith({ prompt: 'Separator name', placeHolder: 'My Group' });
    expect(insertSeparator.mock.calls).toEqual([['/instance', 'Default', 'New Section', 'Mod A']]);
  });

  it('prompts and adds a separator after the right-clicked separator, not the selection around it', async () => {
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
