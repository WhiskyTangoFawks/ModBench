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

const { installFromArchive } = vi.hoisted(() => ({ installFromArchive: vi.fn() }));

vi.mock('../../install/install', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../install/install')>()),
  installFromArchive,
}));

import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installDownloadedFile, type DownloadInstallDeps } from '../installDownloaded';
import type { DownloadFile, DownloadRow, Instance } from '../../instanceLoader/instance';
import { recordingReporter } from '../../test/surfacingDoubles';
import { downloadRowFixture } from '../../test/mo2/downloadRowFixture';
import type { DownloadArgument } from '../../drivingLib/argument';
import type { UpgradeCandidate } from '../../instanceLoader/instance';
import { accessTo } from '../../test/mo2/adapterOver';
import { instanceValueFixture } from '../../test/mo2/instanceValueFixture';

const argumentOf = (root: string, name: string, row: Partial<DownloadRow> = {}): DownloadArgument =>
  ({ kind: 'download', row: downloadRowFixture(name, row, root) });

const fakeInstance = (rows: readonly DownloadFile[] = []): Pick<Instance, 'value' | 'refresh'> => ({
  value: instanceValueFixture({ gameName: 'Fallout 4', downloads: { kind: 'listed', rows } }),
  refresh: () => { progressSteps.push('Instance loader: read every file again'); return Promise.resolve(); },
});

const installDeps = (over: Partial<DownloadInstallDeps> = {}): DownloadInstallDeps => ({
  reporter: recordingReporter(),
  warnIfFomod: vi.fn(),
  log: (line) => { downloadsLogLines.push(line); },
  progressViewId: 'modbench.downloads',
  ...over,
});

const afterAMacrotaskNotAMicrotask = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

let instanceRootsRemovedInAfterEachSoAFailedAssertionDoesNotLeakThem: string[] = [];
let downloadsLogLines: string[] = [];
const instanceThatReads = fakeInstance();

afterEach(async () => {
  await Promise.all(instanceRootsRemovedInAfterEachSoAFailedAssertionDoesNotLeakThem.map((root) => rm(root, { recursive: true, force: true })));
  instanceRootsRemovedInAfterEachSoAFailedAssertionDoesNotLeakThem = [];
  downloadsLogLines = [];
});

async function makeInstanceRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'install-downloaded-'));
  await mkdir(join(root, 'downloads'), { recursive: true });
  await writeFile(join(root, 'ModOrganizer.ini'), '[General]\r\ngameName=Fallout 4\r\n');
  instanceRootsRemovedInAfterEachSoAFailedAssertionDoesNotLeakThem.push(root);
  return root;
}

async function writeArchive(root: string, name: string, data = 'data'): Promise<string> {
  const path = join(root, 'downloads', name);
  await writeFile(path, data);
  return path;
}

async function writeMeta(root: string, name: string, text = '[General]\r\n'): Promise<string> {
  const path = join(root, 'downloads', `${name}.meta`);
  await writeFile(path, text);
  return path;
}

