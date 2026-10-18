import { unreadStatus } from '../../test/unreadStatus';
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

const { installMod } = vi.hoisted(() => ({ installMod: vi.fn() }));

import { registerModInstallCommands } from '../installCommands';
import { AgentCall } from '../../drivingLib/agentGesture';
import { Refusal } from '../../drivingLib/refusal';
import { modCommands } from '../../modCommands/modCommands';
import { downloadRowFixture } from '../../test/mo2/downloadRowFixture';
import { instanceValueFixture } from '../../test/mo2/instanceValueFixture';
import { fakeInstanceAdapter } from '../../test/fakeInstanceAdapter';
import { present } from '../../ports/present';
import { recordingReporter } from '../../test/surfacingDoubles';
import { progressSteps } from '../../test/recordedProgress';

function invoke(commandId: string, ...args: unknown[]): Promise<unknown> {
  const call = registerCommand.mock.calls.find((c) => c[0] === commandId);
  if (!call) throw new Error(`command not registered: ${commandId}`);
  return Promise.resolve(call[1](...args));
}

const unscriptedMEdit = { changeBuildConfiguration: () => Promise.reject(new Error('unscripted')) };
const COMMANDS = { ...modCommands(fakeInstanceAdapter().adapter, unscriptedMEdit, unreadStatus), installMod };

type ModInstallDeps = Parameters<typeof registerModInstallCommands>[0];

