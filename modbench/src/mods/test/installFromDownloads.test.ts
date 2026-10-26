import { unreadStatus } from '../../test/unreadStatus';
import { FOMOD_PAGE, VIEW_ANSWER } from '../../test/fomodDialogDouble';
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
import { instanceThatReads, progressSteps, recordedWithProgress } from '../../test/recordedProgress';

vi.mock('vscode', () => ({
  commands: { registerCommand },
  window: { showQuickPick, showInputBox, createQuickPick, withProgress: recordedWithProgress },
  Uri: { file: (p: string) => ({ fsPath: p, toString: () => `file://${p}` }) },
  TreeItem, TreeItemCollapsibleState, EventEmitter, ThemeIcon, ThemeColor, MarkdownString,
}));

import { registerModInstallCommands } from '../installCommands';
import type { LocatedDownloadedFileRow, DownloadedFileRow, Instance } from '../../instanceLoader/instance';
import { recordingReporter, scriptedDialog, type ScriptedDialog } from '../../test/surfacingDoubles';
import { downloadedFileRowFixture } from '../../test/mo2/downloadedFileRowFixture';
import type { UpgradeCandidate } from '../../instanceLoader/instance';
import {
  downloadedFilesOf, fakeInstanceAdapter, modFoldersOf, readingFixture, refusing, type FakeInstanceAdapter, type InstanceAnswers,
} from '../../test/fakeInstanceAdapter';
import { modCommands } from '../../modCommands/modCommands';
import type { ReadModStatus } from '../../client';
import { instanceValueFixture } from '../../test/mo2/instanceValueFixture';
import { status } from '../../test/modStatusFixture';

const unscriptedMEdit = { changeSourceManifest: () => Promise.reject(new Error('unscripted')) };
const nothingToLose: ReadModStatus = (mods) => Promise.resolve(mods.map((mod) => status(mod)));
const notInPackage: ReadModStatus = (mods) => Promise.resolve(mods.map((mod) => status(mod, { notInPackage: ['a.esp'] })));

