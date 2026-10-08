import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TreeItem, TreeItemCollapsibleState, TreeItemCheckboxState, EventEmitter, ThemeIcon, ThemeColor, MarkdownString, uriFile } from '../../test/vscodeMock';

interface InputBoxOptionsDoubleOfJustPromptAndValidateInput {
  prompt?: string;
  value?: string;
  placeHolder?: string;
  validateInput?: (value: string) => string | undefined;
}

const { registerCommand, executeCommand, showOpenDialog, showInputBox, showQuickPick, openExternal } = vi.hoisted(() => ({
  registerCommand: vi.fn((_id: string, handler: (...args: unknown[]) => unknown) => ({ dispose: vi.fn(), handler })),
  executeCommand: vi.fn((_command: string, _uri?: { fsPath: string }) => Promise.resolve()),
  showOpenDialog: vi.fn(),
  showInputBox: vi.fn<(options?: InputBoxOptionsDoubleOfJustPromptAndValidateInput) => Promise<string | undefined>>(),
  showQuickPick: vi.fn(),
  openExternal: vi.fn(),
}));

vi.mock('vscode', async () => {
  const { recordedWithProgress } = await import('../../test/recordedProgress');
  return {
    commands: { registerCommand, executeCommand },
    window: { showOpenDialog, showInputBox, showQuickPick, withProgress: recordedWithProgress },
    env: { openExternal },
    TreeItem, TreeItemCollapsibleState, TreeItemCheckboxState, EventEmitter, ThemeIcon, ThemeColor, MarkdownString,
    Uri: { file: uriFile, parse: (s: string) => ({ toString: () => s }) },
  };
});

const { installFromArchive, installFromFolder } = vi.hoisted(() => ({
  installFromArchive: vi.fn(),
  installFromFolder: vi.fn(),
}));

vi.mock('../../install/install', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../install/install')>()),
  installFromArchive, installFromFolder,
}));

import { registerModInstallCommands } from '../installCommands';
import { ARCHIVE_EXTENSIONS } from '../../install/install';
import { downloadRowFixture } from '../../test/mo2/downloadRowFixture';
import { instanceValueFixture } from '../../test/mo2/instanceValueFixture';
import { accessTo } from '../../test/mo2/adapterOver';
import { present } from '../../ports/present';
import { recordingReporter } from '../../test/surfacingDoubles';
import { progressSteps } from '../../test/recordedProgress';

function invoke(commandId: string, ...args: unknown[]): Promise<unknown> {
  const call = registerCommand.mock.calls.find((c) => c[0] === commandId);
  if (!call) throw new Error(`command not registered: ${commandId}`);
  return Promise.resolve(call[1](...args));
}

const GAME_NAME_OTHER_THAN_THE_FIXTURES_USUAL_ONE ='Skyrim Special Edition';
const ACCESS = accessTo('/instance');

type ModInstallDeps = Parameters<typeof registerModInstallCommands>[0];

function deps(over: Partial<ModInstallDeps> = {}): ModInstallDeps {
  return {
    access: ACCESS,
    instance: { value: instanceValueFixture({ gameName: GAME_NAME_OTHER_THAN_THE_FIXTURES_USUAL_ONE }), refresh: () => Promise.resolve() },
    reporterFor: () => recordingReporter(),
    warnIfFomod: vi.fn(),
    downloadInstall: { reporter: recordingReporter(), log: vi.fn(), progressViewId: 'modbench.downloads' },
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
    const quickPickOrder = present(showQuickPick.mock.invocationCallOrder[0], 'the showQuickPick call order');
    const openDialogOrder = present(showOpenDialog.mock.invocationCallOrder[0], 'the showOpenDialog call order');
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

  it('archive: the OS picker offers install\'s own archive extensions rather than a list of its own that would drift', async () => {
    showInputBox.mockResolvedValueOnce('New Mod');
    showQuickPick.mockResolvedValueOnce({ sourceKind: 'archive' });
    showOpenDialog.mockResolvedValueOnce([{ fsPath: '/somewhere/foo.zip' }]);
    installFromArchive.mockResolvedValueOnce({ applied: true, wrote: true, isFomod: false });

    registerModInstallCommands(deps());
    await invoke('modbench.mod.install');

    expect(showOpenDialog).toHaveBeenCalledWith(expect.objectContaining({
      filters: { 'Mod archives': [...ARCHIVE_EXTENSIONS] },
    }));
  });

  it('archive: installs as a new mod under the name prompted, prefilled from the archive', async () => {
    showInputBox.mockResolvedValueOnce('New Mod');
    showQuickPick.mockResolvedValueOnce({ sourceKind: 'archive' });
    showOpenDialog.mockResolvedValueOnce([{ fsPath: '/archive/foo.7z' }]);
    installFromArchive.mockResolvedValueOnce({ applied: true, wrote: true, isFomod: false });

    registerModInstallCommands(deps());
    const succeeded = await invoke('modbench.mod.install');

    expect(showInputBox).toHaveBeenCalledWith(expect.objectContaining({ value: 'foo' }));
    expect(installFromArchive).toHaveBeenCalledWith(
      ACCESS, { kind: 'new', name: 'New Mod' }, '/archive/foo.7z', { gameName: GAME_NAME_OTHER_THAN_THE_FIXTURES_USUAL_ONE },
    );
    expect(succeeded).toEqual({ installed: true });
  });

  it('archive: a cancelled name prompt installs nothing', async () => {
    showInputBox.mockResolvedValueOnce(undefined);
    showQuickPick.mockResolvedValueOnce({ sourceKind: 'archive' });
    showOpenDialog.mockResolvedValueOnce([{ fsPath: '/archive/foo.7z' }]);

    registerModInstallCommands(deps());
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
    showInputBox.mockResolvedValueOnce('New Mod');
    showQuickPick.mockResolvedValueOnce({ sourceKind: 'folder' });
    showOpenDialog.mockResolvedValueOnce([{ fsPath: '/somewhere/Loose Files' }]);
    installFromFolder.mockResolvedValueOnce({ applied: true, wrote: true, isFomod: false });

    registerModInstallCommands(deps());
    const succeeded = await invoke('modbench.mod.install');

    expect(showOpenDialog).toHaveBeenCalledWith(expect.objectContaining({
      canSelectFiles: false, canSelectFolders: true, canSelectMany: false,
    }));
    expect(showInputBox).toHaveBeenCalledWith(expect.objectContaining({ value: 'Loose Files' }));
    expect(installFromFolder).toHaveBeenCalledWith(
      ACCESS, { kind: 'new', name: 'New Mod' }, '/somewhere/Loose Files', { gameName: GAME_NAME_OTHER_THAN_THE_FIXTURES_USUAL_ONE },
    );
    expect(succeeded).toEqual({ installed: true });
  });
});