function deps(over: Partial<ModInstallDeps> = {}): ModInstallDeps {
  return {
    commands: COMMANDS,
    instance: { value: instanceValueFixture({ downloads: { kind: 'listed', rows: [downloadRowFixture('foo.7z')] } }), refresh: () => Promise.resolve() },
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
    await invoke('modbench.mod.install');

    expect(showOpenDialog).not.toHaveBeenCalled();
  });

  it('asks archive or folder before either OS picker opens', async () => {
    showQuickPick.mockResolvedValueOnce({ packageKind: 'archive' });
    showOpenDialog.mockResolvedValueOnce(undefined);

    registerModInstallCommands(deps());
    await invoke('modbench.mod.install');

    expect(showQuickPick).toHaveBeenCalledWith(
      [expect.objectContaining({ packageKind: 'archive' }), expect.objectContaining({ packageKind: 'folder' })],
      expect.anything(),
    );
    const quickPickOrder = present(showQuickPick.mock.invocationCallOrder[0], 'the showQuickPick call order');
    const openDialogOrder = present(showOpenDialog.mock.invocationCallOrder[0], 'the showOpenDialog call order');
    expect(quickPickOrder).toBeLessThan(openDialogOrder);
  });

  it('archive: Esc at the OS picker installs nothing', async () => {
    showQuickPick.mockResolvedValueOnce({ packageKind: 'archive' });
    showOpenDialog.mockResolvedValueOnce(undefined);

    registerModInstallCommands(deps());
    await invoke('modbench.mod.install');

    expect(installMod).not.toHaveBeenCalled();
  });

  it('archive: the OS picker offers install\'s own archive extensions rather than a list of its own that would drift', async () => {
    showInputBox.mockResolvedValueOnce('New Mod');
    showQuickPick.mockResolvedValueOnce({ packageKind: 'archive' });
    showOpenDialog.mockResolvedValueOnce([{ fsPath: '/somewhere/foo.zip' }]);
    installMod.mockResolvedValueOnce({ applied: true, isFomod: false });

    registerModInstallCommands(deps());
    await invoke('modbench.mod.install');

    expect(showOpenDialog).toHaveBeenCalledWith(expect.objectContaining({
      filters: { 'Mod archives': ['zip', '7z', 'rar'] },
    }));
  });

  it('archive: one of the instance\'s downloaded files is handed on as the archive picked, for the command to know as that file', async () => {
    const row = downloadRowFixture('foo.7z', { modID: '111', fileID: '222', version: '2.0' });
    showInputBox.mockResolvedValueOnce('New Mod');
    showQuickPick.mockResolvedValueOnce({ packageKind: 'archive' });
    showOpenDialog.mockResolvedValueOnce([{ fsPath: row.path }]);
    installMod.mockResolvedValueOnce({ applied: true, isFomod: false });

    registerModInstallCommands(deps({
      instance: { value: instanceValueFixture({ downloads: { kind: 'listed', rows: [row] } }), refresh: () => Promise.resolve() },
    }));
    await invoke('modbench.mod.install');

    expect(installMod).toHaveBeenCalledWith(
      { kind: 'archive', path: row.path },
      { kind: 'new', name: 'New Mod' }, true,
    );
  });

  it('archive: one of the instance\'s downloaded files that installs but cannot be marked is one Output line, not a failure', async () => {
    const row = downloadRowFixture('foo.7z');
    const log = vi.fn();
    const reporter = recordingReporter();
    showInputBox.mockResolvedValueOnce('New Mod');
    showQuickPick.mockResolvedValueOnce({ packageKind: 'archive' });
    showOpenDialog.mockResolvedValueOnce([{ fsPath: row.path }]);
    installMod.mockResolvedValueOnce({ applied: true, isFomod: false, downloadedFile: 'foo.7z', downloadedFileRefusal: 'locked' });

    registerModInstallCommands(deps({
      instance: { value: instanceValueFixture({ downloads: { kind: 'listed', rows: [row] } }), refresh: () => Promise.resolve() },
      reporterFor: () => reporter,
      downloadInstall: { reporter: recordingReporter(), log, progressViewId: 'modbench.downloads' },
    }));
    await invoke('modbench.mod.install');

    expect(log).toHaveBeenCalledWith('"foo.7z" was installed, but its Downloads status could not be updated: locked');
    expect(reporter.reports).toEqual([]);
  });

  it('archive: one outside the downloads folder, though it shares a downloaded file\'s name, installs as an archive under the name prompted, prefilled from it', async () => {
    showInputBox.mockResolvedValueOnce('New Mod');
    showQuickPick.mockResolvedValueOnce({ packageKind: 'archive' });
    showOpenDialog.mockResolvedValueOnce([{ fsPath: '/archive/foo.7z' }]);
    installMod.mockResolvedValueOnce({ applied: true, isFomod: false });

    registerModInstallCommands(deps());
    await invoke('modbench.mod.install');

    expect(showInputBox).toHaveBeenCalledWith(expect.objectContaining({ value: 'foo' }));
    expect(installMod).toHaveBeenCalledWith(
      { kind: 'archive', path: '/archive/foo.7z' }, { kind: 'new', name: 'New Mod' }, true,
    );
  });

  it('archive: a cancelled name prompt installs nothing', async () => {
    showInputBox.mockResolvedValueOnce(undefined);
    showQuickPick.mockResolvedValueOnce({ packageKind: 'archive' });
    showOpenDialog.mockResolvedValueOnce([{ fsPath: '/archive/foo.7z' }]);

    registerModInstallCommands(deps());
    await invoke('modbench.mod.install');

    expect(installMod).not.toHaveBeenCalled();
  });

  it('folder: Esc at the OS picker installs nothing', async () => {
    showQuickPick.mockResolvedValueOnce({ packageKind: 'folder' });
    showOpenDialog.mockResolvedValueOnce(undefined);

    registerModInstallCommands(deps());
    await invoke('modbench.mod.install');

    expect(installMod).not.toHaveBeenCalled();
  });

  it('folder: installs as a new mod under the name prompted, prefilled from the folder', async () => {
    showInputBox.mockResolvedValueOnce('New Mod');
    showQuickPick.mockResolvedValueOnce({ packageKind: 'folder' });
    showOpenDialog.mockResolvedValueOnce([{ fsPath: '/somewhere/Loose Files' }]);
    installMod.mockResolvedValueOnce({ applied: true, isFomod: false });

    registerModInstallCommands(deps());
    await invoke('modbench.mod.install');

    expect(showOpenDialog).toHaveBeenCalledWith(expect.objectContaining({
      canSelectFiles: false, canSelectFolders: true, canSelectMany: false,
    }));
    expect(showInputBox).toHaveBeenCalledWith(expect.objectContaining({ value: 'Loose Files' }));
    expect(installMod).toHaveBeenCalledWith(
      { kind: 'folder', path: '/somewhere/Loose Files' }, { kind: 'new', name: 'New Mod' }, true,
    );
  });
});

