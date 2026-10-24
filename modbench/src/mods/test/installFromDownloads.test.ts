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

const { installMod, upgradeLoss, ask } = vi.hoisted(() => ({ installMod: vi.fn(), upgradeLoss: vi.fn<(target: unknown) => Promise<string | undefined>>(() => Promise.resolve(undefined)), ask: vi.fn() }));

import { registerModInstallCommands } from '../installCommands';
import type { LocatedDownloadedFileRow, DownloadedFileRow, Instance } from '../../instanceLoader/instance';
import { recordingReporter } from '../../test/surfacingDoubles';
import { downloadedFileRowFixture } from '../../test/mo2/downloadedFileRowFixture';
import type { UpgradeCandidate } from '../../instanceLoader/instance';
import { fakeInstanceAdapter } from '../../test/fakeInstanceAdapter';
import { modCommands } from '../../modCommands/modCommands';
import { instanceValueFixture } from '../../test/mo2/instanceValueFixture';

const unscriptedMEdit = { changeBuildConfiguration: () => Promise.reject(new Error('unscripted')) };
const installOver = () => ({ ...modCommands(fakeInstanceAdapter().adapter, unscriptedMEdit, unreadStatus), installMod, upgradeLoss });


const fakeInstance = (rows: readonly LocatedDownloadedFileRow[] = []): Pick<Instance, 'value' | 'refresh'> => ({
  value: instanceValueFixture({ downloadedFiles: { kind: 'listed', rows } }),
  refresh: () => { progressSteps.push('Instance loader: read every file again'); return Promise.resolve(); },
});

interface DownloadedFileInstallDeps {
  reporter: ReturnType<typeof recordingReporter>;
  log: (line: string) => void;
  progressViewId: string;
}

const installDeps = (over: Partial<DownloadedFileInstallDeps> = {}): DownloadedFileInstallDeps => ({
  reporter: recordingReporter(),
  log: (line) => { downloadsLogLines.push(line); },
  progressViewId: 'modbench.downloads',
  ...over,
});

const installDownloadedFile = async (file: LocatedDownloadedFileRow, listed: readonly LocatedDownloadedFileRow[], deps: DownloadedFileInstallDeps): Promise<void> => {
  registerModInstallCommands({
    commands: installOver(), instance: fakeInstance(listed), reporterFor: () => recordingReporter(), ask,
    downloadedFileInstallReporting: deps,
  });
  const handler = registerCommand.mock.calls.findLast((call) => call[0] === 'modbench.mod.install')?.[1];
  await handler?.({ argument: { kind: 'downloadedFile', row: file } });
};

const installRow = (deps: DownloadedFileInstallDeps, row: Partial<DownloadedFileRow> = {}): Promise<void> => {
  const file = downloadedFileRowFixture('foo.7z', row);
  return installDownloadedFile(file, [file], deps);
};

const afterAMacrotaskNotAMicrotask = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

let downloadsLogLines: string[] = [];

afterEach(() => {
  downloadsLogLines = [];
});

