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
import type { DownloadRow, Instance, InstanceValue } from '../../instanceLoader/instance';
import { recordingReporter } from '../../test/surfacingDoubles';
import { downloadRowFixture } from '../../test/mo2/downloadRowFixture';
import { accessTo } from '../../test/mo2/adapterOver';
import { instanceValueFixture } from '../../test/mo2/instanceValueFixture';

const node = (root: string, name: string, row: Partial<DownloadRow> = {}): { row: ReturnType<typeof downloadRowFixture> } =>
  ({ row: downloadRowFixture(name, row, root) });

const fakeInstance = (
  mods: InstanceValue['mods'] = [], gameName = 'Fallout 4',
): Pick<Instance, 'value' | 'refresh'> => ({
  value: instanceValueFixture({ mods, gameName }),
  refresh: () => { progressSteps.push('Instance loader: read every file again'); return Promise.resolve(); },
});

const mod = (over: Partial<InstanceValue['mods'][number]> & { name: string }): InstanceValue['mods'][number] => ({
  kind: 'mod',
  enabled: true,
  ...over,
});

const installDeps = (over: Partial<DownloadInstallDeps> = {}): DownloadInstallDeps => ({
  warnIfFomod: vi.fn(),
  log: (line) => { downloadsLogLines.push(line); },
  progressView: 'modbench.downloads',
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

  it('installDownloadedFile installs the row\'s archive', async () => {
    const root = await makeInstanceRoot();
    const archive = await writeArchive(root, 'foo.7z');
    await writeMeta(root, 'foo.7z');
    installFromArchive.mockResolvedValueOnce({ applied: true, wrote: true, isFomod: false });

    await installDownloadedFile(node(root, 'foo.7z').row, accessTo(root), fakeInstance(), recordingReporter(), installDeps());

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

    await installDownloadedFile(node(root, 'foo.7z', { modID: '123', fileID: '456', version: '2.0' }).row, accessTo(root), fakeInstance(), recordingReporter(), installDeps());

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

    await installDownloadedFile(node(root, 'foo.7z').row, accessTo(root), fakeInstance(), recordingReporter(), installDeps());

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

    await installDownloadedFile(node(root, 'foo.7z').row, accessTo(root), fakeInstance(), report, installDeps());

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

    await installDownloadedFile(node(root, 'foo.7z').row, accessTo(root), fakeInstance(), recordingReporter(), installDeps());

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

    await installDownloadedFile(node(root, 'foo.7z').row, accessTo(root), fakeInstance(), report, installDeps());

    await vi.waitFor(() => expect(report.reports).toHaveLength(1));
    expect(report.reports).toEqual([{ severity: 'error', message: 'Failed to install "foo.7z".', detail: 'boom' }]);
    expect(await readFile(meta, 'utf8')).not.toContain('installed=true');
  });

  it('install: a FOMOD archive installs and the notice names the mod install made', async () => {
    const root = await makeInstanceRoot();
    await writeArchive(root, 'foo.7z');
    installFromArchive.mockResolvedValueOnce({ applied: true, wrote: true, isFomod: true });
    const warnIfFomod = vi.fn();

    await installDownloadedFile(node(root, 'foo.7z').row, accessTo(root), fakeInstance(), recordingReporter(), installDeps({ warnIfFomod }));

    await vi.waitFor(() => expect(warnIfFomod).toHaveBeenCalledWith('foo', true));
  });
});

const ROW_NEXUS_IDS_READ_OFF_THE_SIDECAR = { modID: '111', fileID: '999' };

interface FakeUpgradeItem { label: string; description?: string; choice: unknown }