describe('installDownloadedFile', () => {
  beforeEach(() => vi.clearAllMocks());

  it('installs the row\'s archive as a new mod named after it', async () => {
    const root = await makeInstanceRoot();
    const archive = await writeArchive(root, 'foo.7z');
    await writeMeta(root, 'foo.7z');
    installFromArchive.mockResolvedValueOnce({ applied: true, wrote: true, isFomod: false });

    await installDownloadedFile(argumentOf(root, 'foo.7z'), accessTo(root), fakeInstance(), installDeps({ reporter: recordingReporter() }));

    await vi.waitFor(() => {
      expect(installFromArchive).toHaveBeenCalledWith(
        expect.objectContaining({ instanceRoot: root }), { kind: 'new', name: 'foo' }, archive,
        { gameName: 'Fallout 4', modID: undefined, fileID: undefined, version: undefined });
    });
  });

  it('carries the row\'s modID, fileID and version into install, reading no sidecar', async () => {
    const root = await makeInstanceRoot();
    const archive = await writeArchive(root, 'foo.7z');
    installFromArchive.mockResolvedValueOnce({ applied: true, wrote: true, isFomod: false });

    await installDownloadedFile(argumentOf(root, 'foo.7z', { modID: '123', fileID: '456', version: '2.0' }), accessTo(root), fakeInstance(), installDeps({ reporter: recordingReporter() }));

    await vi.waitFor(() => {
      expect(installFromArchive).toHaveBeenCalledWith(
        expect.objectContaining({ instanceRoot: root }), { kind: 'new', name: 'foo' }, archive,
        { gameName: 'Fallout 4', modID: '123', fileID: '456', version: '2.0' });
    });
  });

  it('install: writes no sidecar of its own, the mark being install\'s', async () => {
    const root = await makeInstanceRoot();
    const archive = await writeArchive(root, 'foo.7z');
    const meta = await writeMeta(root, 'foo.7z');
    const before = await readFile(meta, 'utf8');
    installFromArchive.mockResolvedValueOnce({ applied: true, wrote: true, isFomod: false });

    await installDownloadedFile(argumentOf(root, 'foo.7z'), accessTo(root), fakeInstance(), installDeps({ reporter: recordingReporter() }));

    await vi.waitFor(() => {
      expect(installFromArchive).toHaveBeenCalledWith(
        expect.objectContaining({ instanceRoot: root }), { kind: 'new', name: 'foo' }, archive,
        { gameName: 'Fallout 4', modID: undefined, fileID: undefined, version: undefined });
    });
    expect(await readFile(meta, 'utf8')).toBe(before);
  });

  it('install: a failed mark installed is one Output line, no failure notification, and the install stands', async () => {
    const root = await makeInstanceRoot();
    const archive = await writeArchive(root, 'foo.7z');
    installFromArchive.mockResolvedValueOnce({
      applied: true, wrote: true, isFomod: false, downloadRefusal: 'EISDIR: illegal operation on a directory',
    });
    const report = recordingReporter();

    await installDownloadedFile(argumentOf(root, 'foo.7z'), accessTo(root), fakeInstance(), installDeps({ reporter: report }));

    await vi.waitFor(() => expect(downloadsLogLines).toHaveLength(1));
    const line = present(downloadsLogLines[0], 'the one recorded Output line');
    expect(line).toBe('"foo.7z" was installed, but its Downloads status could not be updated: EISDIR: illegal operation on a directory');
    expect(report.reports).toEqual([]);
    expect(report.shownFailures).toEqual([]);
    expect(installFromArchive).toHaveBeenCalledWith(
      expect.objectContaining({ instanceRoot: root }), { kind: 'new', name: 'foo' }, archive,
      { gameName: 'Fallout 4', modID: undefined, fileID: undefined, version: undefined });
  });

  it('install: cancelling the name prompt installs nothing', async () => {
    const root = await makeInstanceRoot();
    await writeArchive(root, 'foo.7z');
    const meta = await writeMeta(root, 'foo.7z');
    showInputBox.mockResolvedValueOnce(undefined);

    await installDownloadedFile(argumentOf(root, 'foo.7z'), accessTo(root), fakeInstance(), installDeps({ reporter: recordingReporter() }));

    await vi.waitFor(() => expect(showInputBox).toHaveBeenCalled());
    expect(installFromArchive).not.toHaveBeenCalled();
    expect(await readFile(meta, 'utf8')).not.toContain('installed=true');
  });

  it('install: a refusal from install surfaces an error and leaves the .meta untouched', async () => {
    const root = await makeInstanceRoot();
    await writeArchive(root, 'foo.7z');
    const meta = await writeMeta(root, 'foo.7z');
    installFromArchive.mockResolvedValueOnce({ applied: false, refusal: 'boom' });
    const report = recordingReporter();

    await installDownloadedFile(argumentOf(root, 'foo.7z'), accessTo(root), fakeInstance(), installDeps({ reporter: report }));

    await vi.waitFor(() => expect(report.reports).toHaveLength(1));
    expect(report.reports).toEqual([{ severity: 'error', message: 'Failed to install "foo.7z".', detail: 'boom' }]);
    expect(await readFile(meta, 'utf8')).not.toContain('installed=true');
  });

  it('install: a FOMOD archive installs and the notice names the mod install made', async () => {
    const root = await makeInstanceRoot();
    await writeArchive(root, 'foo.7z');
    installFromArchive.mockResolvedValueOnce({ applied: true, wrote: true, isFomod: true });
    const warnIfFomod = vi.fn();

    await installDownloadedFile(argumentOf(root, 'foo.7z'), accessTo(root), fakeInstance(), installDeps({ reporter: recordingReporter(), warnIfFomod }));

    await vi.waitFor(() => expect(warnIfFomod).toHaveBeenCalledWith('foo', true));
  });
});

const ROW_NEXUS_IDS_READ_OFF_THE_SIDECAR = { modID: '111', fileID: '999' };

interface FakeUpgradeItem { label: string; description?: string; choice: unknown }

const NEW_MOD_ITEM = { label: 'Install as a new mod…', choice: { kind: 'new' } };

