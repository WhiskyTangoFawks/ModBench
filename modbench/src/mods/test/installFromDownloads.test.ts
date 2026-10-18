import { unreadStatus } from '../../test/unreadStatus';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { registerCommand, showQuickPick, createQuickPick, showInputBox } = vi.hoisted(() => ({
  registerCommand: vi.fn((_id: string, handler: (...args: unknown[]) => unknown) => ({ dispose: vi.fn(), handler })),
  showQuickPick: vi.fn(),
  createQuickPick: vi.fn(),
  showInputBox: vi.fn<(options: { value: string }) => Promise<string | undefined>>((options) => Promise.resolve(options.value)),
}));

import { TreeItem, TreeItemCollapsibleState, EventEmitter, ThemeIcon, ThemeColor, MarkdownString } from '../../test/vscodeMock';
import { present } from '../../ports/present';
import { fakeQuickPick } from '../../drivingLib/test/quickPickDouble';
import { progressSteps, recordedWithProgress } from '../../test/recordedProgress';

vi.mock('vscode', () => ({
  commands: { registerCommand },
  window: { showQuickPick, showInputBox, createQuickPick, withProgress: recordedWithProgress },
  Uri: { file: (p: string) => ({ fsPath: p, toString: () => `file://${p}` }) },
  TreeItem, TreeItemCollapsibleState, EventEmitter, ThemeIcon, ThemeColor, MarkdownString,
}));

const { installMod } = vi.hoisted(() => ({ installMod: vi.fn() }));

import { registerModInstallCommands } from '../installCommands';
import type { DownloadFile, DownloadRow, Instance } from '../../instanceLoader/instance';
import { recordingReporter } from '../../test/surfacingDoubles';
import { downloadRowFixture } from '../../test/mo2/downloadRowFixture';
import type { UpgradeCandidate } from '../../instanceLoader/instance';
import { fakeInstanceAdapter } from '../../test/fakeInstanceAdapter';
import { modCommands } from '../../modCommands/modCommands';
import { instanceValueFixture } from '../../test/mo2/instanceValueFixture';

const unscriptedMEdit = { changeBuildConfiguration: () => Promise.reject(new Error('unscripted')) };
const installOver = () => ({ ...modCommands(fakeInstanceAdapter().adapter, unscriptedMEdit, unreadStatus), installMod });

const ARCHIVE_PATH = downloadRowFixture('foo.7z').path;

const fakeInstance = (rows: readonly DownloadFile[] = []): Pick<Instance, 'value' | 'refresh'> => ({
  value: instanceValueFixture({ downloads: { kind: 'listed', rows } }),
  refresh: () => { progressSteps.push('Instance loader: read every file again'); return Promise.resolve(); },
});

interface DownloadInstallDeps {
  reporter: ReturnType<typeof recordingReporter>;
  warnIfFomod: (name: string, isFomod: boolean) => void;
  log: (line: string) => void;
  progressViewId: string;
}

const installDeps = (over: Partial<DownloadInstallDeps> = {}): DownloadInstallDeps => ({
  reporter: recordingReporter(),
  warnIfFomod: vi.fn(),
  log: (line) => { downloadsLogLines.push(line); },
  progressViewId: 'modbench.downloads',
  ...over,
});

const installDownloaded = async (file: DownloadFile, listed: readonly DownloadFile[], deps: DownloadInstallDeps): Promise<void> => {
  registerModInstallCommands({
    commands: installOver(), instance: fakeInstance(listed), reporterFor: () => recordingReporter(),
    warnIfFomod: deps.warnIfFomod, downloadInstall: deps,
  });
  const handler = registerCommand.mock.calls.findLast((call) => call[0] === 'modbench.mod.install')?.[1];
  await handler?.({ argument: { kind: 'download', row: file } });
};

const installRow = (deps: DownloadInstallDeps, row: Partial<DownloadRow> = {}): Promise<void> => {
  const file = downloadRowFixture('foo.7z', row);
  return installDownloaded(file, [file], deps);
};

const afterAMacrotaskNotAMicrotask = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

let downloadsLogLines: string[] = [];

afterEach(() => {
  downloadsLogLines = [];
});