describe('modbench.mod.install: a failed install', () => {
  beforeEach(() => vi.clearAllMocks());

  it.each([
    ['archive', { fsPath: '/somewhere/foo.zip' }, 'installFromArchive'],
    ['folder', { fsPath: '/somewhere/foo' }, 'installFromFolder'],
  ] as const)('from a %s is reported under the gesture, naming the mod', async (packageKind, picked, tag) => {
    const reporter = recordingReporter();
    const tags: string[] = [];
    installMod.mockRejectedValueOnce(new Error('disk full'));
    showQuickPick.mockResolvedValueOnce({ packageKind });
    showOpenDialog.mockResolvedValueOnce([picked]);
    showInputBox.mockResolvedValueOnce('New Mod');

    registerModInstallCommands(deps({ reporterFor: (t) => { tags.push(t); return reporter; } }));
    await invoke('modbench.mod.install');

    expect(tags).toEqual([tag]);
    expect(reporter.reports).toEqual([{ severity: 'error', message: 'Failed to install "New Mod".', detail: 'disk full' }]);
  });
});

describe('modbench.mod.install: a downloaded file is its package', () => {
  beforeEach(() => vi.clearAllMocks());

  it('installs the downloaded file the Argument carries, and asks no package', async () => {
    installMod.mockResolvedValueOnce({ applied: true, isFomod: false });
    showInputBox.mockResolvedValueOnce('Foo');
    const row = downloadRowFixture('foo.7z');

    registerModInstallCommands(deps());
    await invoke('modbench.mod.install', { argument: { kind: 'download', row } });

    expect(installMod).toHaveBeenCalledWith(
      { kind: 'downloadedFile', name: 'foo.7z' }, { kind: 'new', name: 'Foo' }, true);
    expect(showQuickPick).not.toHaveBeenCalled();
    expect(showOpenDialog).not.toHaveBeenCalled();
  });

  it('reports a download install through the downloads reporter and log it was given, not the mod list\'s', async () => {
    const reporter = recordingReporter();
    const log = vi.fn();
    showInputBox.mockResolvedValue('Foo');
    installMod.mockResolvedValueOnce({ applied: true, isFomod: false, downloadedFile: 'foo.7z', downloadedFileRefusal: 'locked' });
    installMod.mockResolvedValueOnce({ applied: false, refusal: 'disk full' });
    const argument = { argument: { kind: 'download', row: downloadRowFixture('foo.7z') } };

    registerModInstallCommands(deps({ downloadInstall: { reporter, log, progressViewId: 'modbench.downloads' }, reporterFor: () => recordingReporter() }));
    await invoke('modbench.mod.install', argument);
    await invoke('modbench.mod.install', argument);

    expect(log).toHaveBeenCalledWith('"foo.7z" was installed, but its Downloads status could not be updated: locked');
    expect(reporter.reports).toEqual([{ severity: 'error', message: 'Failed to install "foo.7z".', detail: 'disk full' }]);
  });

  it('a mod row as Argument is no package, so it asks archive or folder', async () => {
    showQuickPick.mockResolvedValueOnce(undefined);

    registerModInstallCommands(deps());
    await invoke('modbench.mod.install', { kind: 'mod', mod: { name: 'Some Mod' } });

    expect(showQuickPick).toHaveBeenCalled();
    expect(installMod).not.toHaveBeenCalled();
  });
});