describe('installDownloadedFile: the pick among the upgrades the Argument carries', () => {
  beforeEach(() => vi.clearAllMocks());

  async function pickAmong(upgrades: readonly UpgradeCandidate[], act: (double: ReturnType<typeof fakeQuickPick<FakeUpgradeItem>>) => void) {
    const root = await makeInstanceRoot();
    const archive = await writeArchive(root, 'foo.7z');
    const double = fakeQuickPick<FakeUpgradeItem>();
    createQuickPick.mockReturnValue(double.qp);
    const installing = installDownloadedFile(
      argumentOf(root, 'foo.7z', ROW_NEXUS_IDS_READ_OFF_THE_SIDECAR), accessTo(root),
      fakeInstance([downloadRowFixture('foo.7z', { ...ROW_NEXUS_IDS_READ_OFF_THE_SIDECAR, upgrades })]), installDeps({ reporter: recordingReporter() }));
    await vi.waitFor(() => expect(createQuickPick).toHaveBeenCalled());
    act(double);
    await installing;
    return { root, archive, qp: double.qp };
  }

  it('shows one row per upgrade, in the Argument\'s order, plus a trailing new-mod row, and pre-selects the file-id match', async () => {
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
    installFromArchive.mockResolvedValueOnce({ applied: true, wrote: true, isFomod: false });

    const { root, archive } = await pickAmong(
      [{ modName: 'Harder VATS', version: '1.0' }],
      (d) => d.accept({ label: 'Harder VATS (v1.0)', choice: { kind: 'upgrade', name: 'Harder VATS' } }));

    expect(installFromArchive).toHaveBeenCalledWith(
      expect.objectContaining({ instanceRoot: root }), { kind: 'upgrade', name: 'Harder VATS' }, archive,
      { gameName: 'Fallout 4', modID: '111', fileID: '999', version: undefined },
    );
    expect(showInputBox).not.toHaveBeenCalled();
  });

  it('choosing "Install as a new mod…" calls install with the new-mod shape', async () => {
    installFromArchive.mockResolvedValueOnce({ applied: true, wrote: true, isFomod: false });

    const { root, archive } = await pickAmong([{ modName: 'Harder VATS', version: '1.0' }], (d) => d.accept(NEW_MOD_ITEM));

    expect(installFromArchive).toHaveBeenCalledWith(
      expect.objectContaining({ instanceRoot: root }), { kind: 'new', name: 'foo' }, archive,
      { gameName: 'Fallout 4', modID: '111', fileID: '999', version: undefined },
    );
  });

  it('Esc installs nothing', async () => {
    await pickAmong([{ modName: 'Harder VATS', version: '1.0' }], (d) => d.escape());
    await afterAMacrotaskNotAMicrotask();

    expect(installFromArchive).not.toHaveBeenCalled();
  });

  it('an Argument with no upgrades shows no pick and installs as a new mod', async () => {
    const root = await makeInstanceRoot();
    const archive = await writeArchive(root, 'foo.7z');
    installFromArchive.mockResolvedValueOnce({ applied: true, wrote: true, isFomod: false });

    await installDownloadedFile(argumentOf(root, 'foo.7z'), accessTo(root), fakeInstance(), installDeps({ reporter: recordingReporter() }));

    expect(installFromArchive).toHaveBeenCalledWith(
      expect.objectContaining({ instanceRoot: root }), { kind: 'new', name: 'foo' }, archive,
      { gameName: 'Fallout 4', modID: undefined, fileID: undefined, version: undefined },
    );
    expect(createQuickPick).not.toHaveBeenCalled();
  });
});

describe('installDownloadedFile: the progress bar and the read', () => {
  beforeEach(() => { vi.clearAllMocks(); progressSteps.length = 0; });
  const opens = 'progress opens on modbench.downloads';
  const reads = 'Instance loader: read every file again';

  it('install over a downloaded file installs, then the read, then the bar closes', async () => {
    const root = await makeInstanceRoot();
    await writeArchive(root, 'foo.7z');
    installFromArchive.mockImplementationOnce(() => { progressSteps.push('install'); return Promise.resolve({ applied: true, wrote: true, isFomod: false }); });

    await installDownloadedFile(argumentOf(root, 'foo.7z'), accessTo(root), instanceThatReads, installDeps({ reporter: recordingReporter() }));

    expect(progressSteps).toEqual([opens, 'install', reads, 'progress closes']);
  });

  it('a refused install still ends on the read', async () => {
    const root = await makeInstanceRoot();
    await writeArchive(root, 'foo.7z');
    installFromArchive.mockResolvedValueOnce({ applied: false, refusal: 'boom' });

    await installDownloadedFile(argumentOf(root, 'foo.7z'), accessTo(root), instanceThatReads, installDeps({ reporter: recordingReporter() }));

    expect(progressSteps).toEqual([opens, reads, 'progress closes']);
  });

  it('Esc at the upgrade pick opens no bar', async () => {
    const root = await makeInstanceRoot();
    await writeArchive(root, 'foo.7z');
    const { qp, escape } = fakeQuickPick<FakeUpgradeItem>();
    createQuickPick.mockReturnValue(qp);

    const running = installDownloadedFile(argumentOf(root, 'foo.7z', ROW_NEXUS_IDS_READ_OFF_THE_SIDECAR), accessTo(root),
      fakeInstance([downloadRowFixture('foo.7z', { ...ROW_NEXUS_IDS_READ_OFF_THE_SIDECAR, upgrades: [{ modName: 'Foo Mod', version: '1.0' }] })]), installDeps({ reporter: recordingReporter() }));
    await vi.waitFor(() => expect(createQuickPick).toHaveBeenCalled());
    escape();
    await running;

    expect(progressSteps).toEqual([]);
  });

  it('declining to name the mod opens no bar', async () => {
    const root = await makeInstanceRoot();
    await writeArchive(root, 'foo.7z');
    showInputBox.mockResolvedValueOnce(undefined);

    await installDownloadedFile(argumentOf(root, 'foo.7z'), accessTo(root), instanceThatReads, installDeps({ reporter: recordingReporter() }));

    expect(progressSteps).toEqual([]);
  });
});