describe('modbench.mod.install: a failed install', () => {
  beforeEach(() => vi.clearAllMocks());

  it.each([
    ['archive', installFromArchive, { fsPath: '/somewhere/foo.zip' }, 'installFromArchive'],
    ['folder', installFromFolder, { fsPath: '/somewhere/foo' }, 'installFromFolder'],
  ] as const)('from a %s is reported under the gesture, naming the mod', async (sourceKind, install, picked, tag) => {
    const reporter = recordingReporter();
    const tags: string[] = [];
    install.mockRejectedValueOnce(new Error('disk full'));
    showQuickPick.mockResolvedValueOnce({ sourceKind });
    showOpenDialog.mockResolvedValueOnce([picked]);
    showInputBox.mockResolvedValueOnce('New Mod');

    registerModInstallCommands(deps({ reporterFor: (t) => { tags.push(t); return reporter; } }));
    await invoke('modbench.mod.install');

    expect(tags).toEqual([tag]);
    expect(reporter.reports).toEqual([{ severity: 'error', message: 'Failed to install "New Mod".', detail: 'disk full' }]);
  });
});

describe('modbench.mod.install: a downloaded file is its source', () => {
  beforeEach(() => vi.clearAllMocks());

  it('installs the downloaded file the Argument carries, and asks no source', async () => {
    installFromArchive.mockResolvedValueOnce({ applied: true, wrote: true, isFomod: false });
    showInputBox.mockResolvedValueOnce('Foo');
    const row = downloadRowFixture('foo.7z');

    registerModInstallCommands(deps());
    const outcome = await invoke('modbench.mod.install', { argument: { kind: 'download', row, upgrades: [] } });

    expect(installFromArchive).toHaveBeenCalledWith(ACCESS, { kind: 'new', name: 'Foo' }, row.path, expect.objectContaining({ modID: row.modID }));
    expect(showQuickPick).not.toHaveBeenCalled();
    expect(showOpenDialog).not.toHaveBeenCalled();
    expect(outcome).toEqual({ installed: true });
  });

  it('reports a download install through the downloads reporter and log it was given, not the mod list\'s', async () => {
    const reporter = recordingReporter();
    const log = vi.fn();
    showInputBox.mockResolvedValue('Foo');
    installFromArchive.mockResolvedValueOnce({ applied: true, wrote: true, isFomod: false, downloadRefusal: 'locked' });
    installFromArchive.mockResolvedValueOnce({ applied: false, refusal: 'disk full' });
    const argument = { argument: { kind: 'download', row: downloadRowFixture('foo.7z'), upgrades: [] } };

    registerModInstallCommands(deps({ downloadInstall: { reporter, log, progressViewId: 'modbench.downloads' }, reporterFor: () => recordingReporter() }));
    await invoke('modbench.mod.install', argument);
    await invoke('modbench.mod.install', argument);

    expect(log).toHaveBeenCalledWith('"foo.7z" was installed, but its Downloads status could not be updated: locked');
    expect(reporter.reports).toEqual([{ severity: 'error', message: 'Failed to install "foo.7z".', detail: 'disk full' }]);
  });

  it('a mod row as Argument is no source, so it asks archive or folder', async () => {
    showQuickPick.mockResolvedValueOnce(undefined);

    registerModInstallCommands(deps());
    await invoke('modbench.mod.install', { kind: 'mod', mod: { name: 'Some Mod' } });

    expect(showQuickPick).toHaveBeenCalled();
    expect(installFromArchive).not.toHaveBeenCalled();
  });
});

describe('an install ends on the Instance loader\'s read, with the Mods progress bar open throughout', () => {
  beforeEach(() => { vi.clearAllMocks(); progressSteps.length = 0; });

  const instance = {
    value: instanceValueFixture(),
    refresh: () => { progressSteps.push('Instance loader: read every file again'); return Promise.resolve(); },
  };
  const ends = ['progress opens on modbench.modList', 'install', 'Instance loader: read every file again', 'progress closes'];

  it.each([
    ['archive', installFromArchive, { fsPath: '/somewhere/foo.zip' }],
    ['folder', installFromFolder, { fsPath: '/somewhere/foo' }],
  ] as const)('from a %s', async (sourceKind, install, picked) => {
    install.mockImplementationOnce(() => { progressSteps.push('install'); return Promise.resolve({ applied: true, wrote: true, isFomod: false }); });
    showQuickPick.mockResolvedValueOnce({ sourceKind });
    showOpenDialog.mockResolvedValueOnce([picked]);
    showInputBox.mockResolvedValueOnce('New Mod');

    registerModInstallCommands(deps({ instance }));
    await invoke('modbench.mod.install');

    expect(progressSteps).toEqual(ends);
  });
});