describe('modbench.mod.install called by the agent', () => {
  beforeEach(() => vi.clearAllMocks());

  const outsideArchive = { kind: 'archive' as const, path: '/elsewhere/bar.zip' };
  const install = (argument: AgentCall['argument'], options: object) => invoke('modbench.mod.install', new AgentCall(argument, options));
  const nothingAsked = () => {
    expect(showQuickPick).not.toHaveBeenCalled();
    expect(showOpenDialog).not.toHaveBeenCalled();
    expect(showInputBox).not.toHaveBeenCalled();
  };

  it('installs the downloaded file named as a new mod under the name given, asking nothing, and answers the mod written', async () => {
    const row = downloadRowFixture('foo.7z', { modID: '111', fileID: '222', version: '2.0' });
    installMod.mockResolvedValueOnce({ applied: true, isFomod: false });
    const warnIfFomod = vi.fn();
    const reporter = recordingReporter();

    registerModInstallCommands(deps({
      instance: { value: instanceValueFixture({ downloads: { kind: 'listed', rows: [row] } }), refresh: () => Promise.resolve() },
      warnIfFomod, downloadInstall: { reporter, log: vi.fn(), progressViewId: 'modbench.downloads' },
    }));
    const answered = await install([{ kind: 'downloadedFile', name: 'foo.7z' }], { name: 'Foo' });

    expect(installMod).toHaveBeenCalledWith(
      { kind: 'downloadedFile', name: 'foo.7z' }, { kind: 'new', name: 'Foo' }, false);
    expect(answered).toEqual({ applied: true, outcome: { landed: [{ name: 'Foo', isFomod: false }], refused: [] }, partial: [] });
    expect(warnIfFomod).not.toHaveBeenCalled();
    expect(reporter.reports).toEqual([]);
    nothingAsked();
  });

  it('installs an archive outside the downloads as an archive, and a folder as a folder', async () => {
    installMod.mockResolvedValue({ applied: true, isFomod: false });

    registerModInstallCommands(deps());
    await install([outsideArchive], { name: 'Bar' });
    await install([{ kind: 'folder', path: '/elsewhere/Loose' }], { name: 'Loose' });

    expect(installMod).toHaveBeenNthCalledWith(1, outsideArchive, { kind: 'new', name: 'Bar' }, false);
    expect(installMod).toHaveBeenNthCalledWith(2, { kind: 'folder', path: '/elsewhere/Loose' }, { kind: 'new', name: 'Loose' }, false);
    nothingAsked();
  });

  it('hands on an archive that is a downloaded file as the archive given, for the command to know as that file', async () => {
    const row = downloadRowFixture('foo.7z');
    installMod.mockResolvedValueOnce({ applied: true, isFomod: false });

    registerModInstallCommands(deps());
    await install([{ kind: 'archive', path: row.path }], { name: 'Foo' });

    expect(installMod).toHaveBeenCalledWith({ kind: 'archive', path: row.path }, { kind: 'new', name: 'Foo' }, false);
  });

  it('installs over the target mod named, as an upgrade', async () => {
    installMod.mockResolvedValueOnce({ applied: true, isFomod: false });

    registerModInstallCommands(deps());
    const answered = await install([outsideArchive], { target: 'Harder VATS' });

    expect(installMod).toHaveBeenCalledWith(outsideArchive, { kind: 'upgrade', name: 'Harder VATS' }, false);
    expect(answered).toMatchObject({ outcome: { landed: [{ name: 'Harder VATS' }] } });
  });

  it('hands the install the force the options carry', async () => {
    installMod.mockResolvedValue({ applied: true, isFomod: false });

    registerModInstallCommands(deps());
    await install([outsideArchive], { target: 'Harder VATS', force: true });

    expect(installMod).toHaveBeenCalledWith(outsideArchive, { kind: 'upgrade', name: 'Harder VATS' }, true);
  });

  it('answers the refusal the install gives, as the failed install\'s detail', async () => {
    installMod.mockResolvedValueOnce({ applied: false, refusal: 'would lose files' });

    registerModInstallCommands(deps());
    const answered = await install([outsideArchive], { target: 'Harder VATS' });

    expect(answered).toEqual({ applied: false, refusal: 'Failed to install "Harder VATS".', detail: 'would lose files' });
  });

  it('answers a FOMOD archive as one, warning nothing itself', async () => {
    installMod.mockResolvedValueOnce({ applied: true, isFomod: true });
    const warnIfFomod = vi.fn();

    registerModInstallCommands(deps({ warnIfFomod }));
    const answered = await install([outsideArchive], { name: 'Bar' });

    expect(answered).toMatchObject({ outcome: { landed: [{ name: 'Bar', isFomod: true }] } });
    expect(warnIfFomod).not.toHaveBeenCalled();
  });

  it('answers a downloaded file it could not mark installed as a log partial, writing no line itself', async () => {
    const log = vi.fn();
    installMod.mockResolvedValueOnce({ applied: true, isFomod: false, downloadedFile: 'foo.7z', downloadedFileRefusal: 'locked' });

    registerModInstallCommands(deps({ downloadInstall: { reporter: recordingReporter(), log, progressViewId: 'modbench.downloads' } }));
    const answered = await install([{ kind: 'downloadedFile', name: 'foo.7z' }], { name: 'Foo' });

    expect(answered).toMatchObject({
      applied: true,
      partial: [{ message: '"foo.7z" was installed, but its Downloads status could not be updated', detail: 'locked', severity: 'log' }],
    });
    expect(log).not.toHaveBeenCalled();
  });

  it.each([
    ['refused by install', () => installMod.mockResolvedValueOnce({ applied: false, refusal: 'folder taken' }), 'folder taken'],
    ['failing', () => installMod.mockRejectedValueOnce(new Error('disk full')), 'disk full'],
  ])('answers an install %s as the failure the view reports, reporting nothing itself', async (_, script, detail) => {
    script();
    const reporter = recordingReporter();

    registerModInstallCommands(deps({ reporterFor: () => reporter }));
    const answered = await install([outsideArchive], { name: 'Bar' });

    expect(answered).toEqual({ applied: false, refusal: 'Failed to install "Bar".', detail });
    expect(reporter.reports).toEqual([]);
  });

  it.each([
    ['no name and no target', {}],
    ['a name and a target', { name: 'Bar', target: 'Harder VATS' }],
  ])('refuses %s, installing nothing', async (_, options) => {
    registerModInstallCommands(deps());

    await expect(install([outsideArchive], options)).rejects.toBeInstanceOf(Refusal);

    expect(installMod).not.toHaveBeenCalled();
  });

  it.each([
    ['no package', []],
    ['two packages', [outsideArchive, { kind: 'folder', path: '/elsewhere/Loose' }]],
    ['a mod', [{ kind: 'mod', name: 'Some Mod' }]],
  ] as const)('refuses %s, installing nothing', async (_, argument) => {
    registerModInstallCommands(deps());

    await expect(install(argument, { name: 'Bar' })).rejects.toBeInstanceOf(Refusal);

    expect(installMod).not.toHaveBeenCalled();
  });

  it('names what it installs as a package when it refuses two', async () => {
    registerModInstallCommands(deps());

    await expect(install([outsideArchive, { kind: 'folder', path: '/elsewhere/Loose' }], { name: 'Bar' }))
      .rejects.toThrow(/carries one package/);
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
    ['archive', { fsPath: '/somewhere/foo.zip' }],
    ['folder', { fsPath: '/somewhere/foo' }],
  ] as const)('from a %s', async (packageKind, picked) => {
    installMod.mockImplementationOnce(() => { progressSteps.push('install'); return Promise.resolve({ applied: true, isFomod: false }); });
    showQuickPick.mockResolvedValueOnce({ packageKind });
    showOpenDialog.mockResolvedValueOnce([picked]);
    showInputBox.mockResolvedValueOnce('New Mod');

    registerModInstallCommands(deps({ instance }));
    await invoke('modbench.mod.install');

    expect(progressSteps).toEqual(ends);
  });
});