describe('modbench.mod.install over a downloaded file', () => {
  beforeEach(() => vi.clearAllMocks());

  it('installs the row\'s archive as a new mod named after it', async () => {
    installMod.mockResolvedValueOnce({ applied: true, isFomod: false });

    await installRow(installDeps({ reporter: recordingReporter() }));

    await vi.waitFor(() => {
      expect(installMod).toHaveBeenCalledWith(
        { kind: 'downloadedFile', name: 'foo.7z', path: ARCHIVE_PATH, modID: undefined, fileID: undefined, version: undefined },
        { kind: 'new', name: 'foo' }, true);
    });
  });

  it('carries the row\'s modID, fileID and version into install', async () => {
    installMod.mockResolvedValueOnce({ applied: true, isFomod: false });

    await installRow(installDeps({ reporter: recordingReporter() }), { modID: '123', fileID: '456', version: '2.0' });

    await vi.waitFor(() => {
      expect(installMod).toHaveBeenCalledWith(
        { kind: 'downloadedFile', name: 'foo.7z', path: ARCHIVE_PATH, modID: '123', fileID: '456', version: '2.0' },
        { kind: 'new', name: 'foo' }, true);
    });
  });

  it('install: a failed mark installed is one Output line, no failure notification, and the install stands', async () => {
    installMod.mockResolvedValueOnce({
      applied: true, isFomod: false, downloadedFileRefusal: 'EISDIR: illegal operation on a directory',
    });
    const report = recordingReporter();

    await installRow(installDeps({ reporter: report }));

    await vi.waitFor(() => expect(downloadsLogLines).toHaveLength(1));
    const line = present(downloadsLogLines[0], 'the one recorded Output line');
    expect(line).toBe('"foo.7z" was installed, but its Downloads status could not be updated: EISDIR: illegal operation on a directory');
    expect(report.reports).toEqual([]);
    expect(report.shownFailures).toEqual([]);
    expect(installMod).toHaveBeenCalledWith(
        { kind: 'downloadedFile', name: 'foo.7z', path: ARCHIVE_PATH, modID: undefined, fileID: undefined, version: undefined },
        { kind: 'new', name: 'foo' }, true);
  });

  it('install: cancelling the name prompt installs nothing', async () => {
    showInputBox.mockResolvedValueOnce(undefined);

    await installRow(installDeps({ reporter: recordingReporter() }));

    await vi.waitFor(() => expect(showInputBox).toHaveBeenCalled());
    expect(installMod).not.toHaveBeenCalled();
  });

  it('install: a refusal from install surfaces an error', async () => {
    installMod.mockResolvedValueOnce({ applied: false, refusal: 'boom' });
    const report = recordingReporter();

    await installRow(installDeps({ reporter: report }));

    await vi.waitFor(() => expect(report.reports).toHaveLength(1));
    expect(report.reports).toEqual([{ severity: 'error', message: 'Failed to install "foo.7z".', detail: 'boom' }]);
  });

  it('install: a FOMOD archive installs and the notice names the mod install made', async () => {
    installMod.mockResolvedValueOnce({ applied: true, isFomod: true });
    const warnIfFomod = vi.fn();

    await installRow(installDeps({ reporter: recordingReporter(), warnIfFomod }));

    await vi.waitFor(() => expect(warnIfFomod).toHaveBeenCalledWith('foo', true));
  });
});

const ROW_NEXUS_IDS_READ_OFF_THE_SIDECAR = { modID: '111', fileID: '999' };

interface FakeUpgradeItem { label: string; description?: string; choice: unknown }

const NEW_MOD_ITEM = { label: 'Install as a new mod…', choice: { kind: 'new' } };