describe('modbench.mod.install over a downloaded file', () => {
  beforeEach(() => vi.clearAllMocks());

  it('installs the row\'s installation file as a new mod named after it', async () => {
    installMod.mockResolvedValueOnce({ applied: true });

    await installRow(installDeps({ reporter: recordingReporter() }));

    await vi.waitFor(() => {
      expect(installMod).toHaveBeenCalledWith(
        { kind: 'downloadedFile', name: 'foo.7z' },
        { kind: 'new', name: 'foo' }, true, undefined);
    });
  });

  it('carries the row\'s modID and version into install', async () => {
    installMod.mockResolvedValueOnce({ applied: true });

    await installRow(installDeps({ reporter: recordingReporter() }), { modID: '123', version: '2.0' });

    await vi.waitFor(() => {
      expect(installMod).toHaveBeenCalledWith(
        { kind: 'downloadedFile', name: 'foo.7z' },
        { kind: 'new', name: 'foo' }, true, undefined);
    });
  });

  it('install: a failed mark installed is one Output line, no failure notification, and the install stands', async () => {
    installMod.mockResolvedValueOnce({
      applied: true, downloadedFile: 'foo.7z', downloadedFileRefusal: 'EISDIR: illegal operation on a directory',
    });
    const report = recordingReporter();

    await installRow(installDeps({ reporter: report }));

    await vi.waitFor(() => expect(downloadsLogLines).toHaveLength(1));
    const line = present(downloadsLogLines[0], 'the one recorded Output line');
    expect(line).toBe('"foo.7z" was installed, but its Downloads status could not be updated: EISDIR: illegal operation on a directory');
    expect(report.reports).toEqual([]);
    expect(report.shownFailures).toEqual([]);
    expect(installMod).toHaveBeenCalledWith(
        { kind: 'downloadedFile', name: 'foo.7z' },
        { kind: 'new', name: 'foo' }, true, undefined);
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

  it('install: a FOMOD installed as a plain copy warns, naming the mod install made and why its installer did not run', async () => {
    installMod.mockResolvedValueOnce({ applied: true, fomod: { kind: 'plainCopy', why: 'no choices were given for its steps' } });
    const reporter = recordingReporter();

    await installRow(installDeps({ reporter }));

    await vi.waitFor(() => expect(reporter.reports).toEqual([{
      severity: 'warning',
      message: '"foo" is a FOMOD installed as a plain copy: its files need arranging by hand, because its installer\'s own steps did not run:',
      detail: 'no choices were given for its steps.',
    }]));
  });
});

const ROW_NEXUS_IDS_READ_OFF_THE_METADATA_FILE = { modID: '111' };

interface FakeUpgradeItem { label: string; description?: string; choice: unknown }

const NEW_MOD_ITEM = { label: 'Install as a new mod…', choice: { kind: 'new' } };

const UPGRADE_ITEM = { label: 'Harder VATS (v1.0)', choice: { kind: 'upgrade', name: 'Harder VATS' } };
const LOSS = 'The upgrade would lose, in "Harder VATS": files its package does not hold: a.esp.';

describe('modbench.mod.install over a downloaded file: the pick among the upgrades the Instance value lists', () => {
  beforeEach(() => vi.clearAllMocks());

  async function pickAmong(upgrades: readonly UpgradeCandidate[], act: (double: ReturnType<typeof fakeQuickPick<FakeUpgradeItem>>) => void) {
    const double = fakeQuickPick<FakeUpgradeItem>();
    createQuickPick.mockReturnValue(double.qp);
    const installing = installRow(installDeps({ reporter: recordingReporter() }), { ...ROW_NEXUS_IDS_READ_OFF_THE_METADATA_FILE, upgrades });
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

  it('labels an installationFileName match "Installed from this file" and pre-selects it', async () => {
    const { qp } = await pickAmong([{ modName: 'Harder VATS', version: '1.0', tier: 'installationFileName' }], (d) => d.escape());

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
    installMod.mockResolvedValueOnce({ applied: true });

    await pickAmong(
      [{ modName: 'Harder VATS', version: '1.0' }],
      (d) => d.accept({ label: 'Harder VATS (v1.0)', choice: { kind: 'upgrade', name: 'Harder VATS' } }));

    expect(installMod).toHaveBeenCalledWith(
        { kind: 'downloadedFile', name: 'foo.7z' },
        { kind: 'upgrade', name: 'Harder VATS' }, true, undefined);
    expect(showInputBox).not.toHaveBeenCalled();
  });

  it('an upgrade that would lose files asks once, listing them, and installs forced on the yes', async () => {
    installMod.mockResolvedValueOnce({ applied: true });
    upgradeLoss.mockResolvedValueOnce(LOSS);
    ask.mockResolvedValueOnce('Upgrade');

    await pickAmong([{ modName: 'Harder VATS', version: '1.0' }], (d) => d.accept(UPGRADE_ITEM));

    expect(ask).toHaveBeenCalledTimes(1);
    expect(ask).toHaveBeenCalledWith('Upgrade "Harder VATS"?', { modal: true, detail: LOSS }, 'Upgrade');
    expect(installMod).toHaveBeenCalledWith({ kind: 'downloadedFile', name: 'foo.7z' }, { kind: 'upgrade', name: 'Harder VATS' }, true, undefined);
  });

  it('Esc at the question installs nothing', async () => {
    upgradeLoss.mockResolvedValueOnce(LOSS);
    ask.mockResolvedValueOnce(undefined);

    await pickAmong([{ modName: 'Harder VATS', version: '1.0' }], (d) => d.accept(UPGRADE_ITEM));

    expect(installMod).not.toHaveBeenCalled();
  });

  it('an upgrade that loses nothing asks nothing', async () => {
    installMod.mockResolvedValueOnce({ applied: true });

    await pickAmong([{ modName: 'Harder VATS', version: '1.0' }], (d) => d.accept(UPGRADE_ITEM));

    expect(ask).not.toHaveBeenCalled();
    expect(installMod).toHaveBeenCalled();
  });

  it('choosing "Install as a new mod…" calls install with the new-mod shape', async () => {
    installMod.mockResolvedValueOnce({ applied: true });

    await pickAmong([{ modName: 'Harder VATS', version: '1.0' }], (d) => d.accept(NEW_MOD_ITEM));

    expect(installMod).toHaveBeenCalledWith(
        { kind: 'downloadedFile', name: 'foo.7z' },
        { kind: 'new', name: 'foo' }, true, undefined);
  });

  it('Esc installs nothing', async () => {
    await pickAmong([{ modName: 'Harder VATS', version: '1.0' }], (d) => d.escape());
    await afterAMacrotaskNotAMicrotask();

    expect(installMod).not.toHaveBeenCalled();
  });

  it('refuses a file the Instance value does not list, naming it', async () => {
    const report = recordingReporter();

    await installDownloadedFile(downloadedFileRowFixture('foo.7z'), [], installDeps({ reporter: report }));

    expect(installMod).not.toHaveBeenCalled();
    expect(report.reports).toEqual([{ severity: 'error', message: 'Failed to install "foo.7z".', detail: '"foo.7z" is gone from Downloads.' }]);
  });

  it('a listed file with no upgrades shows no pick and installs as a new mod', async () => {
    installMod.mockResolvedValueOnce({ applied: true });

    await installRow(installDeps({ reporter: recordingReporter() }));

    expect(installMod).toHaveBeenCalledWith(
        { kind: 'downloadedFile', name: 'foo.7z' },
        { kind: 'new', name: 'foo' }, true, undefined);
    expect(createQuickPick).not.toHaveBeenCalled();
  });
});

describe('modbench.mod.install over a downloaded file: the progress bar and the read', () => {
  beforeEach(() => { vi.clearAllMocks(); progressSteps.length = 0; });
  const opens = 'progress opens on modbench.downloads';
  const reads = 'Instance loader: read every file again';

  it('install over a downloaded file installs, then the read, then the bar closes', async () => {
    installMod.mockImplementationOnce(() => { progressSteps.push('install'); return Promise.resolve({ applied: true }); });

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
      { ...ROW_NEXUS_IDS_READ_OFF_THE_METADATA_FILE, upgrades: [{ modName: 'Foo Mod', version: '1.0' }] });
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
