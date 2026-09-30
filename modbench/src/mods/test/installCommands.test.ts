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

import { registerModInstallCommands, type ModInstallDeps } from '../installCommands';
import { ARCHIVE_EXTENSIONS } from '../../install/install';
import { instanceValueFixture } from '../../test/mo2/instanceValueFixture';
import { accessTo } from '../../test/mo2/adapterOver';

function invoke(commandId: string, ...args: unknown[]): Promise<unknown> {
  const call = registerCommand.mock.calls.find((c) => c[0] === commandId);
  if (!call) throw new Error(`command not registered: ${commandId}`);
  return Promise.resolve(call[1](...args));
}

// Deliberately not the fixture's usual game: a gameName hardcoded at the call site would pass
// against Fallout 4 and reach meta.ini wrong for every other install.
const GAME_NAME = 'Skyrim Special Edition';
const ACCESS = accessTo('/instance');

function deps(over: Partial<ModInstallDeps> = {}): ModInstallDeps {
  return {
    access: ACCESS,
    instance: { value: instanceValueFixture({ gameName: GAME_NAME }) },
    runModAction: async (_label, _fail, action) => action(),
    promptModName: vi.fn(),
    warnIfFomod: vi.fn(),
    ...over,
  };
}

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
      ACCESS, { kind: 'new', name: 'New Mod' }, '/archive/foo.7z', { gameName: GAME_NAME },
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
      ACCESS, { kind: 'new', name: 'New Mod' }, '/somewhere/Loose Files', { gameName: GAME_NAME },
    );
    expect(succeeded).toEqual({ installed: true });
  });
});