describe('modbench.mod.install over a downloaded file: the pick among the upgrades the Instance value lists', () => {
  beforeEach(() => vi.clearAllMocks());

  async function pickAmong(upgrades: readonly UpgradeCandidate[], act: (double: ReturnType<typeof fakeQuickPick<FakeUpgradeItem>>) => void) {
    const double = fakeQuickPick<FakeUpgradeItem>();
    createQuickPick.mockReturnValue(double.qp);
    const installing = installRow(installDeps({ reporter: recordingReporter() }), { ...ROW_NEXUS_IDS_READ_OFF_THE_SIDECAR, upgrades });
    await vi.waitFor(() => expect(createQuickPick).toHaveBeenCalled());
    act(double);
    await installing;
    return { qp: double.qp };
  }

  it('shows one row per upgrade, in the listed order, plus a trailing new-mod row, and pre-selects the file-id match', async () => {
    const { qp } = await pickAmong(
      [{ modName: 'The Match', version: '2.0', tier: 'fileId' }, { modName: 'No Match', version: '1.0' }], (d) => d.escape());

    const theMatch = { label: 'The Match (v2.0)', description: 'File ID match', choice: { kind: 'upgrade', name: 'The Match' } };
    expect(qp.items).toEqual([
      theMatch,
      { label: 'No Match (v1.0)', description: undefined, choice: { kind: 'upgrade', name: 'No Match' } },
      NEW_MOD_ITEM,
    ]);
    expect(qp.activeItems).toEqual([theMatch]);
  });

  it('labels an archiveFilename match "Installed from this file" and pre-selects it', async () => {
    const { qp } = await pickAmong([{ modName: 'Harder VATS', version: '1.0', tier: 'archiveFilename' }], (d) => d.escape());

    const item = { label: 'Harder VATS (v1.0)', description: 'Installed from this file', choice: { kind: 'upgrade', name: 'Harder VATS' } };
    expect(qp.items).toEqual([item, NEW_MOD_ITEM]);
    expect(qp.activeItems).toEqual([item]);
  });

  it('pre-selects "Install as a new mod…" when no upgrade carries a tier', async () => {
    const { qp } = await pickAmong([{ modName: 'Some Mod', version: '1.0' }], (d) => d.escape());

    expect(qp.items).toEqual([
      { label: 'Some Mod (v1.0)', description: undefined, choice: { kind: 'upgrade', name: 'Some Mod' } },
      NEW_MOD_ITEM,
    ]);
    expect(qp.activeItems).toEqual([NEW_MOD_ITEM]);
  });

  it('choosing an upgrade calls install with the upgrade shape naming that mod, and asks no name', async () => {
    installMod.mockResolvedValueOnce({ applied: true, isFomod: false });

    await pickAmong(
      [{ modName: 'Harder VATS', version: '1.0' }],
      (d) => d.accept({ label: 'Harder VATS (v1.0)', choice: { kind: 'upgrade', name: 'Harder VATS' } }));

    expect(installMod).toHaveBeenCalledWith(
        { kind: 'downloadedFile', name: 'foo.7z', path: ARCHIVE_PATH, modID: '111', fileID: '999', version: undefined },
        { kind: 'upgrade', name: 'Harder VATS' }, true);
    expect(showInputBox).not.toHaveBeenCalled();
  });

  it('choosing "Install as a new mod…" calls install with the new-mod shape', async () => {
    installMod.mockResolvedValueOnce({ applied: true, isFomod: false });

    await pickAmong([{ modName: 'Harder VATS', version: '1.0' }], (d) => d.accept(NEW_MOD_ITEM));

    expect(installMod).toHaveBeenCalledWith(
        { kind: 'downloadedFile', name: 'foo.7z', path: ARCHIVE_PATH, modID: '111', fileID: '999', version: undefined },
        { kind: 'new', name: 'foo' }, true);
  });

  it('Esc installs nothing', async () => {
    await pickAmong([{ modName: 'Harder VATS', version: '1.0' }], (d) => d.escape());
    await afterAMacrotaskNotAMicrotask();

    expect(installMod).not.toHaveBeenCalled();
  });

  it('refuses a file the Instance value does not list, naming it', async () => {
    const report = recordingReporter();

    await installDownloaded(downloadRowFixture('foo.7z'), [], installDeps({ reporter: report }));

    expect(installMod).not.toHaveBeenCalled();
    expect(report.reports).toEqual([{ severity: 'error', message: 'Failed to install "foo.7z".', detail: '"foo.7z" is gone from Downloads.' }]);
  });

  it('a listed file with no upgrades shows no pick and installs as a new mod', async () => {
    installMod.mockResolvedValueOnce({ applied: true, isFomod: false });

    await installRow(installDeps({ reporter: recordingReporter() }));

    expect(installMod).toHaveBeenCalledWith(
        { kind: 'downloadedFile', name: 'foo.7z', path: ARCHIVE_PATH, modID: undefined, fileID: undefined, version: undefined },
        { kind: 'new', name: 'foo' }, true);
    expect(createQuickPick).not.toHaveBeenCalled();
  });
});

describe('modbench.mod.install over a downloaded file: the progress bar and the read', () => {
  beforeEach(() => { vi.clearAllMocks(); progressSteps.length = 0; });
  const opens = 'progress opens on modbench.downloads';
  const reads = 'Instance loader: read every file again';

  it('install over a downloaded file installs, then the read, then the bar closes', async () => {
    installMod.mockImplementationOnce(() => { progressSteps.push('install'); return Promise.resolve({ applied: true, isFomod: false }); });

    await installRow(installDeps({ reporter: recordingReporter() }));

    expect(progressSteps).toEqual([opens, 'install', reads, 'progress closes']);
  });

  it('a refused install still ends on the read', async () => {
    installMod.mockResolvedValueOnce({ applied: false, refusal: 'boom' });

    await installRow(installDeps({ reporter: recordingReporter() }));

    expect(progressSteps).toEqual([opens, reads, 'progress closes']);
  });

  it('Esc at the upgrade pick opens no bar', async () => {
    const { qp, escape } = fakeQuickPick<FakeUpgradeItem>();
    createQuickPick.mockReturnValue(qp);

    const running = installRow(
      installDeps({ reporter: recordingReporter() }),
      { ...ROW_NEXUS_IDS_READ_OFF_THE_SIDECAR, upgrades: [{ modName: 'Foo Mod', version: '1.0' }] });
    await vi.waitFor(() => expect(createQuickPick).toHaveBeenCalled());
    escape();
    await running;

    expect(progressSteps).toEqual([]);
  });

  it('declining to name the mod opens no bar', async () => {
    showInputBox.mockResolvedValueOnce(undefined);

    await installRow(installDeps({ reporter: recordingReporter() }));

    expect(progressSteps).toEqual([]);
  });
});