describe('installDownloadedFile: the upgrade pick', () => {
  beforeEach(() => vi.clearAllMocks());

  it('shows one row per candidate — file-id match named and first — plus a trailing new-mod row, and pre-selects the file-id match', async () => {
    const root = await makeInstanceRoot();
    await writeArchive(root, 'foo.7z');
    const instance = fakeInstance([
      mod({ name: 'No Match', nexusId: '111', version: '1.0' }),
      mod({ name: 'The Match', nexusId: '111', version: '2.0', installedFiles: [{ nexusId: '111', fileId: '999' }] }),
    ]);
    const { qp, escape } = fakeQuickPick<FakeUpgradeItem>();
    createQuickPick.mockReturnValue(qp);

    const installing = installDownloadedFile(node(root, 'foo.7z', ROW_NEXUS_IDS_READ_OFF_THE_SIDECAR).row, accessTo(root), instance, recordingReporter(), installDeps());
    await vi.waitFor(() => expect(createQuickPick).toHaveBeenCalled());
    escape();
    await installing;

    expect(qp.items).toEqual([
      { label: 'The Match (v2.0)', description: 'File ID match', choice: { kind: 'upgrade', name: 'The Match' } },
      { label: 'No Match (v1.0)', description: undefined, choice: { kind: 'upgrade', name: 'No Match' } },
      { label: 'Install as a new mod…', choice: { kind: 'new' } },
    ]);
    expect(qp.activeItems).toEqual([{ label: 'The Match (v2.0)', description: 'File ID match', choice: { kind: 'upgrade', name: 'The Match' } }]);
  });

  it('labels an archiveFilename match "Installed from this file" and pre-selects it, with no fileId match present', async () => {
    const root = await makeInstanceRoot();
    await writeArchive(root, 'foo.7z');
    const instance = fakeInstance([
      mod({ name: 'Harder VATS', nexusId: '111', version: '1.0', archiveFilename: 'foo.7z' }),
    ]);
    const { qp, escape } = fakeQuickPick<FakeUpgradeItem>();
    createQuickPick.mockReturnValue(qp);

    const installing = installDownloadedFile(node(root, 'foo.7z', ROW_NEXUS_IDS_READ_OFF_THE_SIDECAR).row, accessTo(root), instance, recordingReporter(), installDeps());
    await vi.waitFor(() => expect(createQuickPick).toHaveBeenCalled());
    escape();
    await installing;

    const tier2Item = { label: 'Harder VATS (v1.0)', description: 'Installed from this file', choice: { kind: 'upgrade', name: 'Harder VATS' } };
    expect(qp.items).toEqual([tier2Item, { label: 'Install as a new mod…', choice: { kind: 'new' } }]);
    expect(qp.activeItems).toEqual([tier2Item]);
  });

  it('hides the archiveFilename label when a fileId match exists elsewhere in the pool', async () => {
    const root = await makeInstanceRoot();
    await writeArchive(root, 'foo.7z');
    const instance = fakeInstance([
      mod({ name: 'By Name', nexusId: '111', version: '1.0', archiveFilename: 'foo.7z' }),
      mod({ name: 'By File Id', nexusId: '111', version: '2.0', installedFiles: [{ nexusId: '111', fileId: '999' }] }),
    ]);
    const { qp, escape } = fakeQuickPick<FakeUpgradeItem>();
    createQuickPick.mockReturnValue(qp);

    const installing = installDownloadedFile(node(root, 'foo.7z', ROW_NEXUS_IDS_READ_OFF_THE_SIDECAR).row, accessTo(root), instance, recordingReporter(), installDeps());
    await vi.waitFor(() => expect(createQuickPick).toHaveBeenCalled());
    escape();
    await installing;

    expect(qp.items).toEqual([
      { label: 'By File Id (v2.0)', description: 'File ID match', choice: { kind: 'upgrade', name: 'By File Id' } },
      { label: 'By Name (v1.0)', description: undefined, choice: { kind: 'upgrade', name: 'By Name' } },
      { label: 'Install as a new mod…', choice: { kind: 'new' } },
    ]);
  });

  it('pre-selects "Install as a new mod…" when neither tier matches, even with a tierless mod listed', async () => {
    const root = await makeInstanceRoot();
    await writeArchive(root, 'foo.7z');
    const instance = fakeInstance([mod({ name: 'Some Mod', nexusId: '111', version: '1.0' })]);
    const { qp, escape } = fakeQuickPick<FakeUpgradeItem>();
    createQuickPick.mockReturnValue(qp);

    const installing = installDownloadedFile(node(root, 'foo.7z', ROW_NEXUS_IDS_READ_OFF_THE_SIDECAR).row, accessTo(root), instance, recordingReporter(), installDeps());
    await vi.waitFor(() => expect(createQuickPick).toHaveBeenCalled());
    escape();
    await installing;

    expect(qp.items).toEqual([
      { label: 'Some Mod (v1.0)', description: undefined, choice: { kind: 'upgrade', name: 'Some Mod' } },
      { label: 'Install as a new mod…', choice: { kind: 'new' } },
    ]);
    expect(qp.activeItems).toEqual([{ label: 'Install as a new mod…', choice: { kind: 'new' } }]);
  });

  it('choosing a candidate calls install with the upgrade shape naming that mod', async () => {
    const root = await makeInstanceRoot();
    const archive = await writeArchive(root, 'foo.7z');
    const instance = fakeInstance([mod({ name: 'Harder VATS', nexusId: '111', version: '1.0' })]);
    const { qp, accept } = fakeQuickPick<FakeUpgradeItem>();
    createQuickPick.mockReturnValue(qp);
    installFromArchive.mockResolvedValueOnce({ applied: true, wrote: true, isFomod: false });

    const installing = installDownloadedFile(node(root, 'foo.7z', ROW_NEXUS_IDS_READ_OFF_THE_SIDECAR).row, accessTo(root), instance, recordingReporter(), installDeps());
    await vi.waitFor(() => expect(createQuickPick).toHaveBeenCalled());
    accept({ label: 'Harder VATS (v1.0)', choice: { kind: 'upgrade', name: 'Harder VATS' } });
    await installing;

    await vi.waitFor(() => {
      expect(installFromArchive).toHaveBeenCalledWith(
        expect.objectContaining({ instanceRoot: root }), { kind: 'upgrade', name: 'Harder VATS' }, archive,
        { gameName: 'Fallout 4', modID: '111', fileID: '999', version: undefined },
      );
    });
    expect(showInputBox).not.toHaveBeenCalled();
  });

  it('choosing "Install as a new mod…" calls install with the new-mod shape', async () => {
    const root = await makeInstanceRoot();
    const archive = await writeArchive(root, 'foo.7z');
    const instance = fakeInstance([mod({ name: 'Harder VATS', nexusId: '111', version: '1.0' })]);
    const { qp, accept } = fakeQuickPick<FakeUpgradeItem>();
    createQuickPick.mockReturnValue(qp);
    installFromArchive.mockResolvedValueOnce({ applied: true, wrote: true, isFomod: false });

    const installing = installDownloadedFile(node(root, 'foo.7z', ROW_NEXUS_IDS_READ_OFF_THE_SIDECAR).row, accessTo(root), instance, recordingReporter(), installDeps());
    await vi.waitFor(() => expect(createQuickPick).toHaveBeenCalled());
    accept({ label: 'Install as a new mod…', choice: { kind: 'new' } });
    await installing;

    await vi.waitFor(() => {
      expect(installFromArchive).toHaveBeenCalledWith(
        expect.objectContaining({ instanceRoot: root }), { kind: 'new', name: 'foo' }, archive,
        { gameName: 'Fallout 4', modID: '111', fileID: '999', version: undefined },
      );
    });
  });

  it('Esc installs nothing', async () => {
    const root = await makeInstanceRoot();
    await writeArchive(root, 'foo.7z');
    const instance = fakeInstance([mod({ name: 'Harder VATS', nexusId: '111', version: '1.0' })]);
    const { qp, escape } = fakeQuickPick<FakeUpgradeItem>();
    createQuickPick.mockReturnValue(qp);

    const installing = installDownloadedFile(node(root, 'foo.7z', ROW_NEXUS_IDS_READ_OFF_THE_SIDECAR).row, accessTo(root), instance, recordingReporter(), installDeps());
    await vi.waitFor(() => expect(createQuickPick).toHaveBeenCalled());
    escape();
    await installing;
    await afterAMacrotaskNotAMicrotask();

    expect(installFromArchive).not.toHaveBeenCalled();
  });

  it('a download with no mod id never shows the pick, even with installed mods present', async () => {
    const root = await makeInstanceRoot();
    const archive = await writeArchive(root, 'foo.7z');
    const instance = fakeInstance([mod({ name: 'Harder VATS', nexusId: '111', version: '1.0' })]);
    installFromArchive.mockResolvedValueOnce({ applied: true, wrote: true, isFomod: false });

    await installDownloadedFile(node(root, 'foo.7z').row, accessTo(root), instance, recordingReporter(), installDeps());

    await vi.waitFor(() => {
      expect(installFromArchive).toHaveBeenCalledWith(
        expect.objectContaining({ instanceRoot: root }), { kind: 'new', name: 'foo' }, archive,
        { gameName: 'Fallout 4', modID: undefined, fileID: undefined, version: undefined },
      );
    });
    expect(createQuickPick).not.toHaveBeenCalled();
  });

  it('a download with a mod id no installed mod carries never shows the pick, even when a mod was installed from this file', async () => {
    const root = await makeInstanceRoot();
    const archive = await writeArchive(root, 'foo.7z');
    const instance = fakeInstance([
      mod({ name: 'Harder VATS', nexusId: '111', version: '1.0' }),
      mod({ name: 'Hand Installed', archiveFilename: 'foo.7z' }),
    ]);
    installFromArchive.mockResolvedValueOnce({ applied: true, wrote: true, isFomod: false });

    await installDownloadedFile(node(root, 'foo.7z', { modID: '222' }).row, accessTo(root), instance, recordingReporter(), installDeps());

    await vi.waitFor(() => {
      expect(installFromArchive).toHaveBeenCalledWith(
        expect.objectContaining({ instanceRoot: root }), { kind: 'new', name: 'foo' }, archive,
        { gameName: 'Fallout 4', modID: '222', fileID: undefined, version: undefined },
      );
    });
    expect(createQuickPick).not.toHaveBeenCalled();
  });

  it('matches an archiveFilename candidate through the pick with a differently-cased filename', async () => {
    const root = await makeInstanceRoot();
    await writeArchive(root, 'Foo.7z');
    const instance = fakeInstance([
      mod({ name: 'Harder VATS', nexusId: '111', version: '1.0', archiveFilename: 'FOO.7Z' }),
    ]);
    const { qp, escape } = fakeQuickPick<FakeUpgradeItem>();
    createQuickPick.mockReturnValue(qp);

    const installing = installDownloadedFile(node(root, 'Foo.7z', ROW_NEXUS_IDS_READ_OFF_THE_SIDECAR).row, accessTo(root), instance, recordingReporter(), installDeps());
    await vi.waitFor(() => expect(createQuickPick).toHaveBeenCalled());
    escape();
    await installing;

    expect(qp.items).toEqual([
      { label: 'Harder VATS (v1.0)', description: 'Installed from this file', choice: { kind: 'upgrade', name: 'Harder VATS' } },
      { label: 'Install as a new mod…', choice: { kind: 'new' } },
    ]);
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

    await installDownloadedFile(node(root, 'foo.7z').row, accessTo(root), instanceThatReads, recordingReporter(), installDeps());

    expect(progressSteps).toEqual([opens, 'install', reads, 'progress closes']);
  });

  it('a refused install still ends on the read', async () => {
    const root = await makeInstanceRoot();
    await writeArchive(root, 'foo.7z');
    installFromArchive.mockResolvedValueOnce({ applied: false, refusal: 'boom' });

    await installDownloadedFile(node(root, 'foo.7z').row, accessTo(root), instanceThatReads, recordingReporter(), installDeps());

    expect(progressSteps).toEqual([opens, reads, 'progress closes']);
  });

  it('Esc at the upgrade pick opens no bar', async () => {
    const root = await makeInstanceRoot();
    await writeArchive(root, 'foo.7z');
    const { qp, escape } = fakeQuickPick<FakeUpgradeItem>();
    createQuickPick.mockReturnValue(qp);
    const installed = fakeInstance([mod({ name: 'Foo Mod', nexusId: '111', version: '1.0' })]);

    const running = installDownloadedFile(node(root, 'foo.7z', ROW_NEXUS_IDS_READ_OFF_THE_SIDECAR).row, accessTo(root), installed, recordingReporter(), installDeps());
    await vi.waitFor(() => expect(createQuickPick).toHaveBeenCalled());
    escape();
    await running;

    expect(progressSteps).toEqual([]);
  });

  it('declining to name the mod opens no bar', async () => {
    const root = await makeInstanceRoot();
    await writeArchive(root, 'foo.7z');
    showInputBox.mockResolvedValueOnce(undefined);

    await installDownloadedFile(node(root, 'foo.7z').row, accessTo(root), instanceThatReads, recordingReporter(), installDeps());

    expect(progressSteps).toEqual([]);
  });
});