const fakeInstance = (rows: readonly LocatedDownloadedFileRow[] = []): Pick<Instance, 'value' | 'refresh'> => ({
  value: instanceValueFixture({ downloadedFiles: { kind: 'listed', rows } }),
  ...instanceThatReads,
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

interface Scripted {
  readonly answers?: InstanceAnswers;
  readonly readStatus?: ReadModStatus;
  readonly ask?: ScriptedDialog;
}

let fake: FakeInstanceAdapter;

const installDownloadedFile = async (
  file: LocatedDownloadedFileRow, listed: readonly LocatedDownloadedFileRow[], deps: DownloadedFileInstallDeps,
  { answers = {}, readStatus = unreadStatus, ask = scriptedDialog() }: Scripted = {},
): Promise<void> => {
  fake = fakeInstanceAdapter(readingFixture({ modFolders: modFoldersOf('Harder VATS'), downloadedFiles: downloadedFilesOf('foo.7z') }), answers);
  registerModInstallCommands({
    commands: modCommands(fake.adapter, unscriptedMEdit, readStatus), instance: fakeInstance(listed), reporterFor: () => recordingReporter(), ask,
    fomodDialog: () => FOMOD_PAGE, downloadedFileInstallReporting: deps,
  });
  const [, handler] = present(registerCommand.mock.calls.findLast((call) => call[0] === 'modbench.mod.install'), 'the install handler');
  await handler({ argument: { kind: 'downloadedFile', row: file } });
};

const installRow = (deps: DownloadedFileInstallDeps, row: Partial<DownloadedFileRow> = {}, scripted: Scripted = {}): Promise<void> => {
  const file = downloadedFileRowFixture('foo.7z', row);
  return installDownloadedFile(file, [file], deps, scripted);
};

const installs = () => fake.calls.flatMap((call) => (call.verb === 'install' ? [{ package: call.package, target: call.target, fomod: call.fomod }] : []));
const FOO = { kind: 'archive', path: '/downloads/foo.7z' };
const AS_NEW_MOD = [{ package: FOO, target: { kind: 'new', name: 'foo' }, fomod: VIEW_ANSWER }];
const AS_UPGRADE = [{ package: FOO, target: { kind: 'upgrade', name: 'Harder VATS' }, fomod: VIEW_ANSWER }];

const stepOnInstall: InstanceAnswers['refusals'] = (call) => {
  if (call.verb === 'install') progressSteps.push('install');
  return undefined;
};

let downloadsLogLines: string[] = [];

afterEach(() => {
  downloadsLogLines = [];
});

describe('modbench.mod.install over a downloaded file', () => {
  beforeEach(() => vi.clearAllMocks());

  it('install: a failed mark installed is one Output line and no failure notification', async () => {
    const report = recordingReporter();

    await installRow(installDeps({ reporter: report }), {}, { answers: { refusals: refusing('markDownloadedFile', 'EISDIR: illegal operation on a directory') } });

    expect(downloadsLogLines).toEqual(['"foo.7z" was installed, but its Downloads status could not be updated: EISDIR: illegal operation on a directory']);
    expect(report.reports).toEqual([]);
    expect(report.shownFailures).toEqual([]);
  });

  it('install: a refusal from install surfaces an error', async () => {
    const report = recordingReporter();

    await installRow(installDeps({ reporter: report }), {}, { answers: { refusals: refusing('install', 'boom') } });

    expect(report.reports).toEqual([{ severity: 'error', message: 'Failed to install "foo.7z".', detail: 'boom' }]);
  });
});

const ROW_NEXUS_IDS_READ_OFF_THE_METADATA_FILE = { modID: '111' };

interface FakeUpgradeItem { label: string; description?: string; choice: unknown }

const NEW_MOD_ITEM = { label: 'Install as a new mod…', choice: { kind: 'new' } };

const UPGRADE_ITEM = { label: 'Harder VATS (v1.0)', choice: { kind: 'upgrade', name: 'Harder VATS' } };
const LOSS = 'The upgrade would lose, in "Harder VATS": files its package does not hold: a.esp.';

describe('modbench.mod.install over a downloaded file: the pick among the upgrades the Instance value lists', () => {
  beforeEach(() => vi.clearAllMocks());

  async function pickAmong(
    upgrades: readonly UpgradeCandidate[], act: (double: ReturnType<typeof fakeQuickPick<FakeUpgradeItem>>) => void, scripted: Scripted = {},
  ) {
    const double = fakeQuickPick<FakeUpgradeItem>();
    createQuickPick.mockReturnValue(double.qp);
    const installing = installRow(installDeps({ reporter: recordingReporter() }), { ...ROW_NEXUS_IDS_READ_OFF_THE_METADATA_FILE, upgrades }, scripted);
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

  it('choosing an upgrade that loses nothing installs over that mod, asking nothing and no name', async () => {
    const ask = scriptedDialog();

    await pickAmong([{ modName: 'Harder VATS', version: '1.0' }], (d) => d.accept(UPGRADE_ITEM), { readStatus: nothingToLose, ask });

    expect(installs()).toEqual(AS_UPGRADE);
    expect(ask.asked).toEqual([]);
    expect(showInputBox).not.toHaveBeenCalled();
  });

  it('an upgrade that would lose files asks once, listing them, and installs forced on the yes', async () => {
    const ask = scriptedDialog('Upgrade');

    await pickAmong([{ modName: 'Harder VATS', version: '1.0' }], (d) => d.accept(UPGRADE_ITEM), { readStatus: notInPackage, ask });

    expect(ask.asked).toEqual([{ message: 'Upgrade "Harder VATS"?', detail: LOSS, buttons: ['Upgrade'] }]);
    expect(installs()).toEqual(AS_UPGRADE);
  });

  it('Esc at the question installs nothing', async () => {
    await pickAmong([{ modName: 'Harder VATS', version: '1.0' }], (d) => d.accept(UPGRADE_ITEM), { readStatus: notInPackage, ask: scriptedDialog(undefined) });

    expect(fake.calls).toEqual([]);
  });

  it('choosing "Install as a new mod…" installs a new mod named after the file', async () => {
    await pickAmong([{ modName: 'Harder VATS', version: '1.0' }], (d) => d.accept(NEW_MOD_ITEM));

    expect(installs()).toEqual(AS_NEW_MOD);
  });

  it('Esc installs nothing', async () => {
    await pickAmong([{ modName: 'Harder VATS', version: '1.0' }], (d) => d.escape());

    expect(fake.calls).toEqual([]);
  });

  it('refuses a file the Instance value does not list, naming it', async () => {
    const report = recordingReporter();

    await installDownloadedFile(downloadedFileRowFixture('foo.7z'), [], installDeps({ reporter: report }));

    expect(fake.calls).toEqual([]);
    expect(report.reports).toEqual([{ severity: 'error', message: 'Failed to install "foo.7z".', detail: '"foo.7z" is gone from Downloads.' }]);
  });

  it('a listed file with no upgrades shows no pick and installs as a new mod named after it', async () => {
    await installRow(installDeps({ reporter: recordingReporter() }));

    expect(installs()).toEqual(AS_NEW_MOD);
    expect(createQuickPick).not.toHaveBeenCalled();
  });
});

describe('modbench.mod.install over a downloaded file: the progress bar and the read', () => {
  beforeEach(() => { vi.clearAllMocks(); progressSteps.length = 0; });
  const opens = 'progress opens on modbench.downloads';
  const reads = 'Instance loader: read every file again';

  it('install over a downloaded file installs, then the read, then the bar closes', async () => {
    await installRow(installDeps({ reporter: recordingReporter() }), {}, { answers: { refusals: stepOnInstall } });

    expect(progressSteps).toEqual([opens, 'install', reads, 'progress closes']);
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

  it('declining to name the mod installs nothing and opens no bar', async () => {
    showInputBox.mockResolvedValueOnce(undefined);

    await installRow(installDeps({ reporter: recordingReporter() }));

    expect([fake.calls, progressSteps]).toEqual([[], []]);
  });
});
