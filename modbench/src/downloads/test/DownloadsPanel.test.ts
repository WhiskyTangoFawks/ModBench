import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const {
  executeCommand, registerCommand, showErrorMessage, showTextDocument, showQuickPick, createQuickPick, openExternal,
} = vi.hoisted(() => ({
  executeCommand: vi.fn(),
  registerCommand: vi.fn((_id: string, handler: (...args: unknown[]) => unknown) => ({ dispose: vi.fn(), handler })),
  showErrorMessage: vi.fn(),
  showTextDocument: vi.fn(),
  showQuickPick: vi.fn(),
  createQuickPick: vi.fn(),
  openExternal: vi.fn(),
}));

import { TreeItem, TreeItemCollapsibleState, EventEmitter, ThemeIcon, ThemeColor, MarkdownString, type FakeUri } from '../../test/vscodeMock';
import { present } from '../../ports/present';
import { progressSteps, recordedWithProgress } from '../../test/recordedProgress';

vi.mock('vscode', () => ({
  commands: { executeCommand, registerCommand },
  window: { showErrorMessage, showTextDocument, showQuickPick, createQuickPick, withProgress: recordedWithProgress },
  env: { openExternal },
  Uri: {
    file: (p: string) => ({ fsPath: p, toString: () => `file://${p}` }),
    parse: (s: string) => ({ toString: () => s }),
  },
  ViewColumn: { One: 1 },
  TreeItem, TreeItemCollapsibleState, EventEmitter, ThemeIcon, ThemeColor, MarkdownString,
}));

const { installFromArchive } = vi.hoisted(() => ({ installFromArchive: vi.fn() }));

vi.mock('../../install/install', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../install/install')>()),
  installFromArchive,
}));

vi.mock('../../downloadsCommands/downloads', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../downloadsCommands/downloads')>();
  return { ...real, deleteDownloads: vi.fn(real.deleteDownloads) };
});

import * as vscode from 'vscode';
import { mkdtemp, mkdir, writeFile, readFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  registerDownloadsExcludedToggleCommands,
  registerDownloadsMultiRowCommands,
  registerDownloadsSingleRowCommands,
  registerDownloadsSortCommand,
  installDownloadedFile,
  type DownloadInstallDeps,
} from '../DownloadsPanel';
import { DownloadNode, DownloadsProvider } from '../DownloadsProvider';
import { FakeInstance } from '../../test/mo2/fakeInstance';
import { deleteDownloads } from '../../downloadsCommands/downloads';
import type { MoveToTrash } from '../../ports/trash';
import type { DownloadFile, DownloadRow, Instance, InstanceValue } from '../../instanceLoader/instance';
import { recordingReporter, scriptedDialog, assertAskedOnce, assertSelectionOutcome } from '../../test/surfacingDoubles';
import { downloadRowFixture } from '../../test/mo2/downloadRowFixture';
import { accessTo } from '../../test/mo2/adapterOver';
import { instanceValueFixture } from '../../test/mo2/instanceValueFixture';

const node = (root: string, name: string, row: Partial<DownloadRow> = {}): DownloadNode =>
  new DownloadNode(downloadRowFixture(name, row, root));

const NO_INSTALLED_MODS_SO_THE_UPGRADE_PICK_NEVER_SHOWS: InstanceValue['mods'] = [];

const fakeInstance = (
  mods: InstanceValue['mods'] = NO_INSTALLED_MODS_SO_THE_UPGRADE_PICK_NEVER_SHOWS, downloads: readonly DownloadFile[] = [], gameName = 'Fallout 4',
): Pick<Instance, 'value' | 'refresh'> => ({
  value: instanceValueFixture({ mods, downloads: { kind: 'listed', rows: downloads }, gameName }),
  refresh: () => { progressSteps.push('Instance loader: read every file again'); return Promise.resolve(); },
});

const mod = (over: Partial<InstanceValue['mods'][number]> & { name: string }): InstanceValue['mods'][number] => ({
  kind: 'mod',
  enabled: true,
  ...over,
});

const fakeDownloadsProvider = (
  currentSort: ReturnType<DownloadsProvider['currentSort']> = { column: 'mtimeMs', descending: true },
): Pick<DownloadsProvider, 'setSort' | 'setShowExcluded' | 'currentSort'> => ({
  setSort: vi.fn(), setShowExcluded: vi.fn(), currentSort: vi.fn(() => currentSort),
});

const installDeps = (over: Partial<DownloadInstallDeps> = {}): DownloadInstallDeps => ({
  nameNewMod: (defaultName: string) => Promise.resolve(defaultName),
  warnIfFomod: vi.fn(),
  log: downloadsLog,
  ...over,
});

function registerModInstallForDownloadedFile(
  access: ReturnType<typeof accessTo>, instance: Pick<Instance, 'value' | 'refresh'>, reporter: ReturnType<typeof recordingReporter>,
  deps: DownloadInstallDeps,
): void {
  vscode.commands.registerCommand('modbench.mod.install', (downloaded: DownloadNode) =>
    installDownloadedFile(downloaded.row, access, instance, reporter, deps));
}

let instanceRootsRemovedInAfterEachSoAFailedAssertionDoesNotLeakThem: string[] = [];

const instanceThatReads = fakeInstance();

let downloadsLogLines: string[] = [];
const downloadsLog = (line: string): void => { downloadsLogLines.push(line); };

afterEach(async () => {
  await Promise.all(instanceRootsRemovedInAfterEachSoAFailedAssertionDoesNotLeakThem.map((root) => rm(root, { recursive: true, force: true })));
  instanceRootsRemovedInAfterEachSoAFailedAssertionDoesNotLeakThem = [];
  downloadsLogLines = [];
});

async function makeInstanceRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'downloads-panel-'));
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

function calledFsPath(mockFn: { mock: { calls: FakeUri[][] } }): string {
  const call = present(mockFn.mock.calls[0], 'the mock function\'s sole call');
  return present(call[0], "the call's first argument").fsPath;
}

const trash = vi.fn<MoveToTrash>();
const trashedPaths = (): string[] => trash.mock.calls.map(([path]) => path);

function invoke(commandId: string, ...args: unknown[]): unknown {
  const call = registerCommand.mock.calls.find((c) => c[0] === commandId);
  if (!call) throw new Error(`command not registered: ${commandId}`);
  return call[1](...args);
}

function makeFakeQuickPickWhoseHideFiresOnDidHideAsTheRealOneDoes<T>() {
  const acceptListeners: Array<() => void> = [];
  const hideListeners: Array<() => void> = [];
  const qp = {
    items: [] as T[],
    placeholder: undefined as string | undefined,
    activeItems: [] as T[],
    selectedItems: [] as T[],
    show: vi.fn(),
    hide: vi.fn(() => { hideListeners.forEach((cb) => cb()); }),
    dispose: vi.fn(),
    onDidAccept: (cb: () => void) => { acceptListeners.push(cb); return { dispose: () => {} }; },
    onDidHide: (cb: () => void) => { hideListeners.push(cb); return { dispose: () => {} }; },
  };
  return {
    qp,
    accept: (picked: T) => { qp.selectedItems = [picked]; acceptListeners.forEach((cb) => cb()); },
    escape: () => { hideListeners.forEach((cb) => cb()); },
  };
}

const onDisk = (path: string): Promise<boolean> => access(path).then(() => true, () => false);

const afterAMacrotaskNotAMicrotask = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe('registerDownloadsSingleRowCommands', () => {
  beforeEach(() => vi.clearAllMocks());

  it('registers open and open .meta, and leaves install and view on Nexus to the mod, registered once for both views since VS Code throws on a second registration of a command id', () => {
    registerDownloadsSingleRowCommands(recordingReporter(), () => []);
    expect(registerCommand.mock.calls.map((c) => c[0])).toEqual([
      'modbench.downloadedFile.open',
      'modbench.downloadedFile.openMeta',
    ]);
  });

  it('invoking modbench.mod.install with a DownloadNode installs that row\'s archive', async () => {
    const root = await makeInstanceRoot();
    const archive = await writeArchive(root, 'foo.7z');
    await writeMeta(root, 'foo.7z');
    installFromArchive.mockResolvedValueOnce({ applied: true, wrote: true, isFomod: false });

    registerModInstallForDownloadedFile(accessTo(root), fakeInstance(), recordingReporter(), installDeps());
    invoke('modbench.mod.install', node(root, 'foo.7z'));

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

    registerModInstallForDownloadedFile(accessTo(root), fakeInstance(), recordingReporter(), installDeps());
    invoke('modbench.mod.install', node(root, 'foo.7z', { modID: '123', fileID: '456', version: '2.0' }));

    await vi.waitFor(() => {
      expect(installFromArchive).toHaveBeenCalledWith(
        expect.objectContaining({ instanceRoot: root }), { kind: 'new', name: 'foo' }, archive,
        { gameName: 'Fallout 4', modID: '123', fileID: '456', version: '2.0' });
    });
  });

  it('ignores the rest of a multi-selection — only the clicked row is installed', async () => {
    const root = await makeInstanceRoot();
    const archive = await writeArchive(root, 'foo.7z');
    await writeArchive(root, 'other.7z');
    await writeMeta(root, 'foo.7z');
    installFromArchive.mockResolvedValueOnce({ applied: true, wrote: true, isFomod: false });

    registerModInstallForDownloadedFile(accessTo(root), fakeInstance(), recordingReporter(), installDeps());
    invoke('modbench.mod.install', node(root, 'foo.7z'), [node(root, 'foo.7z'), node(root, 'other.7z')]);

    await vi.waitFor(() => {
      expect(installFromArchive).toHaveBeenCalledWith(
        expect.objectContaining({ instanceRoot: root }), { kind: 'new', name: 'foo' }, archive,
        { gameName: 'Fallout 4', modID: undefined, fileID: undefined, version: undefined });
    });
    expect(installFromArchive).toHaveBeenCalledTimes(1);
  });

  it('install: writes no sidecar of its own, the mark being install\'s', async () => {
    const root = await makeInstanceRoot();
    const archive = await writeArchive(root, 'foo.7z');
    const meta = await writeMeta(root, 'foo.7z');
    const before = await readFile(meta, 'utf8');
    installFromArchive.mockResolvedValueOnce({ applied: true, wrote: true, isFomod: false });

    registerModInstallForDownloadedFile(accessTo(root), fakeInstance(), recordingReporter(), installDeps());
    invoke('modbench.mod.install', node(root, 'foo.7z'));

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

    registerModInstallForDownloadedFile(accessTo(root), fakeInstance(), report, installDeps());
    invoke('modbench.mod.install', node(root, 'foo.7z'));

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
    let asked = false;
    const nameNewMod = () => { asked = true; return Promise.resolve(undefined); };

    registerModInstallForDownloadedFile(accessTo(root), fakeInstance(), recordingReporter(), installDeps({ nameNewMod }));
    invoke('modbench.mod.install', node(root, 'foo.7z'));

    await vi.waitFor(() => expect(asked).toBe(true));
    expect(installFromArchive).not.toHaveBeenCalled();
    expect(await readFile(meta, 'utf8')).not.toContain('installed=true');
  });

  it('install: a refusal from install surfaces an error and leaves the .meta untouched', async () => {
    const root = await makeInstanceRoot();
    await writeArchive(root, 'foo.7z');
    const meta = await writeMeta(root, 'foo.7z');
    installFromArchive.mockResolvedValueOnce({ applied: false, refusal: 'boom' });
    const report = recordingReporter();

    registerModInstallForDownloadedFile(accessTo(root), fakeInstance(), report, installDeps());
    invoke('modbench.mod.install', node(root, 'foo.7z'));

    await vi.waitFor(() => expect(report.reports).toHaveLength(1));
    expect(report.reports).toEqual([{ severity: 'error', message: 'Failed to install "foo.7z".', detail: 'boom' }]);
    expect(await readFile(meta, 'utf8')).not.toContain('installed=true');
  });

  it('install: a FOMOD archive installs and the notice names the mod install made', async () => {
    const root = await makeInstanceRoot();
    await writeArchive(root, 'foo.7z');
    installFromArchive.mockResolvedValueOnce({ applied: true, wrote: true, isFomod: true });
    const warnIfFomod = vi.fn();

    registerModInstallForDownloadedFile(accessTo(root), fakeInstance(), recordingReporter(), installDeps({ warnIfFomod }));
    invoke('modbench.mod.install', node(root, 'foo.7z'));

    await vi.waitFor(() => expect(warnIfFomod).toHaveBeenCalledWith('foo', true));
  });

  it('open: OS-opens the archive and asks nothing, whether or not there is a .meta', async () => {
    const root = await makeInstanceRoot();
    const archive = await writeArchive(root, 'foo.7z');
    await writeMeta(root, 'foo.7z');

    registerDownloadsSingleRowCommands(recordingReporter(), () => []);
    invoke('modbench.downloadedFile.open', node(root, 'foo.7z', { hasMeta: true }));

    await vi.waitFor(() => expect(openExternal).toHaveBeenCalled());
    expect(calledFsPath(openExternal)).toBe(archive);
    expect(showQuickPick).not.toHaveBeenCalled();
    expect(showTextDocument).not.toHaveBeenCalled();
  });

  it('open: is a no-op when invoked with no node', async () => {
    registerDownloadsSingleRowCommands(recordingReporter(), () => []);
    await invoke('modbench.downloadedFile.open', undefined);
    expect(openExternal).not.toHaveBeenCalled();
  });

  it('open: on failure, logs and surfaces an error notification naming the action and row', async () => {
    const root = await makeInstanceRoot();
    await writeArchive(root, 'foo.7z');
    openExternal.mockRejectedValueOnce(new Error('no handler for this file type'));
    const report = recordingReporter();

    registerDownloadsSingleRowCommands(report, () => []);
    invoke('modbench.downloadedFile.open', node(root, 'foo.7z'));

    await vi.waitFor(() => expect(report.reports).toHaveLength(1));
    expect(report.reports).toEqual([
      { severity: 'error', message: 'Open File for "foo.7z" failed.', detail: 'no handler for this file type' },
    ]);
  });

  it('open .meta: opens the sidecar in the editor and asks nothing', async () => {
    const root = await makeInstanceRoot();
    const meta = await writeMeta(root, 'foo.7z');

    registerDownloadsSingleRowCommands(recordingReporter(), () => []);
    invoke('modbench.downloadedFile.openMeta', node(root, 'foo.7z', { hasMeta: true }));

    await vi.waitFor(() => expect(showTextDocument).toHaveBeenCalled());
    expect(calledFsPath(showTextDocument)).toBe(meta);
    expect(openExternal).not.toHaveBeenCalled();
    expect(showQuickPick).not.toHaveBeenCalled();
  });

  it('open .meta: is a no-op when invoked with no node', async () => {
    registerDownloadsSingleRowCommands(recordingReporter(), () => []);
    await invoke('modbench.downloadedFile.openMeta', undefined);
    expect(showTextDocument).not.toHaveBeenCalled();
  });

  it('open .meta: on failure, logs and surfaces an error notification naming the action and row', async () => {
    const root = await makeInstanceRoot();
    await writeMeta(root, 'foo.7z');
    showTextDocument.mockRejectedValueOnce(new Error('file changed on disk'));
    const report = recordingReporter();

    registerDownloadsSingleRowCommands(report, () => []);
    invoke('modbench.downloadedFile.openMeta', node(root, 'foo.7z', { hasMeta: true }));

    await vi.waitFor(() => expect(report.reports).toHaveLength(1));
    expect(report.reports).toEqual([
      { severity: 'error', message: 'Open Meta File for "foo.7z" failed.', detail: 'file changed on disk' },
    ]);
  });
});

const ROW_NEXUS_IDS_READ_OFF_THE_SIDECAR = { modID: '111', fileID: '999' };

interface FakeUpgradeItem { label: string; description?: string; choice: unknown }

describe('registerDownloadsSingleRowCommands: the upgrade pick', () => {
  beforeEach(() => vi.clearAllMocks());

  it('shows one row per candidate — file-id match named and first — plus a trailing new-mod row, and pre-selects the file-id match', async () => {
    const root = await makeInstanceRoot();
    await writeArchive(root, 'foo.7z');
    const instance = fakeInstance([
      mod({ name: 'No Match', nexusId: '111', version: '1.0' }),
      mod({ name: 'The Match', nexusId: '111', version: '2.0', installedFiles: [{ modid: '111', fileid: '999' }] }),
    ]);
    const { qp, escape } = makeFakeQuickPickWhoseHideFiresOnDidHideAsTheRealOneDoes<FakeUpgradeItem>();
    createQuickPick.mockReturnValue(qp);

    registerModInstallForDownloadedFile(accessTo(root), instance, recordingReporter(), installDeps());
    invoke('modbench.mod.install', node(root, 'foo.7z', ROW_NEXUS_IDS_READ_OFF_THE_SIDECAR));
    await vi.waitFor(() => expect(createQuickPick).toHaveBeenCalled());
    escape();

    expect(qp.items).toEqual([
      { label: 'The Match (v2.0)', description: 'File ID match', choice: { kind: 'upgrade', name: 'The Match' } },
      { label: 'No Match (v1.0)', description: undefined, choice: { kind: 'upgrade', name: 'No Match' } },
      { label: 'Install as a new mod…', choice: { kind: 'new' } },
    ]);
    expect(qp.activeItems).toEqual([{ label: 'The Match (v2.0)', description: 'File ID match', choice: { kind: 'upgrade', name: 'The Match' } }]);
  });

  it('labels an installationFile match "Installed from this file" and pre-selects it, with no fileId match present', async () => {
    const root = await makeInstanceRoot();
    await writeArchive(root, 'foo.7z');
    const instance = fakeInstance([
      mod({ name: 'Harder VATS', nexusId: '111', version: '1.0', archiveFilename: 'foo.7z' }),
    ]);
    const { qp, escape } = makeFakeQuickPickWhoseHideFiresOnDidHideAsTheRealOneDoes<FakeUpgradeItem>();
    createQuickPick.mockReturnValue(qp);

    registerModInstallForDownloadedFile(accessTo(root), instance, recordingReporter(), installDeps());
    invoke('modbench.mod.install', node(root, 'foo.7z', ROW_NEXUS_IDS_READ_OFF_THE_SIDECAR));
    await vi.waitFor(() => expect(createQuickPick).toHaveBeenCalled());
    escape();

    const tier2Item = { label: 'Harder VATS (v1.0)', description: 'Installed from this file', choice: { kind: 'upgrade', name: 'Harder VATS' } };
    expect(qp.items).toEqual([tier2Item, { label: 'Install as a new mod…', choice: { kind: 'new' } }]);
    expect(qp.activeItems).toEqual([tier2Item]);
  });

  it('hides the installationFile label when a fileId match exists elsewhere in the pool', async () => {
    const root = await makeInstanceRoot();
    await writeArchive(root, 'foo.7z');
    const instance = fakeInstance([
      mod({ name: 'By Name', nexusId: '111', version: '1.0', archiveFilename: 'foo.7z' }),
      mod({ name: 'By File Id', nexusId: '111', version: '2.0', installedFiles: [{ modid: '111', fileid: '999' }] }),
    ]);
    const { qp, escape } = makeFakeQuickPickWhoseHideFiresOnDidHideAsTheRealOneDoes<FakeUpgradeItem>();
    createQuickPick.mockReturnValue(qp);

    registerModInstallForDownloadedFile(accessTo(root), instance, recordingReporter(), installDeps());
    invoke('modbench.mod.install', node(root, 'foo.7z', ROW_NEXUS_IDS_READ_OFF_THE_SIDECAR));
    await vi.waitFor(() => expect(createQuickPick).toHaveBeenCalled());
    escape();

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
    const { qp, escape } = makeFakeQuickPickWhoseHideFiresOnDidHideAsTheRealOneDoes<FakeUpgradeItem>();
    createQuickPick.mockReturnValue(qp);

    registerModInstallForDownloadedFile(accessTo(root), instance, recordingReporter(), installDeps());
    invoke('modbench.mod.install', node(root, 'foo.7z', ROW_NEXUS_IDS_READ_OFF_THE_SIDECAR));
    await vi.waitFor(() => expect(createQuickPick).toHaveBeenCalled());
    escape();

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
    const { qp, accept } = makeFakeQuickPickWhoseHideFiresOnDidHideAsTheRealOneDoes<FakeUpgradeItem>();
    createQuickPick.mockReturnValue(qp);
    installFromArchive.mockResolvedValueOnce({ applied: true, wrote: true, isFomod: false });
    const nameNewMod = vi.fn();

    registerModInstallForDownloadedFile(accessTo(root), instance, recordingReporter(), installDeps({ nameNewMod }));
    invoke('modbench.mod.install', node(root, 'foo.7z', ROW_NEXUS_IDS_READ_OFF_THE_SIDECAR));
    await vi.waitFor(() => expect(createQuickPick).toHaveBeenCalled());
    accept({ label: 'Harder VATS (v1.0)', choice: { kind: 'upgrade', name: 'Harder VATS' } });

    await vi.waitFor(() => {
      expect(installFromArchive).toHaveBeenCalledWith(
        expect.objectContaining({ instanceRoot: root }), { kind: 'upgrade', name: 'Harder VATS' }, archive,
        { gameName: 'Fallout 4', modID: '111', fileID: '999', version: undefined },
      );
    });
    expect(nameNewMod).not.toHaveBeenCalled();
  });

  it('choosing "Install as a new mod…" calls install with the new-mod shape', async () => {
    const root = await makeInstanceRoot();
    const archive = await writeArchive(root, 'foo.7z');
    const instance = fakeInstance([mod({ name: 'Harder VATS', nexusId: '111', version: '1.0' })]);
    const { qp, accept } = makeFakeQuickPickWhoseHideFiresOnDidHideAsTheRealOneDoes<FakeUpgradeItem>();
    createQuickPick.mockReturnValue(qp);
    installFromArchive.mockResolvedValueOnce({ applied: true, wrote: true, isFomod: false });

    registerModInstallForDownloadedFile(accessTo(root), instance, recordingReporter(), installDeps());
    invoke('modbench.mod.install', node(root, 'foo.7z', ROW_NEXUS_IDS_READ_OFF_THE_SIDECAR));
    await vi.waitFor(() => expect(createQuickPick).toHaveBeenCalled());
    accept({ label: 'Install as a new mod…', choice: { kind: 'new' } });

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
    const { qp, escape } = makeFakeQuickPickWhoseHideFiresOnDidHideAsTheRealOneDoes<FakeUpgradeItem>();
    createQuickPick.mockReturnValue(qp);

    registerModInstallForDownloadedFile(accessTo(root), instance, recordingReporter(), installDeps());
    invoke('modbench.mod.install', node(root, 'foo.7z', ROW_NEXUS_IDS_READ_OFF_THE_SIDECAR));
    await vi.waitFor(() => expect(createQuickPick).toHaveBeenCalled());
    escape();
    await afterAMacrotaskNotAMicrotask();

    expect(installFromArchive).not.toHaveBeenCalled();
  });

  it('a download with no mod id never shows the pick, even with installed mods present', async () => {
    const root = await makeInstanceRoot();
    const archive = await writeArchive(root, 'foo.7z');
    const instance = fakeInstance([mod({ name: 'Harder VATS', nexusId: '111', version: '1.0' })]);
    installFromArchive.mockResolvedValueOnce({ applied: true, wrote: true, isFomod: false });

    registerModInstallForDownloadedFile(accessTo(root), instance, recordingReporter(), installDeps());
    invoke('modbench.mod.install', node(root, 'foo.7z'));

    await vi.waitFor(() => {
      expect(installFromArchive).toHaveBeenCalledWith(
        expect.objectContaining({ instanceRoot: root }), { kind: 'new', name: 'foo' }, archive,
        { gameName: 'Fallout 4', modID: undefined, fileID: undefined, version: undefined },
      );
    });
    expect(createQuickPick).not.toHaveBeenCalled();
  });

  it('a download with a mod id no installed mod carries, and no installationFile match, never shows the pick', async () => {
    const root = await makeInstanceRoot();
    const archive = await writeArchive(root, 'foo.7z');
    const instance = fakeInstance([mod({ name: 'Harder VATS', nexusId: '111', version: '1.0' })]);
    installFromArchive.mockResolvedValueOnce({ applied: true, wrote: true, isFomod: false });

    registerModInstallForDownloadedFile(accessTo(root), instance, recordingReporter(), installDeps());
    invoke('modbench.mod.install', node(root, 'foo.7z', { modID: '222' }));

    await vi.waitFor(() => {
      expect(installFromArchive).toHaveBeenCalledWith(
        expect.objectContaining({ instanceRoot: root }), { kind: 'new', name: 'foo' }, archive,
        { gameName: 'Fallout 4', modID: '222', fileID: undefined, version: undefined },
      );
    });
    expect(createQuickPick).not.toHaveBeenCalled();
  });

  it('matches an installationFile candidate through the pick with a differently-cased filename', async () => {
    const root = await makeInstanceRoot();
    await writeArchive(root, 'Foo.7z');
    const instance = fakeInstance([
      mod({ name: 'Harder VATS', nexusId: '111', version: '1.0', archiveFilename: 'FOO.7Z' }),
    ]);
    const { qp, escape } = makeFakeQuickPickWhoseHideFiresOnDidHideAsTheRealOneDoes<FakeUpgradeItem>();
    createQuickPick.mockReturnValue(qp);

    registerModInstallForDownloadedFile(accessTo(root), instance, recordingReporter(), installDeps());
    invoke('modbench.mod.install', node(root, 'Foo.7z', ROW_NEXUS_IDS_READ_OFF_THE_SIDECAR));
    await vi.waitFor(() => expect(createQuickPick).toHaveBeenCalled());
    escape();

    expect(qp.items).toEqual([
      { label: 'Harder VATS (v1.0)', description: 'Installed from this file', choice: { kind: 'upgrade', name: 'Harder VATS' } },
      { label: 'Install as a new mod…', choice: { kind: 'new' } },
    ]);
  });
});

describe('registerDownloadsMultiRowCommands', () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => {
    trash.mockReset();
  });

  it('registers delete, exclude and include', () => {
    registerDownloadsMultiRowCommands(accessTo('/instance'), instanceThatReads, recordingReporter(), scriptedDialog(), trash, downloadsLog, () => []);
    const ids = registerCommand.mock.calls.map((c) => c[0]);
    expect(ids).toEqual(expect.arrayContaining([
      'modbench.downloadedFile.delete',
      'modbench.downloadedFile.exclude',
      'modbench.downloadedFile.include',
    ]));
  });

  it('hide applies to the whole selection, not just the clicked row', async () => {
    const root = await makeInstanceRoot();
    await writeArchive(root, 'a.7z');
    await writeArchive(root, 'b.7z');
    const metaA = await writeMeta(root, 'a.7z');
    const metaB = await writeMeta(root, 'b.7z');

    registerDownloadsMultiRowCommands(accessTo(root), instanceThatReads, recordingReporter(), scriptedDialog(), trash, downloadsLog, () => []);
    invoke('modbench.downloadedFile.exclude', node(root, 'a.7z'), [node(root, 'a.7z'), node(root, 'b.7z')]);

    await vi.waitFor(async () => {
      expect(await readFile(metaA, 'utf8')).toContain('removed=true');
      expect(await readFile(metaB, 'utf8')).toContain('removed=true');
    });
  });

  it('is idempotent over a mixed excluded/included selection — exclude leaves both excluded, no error', async () => {
    const root = await makeInstanceRoot();
    await writeArchive(root, 'already-excluded.7z');
    await writeArchive(root, 'visible.7z');
    const already = await writeMeta(root, 'already-excluded.7z', '[General]\r\nremoved=true\r\n');
    const visible = await writeMeta(root, 'visible.7z');

    registerDownloadsMultiRowCommands(accessTo(root), instanceThatReads, recordingReporter(), scriptedDialog(), trash, downloadsLog, () => []);
    invoke('modbench.downloadedFile.exclude', node(root, 'visible.7z'), [node(root, 'already-excluded.7z'), node(root, 'visible.7z')]);

    await vi.waitFor(async () => {
      expect(await readFile(already, 'utf8')).toContain('removed=true');
      expect(await readFile(visible, 'utf8')).toContain('removed=true');
    });
    expect(showErrorMessage).not.toHaveBeenCalled();
  });

  it('is idempotent over a mixed selection for unhide too — both end up visible, no error, the already-visible one untouched', async () => {
    const root = await makeInstanceRoot();
    await writeArchive(root, 'excluded.7z');
    await writeArchive(root, 'already-visible.7z');
    const excluded = await writeMeta(root, 'excluded.7z', '[General]\r\nremoved=true\r\n');
    const already = await writeMeta(root, 'already-visible.7z');

    registerDownloadsMultiRowCommands(accessTo(root), instanceThatReads, recordingReporter(), scriptedDialog(), trash, downloadsLog, () => []);
    await invoke('modbench.downloadedFile.include', node(root, 'excluded.7z', { excluded: true }), [node(root, 'excluded.7z', { excluded: true }), node(root, 'already-visible.7z')]);

    expect(await readFile(excluded, 'utf8')).toContain('removed=false');
    expect(await readFile(already, 'utf8')).toBe('[General]\r\n');
    expect(showErrorMessage).not.toHaveBeenCalled();
  });

  it('exclude: a refused write, from a stale row with no archive on disk, is reported once as the selection outcome', async () => {
    const root = await makeInstanceRoot();
    const report = recordingReporter();

    registerDownloadsMultiRowCommands(accessTo(root), instanceThatReads, report, scriptedDialog(), trash, downloadsLog, () => []);
    invoke('modbench.downloadedFile.exclude', node(root, 'foo.7z'));

    await vi.waitFor(() => expect(report.reports).toHaveLength(1));
    expect(present(report.reports[0], 'the one report').message).toBe('Could not exclude 1 of 1 downloaded files.');
  });

  it('exclude: sets removed=true on the .meta sidecar (clicked row alone, no selection array)', async () => {
    const root = await makeInstanceRoot();
    await writeArchive(root, 'foo.7z');
    const meta = await writeMeta(root, 'foo.7z');

    registerDownloadsMultiRowCommands(accessTo(root), instanceThatReads, recordingReporter(), scriptedDialog(), trash, downloadsLog, () => []);
    invoke('modbench.downloadedFile.exclude', node(root, 'foo.7z'));

    await vi.waitFor(async () => {
      expect(await readFile(meta, 'utf8')).toContain('removed=true');
    });
  });

  it('include: clears removed to false on the .meta sidecar (clicked row alone, no selection array)', async () => {
    const root = await makeInstanceRoot();
    await writeArchive(root, 'foo.7z');
    const meta = await writeMeta(root, 'foo.7z', '[General]\r\nremoved=true\r\n');

    registerDownloadsMultiRowCommands(accessTo(root), instanceThatReads, recordingReporter(), scriptedDialog(), trash, downloadsLog, () => []);
    invoke('modbench.downloadedFile.include', node(root, 'foo.7z', { excluded: true }));

    await vi.waitFor(async () => {
      expect(await readFile(meta, 'utf8')).toContain('removed=false');
    });
  });

  it('delete falls back to the clicked row alone when no selection array is passed', async () => {
    const root = await makeInstanceRoot();
    await writeArchive(root, 'foo.7z');
    const ask = scriptedDialog('Delete');

    registerDownloadsMultiRowCommands(accessTo(root), instanceThatReads, recordingReporter(), ask, trash, downloadsLog, () => []);
    invoke('modbench.downloadedFile.delete', node(root, 'foo.7z'));

    await vi.waitFor(() => expect(trash).toHaveBeenCalledTimes(1));
    assertAskedOnce(ask, { messageContains: '"foo.7z"', buttons: ['Delete'] });
  });

  it('delete: when the user dismisses the confirmation instead of choosing Delete, does not trash anything', async () => {
    const root = await makeInstanceRoot();
    await writeArchive(root, 'foo.7z');
    const ask = scriptedDialog(undefined);

    registerDownloadsMultiRowCommands(accessTo(root), instanceThatReads, recordingReporter(), ask, trash, downloadsLog, () => []);
    await invoke('modbench.downloadedFile.delete', node(root, 'foo.7z'));

    expect(ask.asked).toHaveLength(1);
    expect(trash).not.toHaveBeenCalled();
  });

  it('delete: on confirm-accept, trashes the archive (and its .meta, if present)', async () => {
    const root = await makeInstanceRoot();
    const archive = await writeArchive(root, 'foo.7z');
    const meta = await writeMeta(root, 'foo.7z');

    registerDownloadsMultiRowCommands(accessTo(root), instanceThatReads, recordingReporter(), scriptedDialog('Delete'), trash, downloadsLog, () => []);
    invoke('modbench.downloadedFile.delete', node(root, 'foo.7z'));

    await vi.waitFor(() => expect(trash).toHaveBeenCalledTimes(2));
    expect(trashedPaths()).toEqual(expect.arrayContaining([archive, meta]));
  });

});

describe('a Downloads gesture that writes ends on the Instance loader\'s read, with the view\'s progress bar open throughout', () => {
  beforeEach(() => { vi.clearAllMocks(); progressSteps.length = 0; });
  afterEach(() => { trash.mockReset(); });

  const opens = 'progress opens on modbench.downloads';
  const reads = 'Instance loader: read every file again';

  const instanceReadingTheMeta = (meta: string): Pick<Instance, 'value' | 'refresh'> => ({
    ...fakeInstance(),
    refresh: async () => {
      progressSteps.push(`read finds ${(await readFile(meta, 'utf8')).includes('removed=true') ? 'excluded' : 'included'}`);
    },
  });

  it('exclude writes the .meta, then the read, then the bar closes', async () => {
    const root = await makeInstanceRoot();
    await writeArchive(root, 'foo.7z');
    const meta = await writeMeta(root, 'foo.7z');

    registerDownloadsMultiRowCommands(accessTo(root), instanceReadingTheMeta(meta), recordingReporter(), scriptedDialog(), trash, downloadsLog, () => []);
    await invoke('modbench.downloadedFile.exclude', node(root, 'foo.7z'));

    expect(progressSteps).toEqual([opens, 'read finds excluded', 'progress closes']);
  });

  it('include writes the .meta, then the read, then the bar closes', async () => {
    const root = await makeInstanceRoot();
    await writeArchive(root, 'foo.7z');
    const meta = await writeMeta(root, 'foo.7z', '[General]\r\nremoved=true\r\n');

    registerDownloadsMultiRowCommands(accessTo(root), instanceReadingTheMeta(meta), recordingReporter(), scriptedDialog(), trash, downloadsLog, () => []);
    await invoke('modbench.downloadedFile.include', node(root, 'foo.7z', { excluded: true }));

    expect(progressSteps).toEqual([opens, 'read finds included', 'progress closes']);
  });

  it('a selection of several runs one bar and one read', async () => {
    const root = await makeInstanceRoot();
    await writeArchive(root, 'a.7z');
    await writeArchive(root, 'b.7z');
    await writeMeta(root, 'a.7z');
    await writeMeta(root, 'b.7z');

    registerDownloadsMultiRowCommands(accessTo(root), instanceThatReads, recordingReporter(), scriptedDialog(), trash, downloadsLog, () => []);
    await invoke('modbench.downloadedFile.exclude', node(root, 'a.7z'), [node(root, 'a.7z'), node(root, 'b.7z')]);

    expect(progressSteps).toEqual([opens, reads, 'progress closes']);
  });

  it('a refused exclude still ends on the read', async () => {
    const root = await makeInstanceRoot();

    registerDownloadsMultiRowCommands(accessTo(root), instanceThatReads, recordingReporter(), scriptedDialog(), trash, downloadsLog, () => []);
    await invoke('modbench.downloadedFile.exclude', node(root, 'gone.7z'));

    expect(progressSteps).toEqual([opens, reads, 'progress closes']);
  });

  it.each([
    ['exclude', 'modbench.downloadedFile.exclude', { excluded: true }, '[General]\r\n', 'removed=true'],
    ['include', 'modbench.downloadedFile.include', { excluded: false }, '[General]\r\nremoved=true\r\n', 'removed=false'],
  ])('%s still writes for a row the view shows already in that state, since the disk decides', async (_name, command, row, before, after) => {
    const root = await makeInstanceRoot();
    await writeArchive(root, 'foo.7z');
    const meta = await writeMeta(root, 'foo.7z', before);

    registerDownloadsMultiRowCommands(accessTo(root), instanceThatReads, recordingReporter(), scriptedDialog(), trash, downloadsLog, () => []);
    await invoke(command, node(root, 'foo.7z', row));

    expect(progressSteps).toEqual([opens, reads, 'progress closes']);
    expect(await readFile(meta, 'utf8')).toContain(after);
  });

  it('delete trashes, then the read, then the bar closes', async () => {
    const root = await makeInstanceRoot();
    const archive = await writeArchive(root, 'foo.7z');
    trash.mockImplementation((path) => { progressSteps.push(`trash ${path === archive ? 'archive' : 'meta'}`); return Promise.resolve(); });

    registerDownloadsMultiRowCommands(accessTo(root), instanceThatReads, recordingReporter(), scriptedDialog('Delete'), trash, downloadsLog, () => []);
    await invoke('modbench.downloadedFile.delete', node(root, 'foo.7z'));

    expect(progressSteps).toEqual([opens, 'trash archive', reads, 'progress closes']);
  });

  it('a refused delete still ends on the read', async () => {
    const root = await makeInstanceRoot();
    await writeArchive(root, 'foo.7z');
    trash.mockRejectedValue(new Error('locked'));

    registerDownloadsMultiRowCommands(accessTo(root), instanceThatReads, recordingReporter(), scriptedDialog('Delete'), trash, downloadsLog, () => []);
    await invoke('modbench.downloadedFile.delete', node(root, 'foo.7z'));

    expect(progressSteps).toEqual([opens, reads, 'progress closes']);
  });

  it('a declined delete opens no bar', async () => {
    const root = await makeInstanceRoot();
    await writeArchive(root, 'foo.7z');

    registerDownloadsMultiRowCommands(accessTo(root), instanceThatReads, recordingReporter(), scriptedDialog(undefined), trash, downloadsLog, () => []);
    await invoke('modbench.downloadedFile.delete', node(root, 'foo.7z'));

    expect(progressSteps).toEqual([]);
  });

  it('install over a downloaded file installs, then the read, then the bar closes', async () => {
    const root = await makeInstanceRoot();
    await writeArchive(root, 'foo.7z');
    installFromArchive.mockImplementationOnce(() => { progressSteps.push('install'); return Promise.resolve({ applied: true, wrote: true, isFomod: false }); });

    registerModInstallForDownloadedFile(accessTo(root), instanceThatReads, recordingReporter(), installDeps());
    await invoke('modbench.mod.install', node(root, 'foo.7z'));

    expect(progressSteps).toEqual([opens, 'install', reads, 'progress closes']);
  });

  it('a refused install still ends on the read', async () => {
    const root = await makeInstanceRoot();
    await writeArchive(root, 'foo.7z');
    installFromArchive.mockResolvedValueOnce({ applied: false, refusal: 'boom' });

    registerModInstallForDownloadedFile(accessTo(root), instanceThatReads, recordingReporter(), installDeps());
    await invoke('modbench.mod.install', node(root, 'foo.7z'));

    expect(progressSteps).toEqual([opens, reads, 'progress closes']);
  });

  it('Esc at the upgrade pick opens no bar', async () => {
    const root = await makeInstanceRoot();
    await writeArchive(root, 'foo.7z');
    const { qp, escape } = makeFakeQuickPickWhoseHideFiresOnDidHideAsTheRealOneDoes<FakeUpgradeItem>();
    createQuickPick.mockReturnValue(qp);
    const installed = fakeInstance([mod({ name: 'Foo Mod', nexusId: '111', version: '1.0' })]);

    registerModInstallForDownloadedFile(accessTo(root), installed, recordingReporter(), installDeps());
    const running = invoke('modbench.mod.install', node(root, 'foo.7z', ROW_NEXUS_IDS_READ_OFF_THE_SIDECAR));
    await vi.waitFor(() => expect(createQuickPick).toHaveBeenCalled());
    escape();
    await running;

    expect(progressSteps).toEqual([]);
  });

  it('a read that fails after the gesture leaves the rows and says so', async () => {
    const root = await makeInstanceRoot();
    await writeArchive(root, 'foo.7z');
    await writeMeta(root, 'foo.7z');
    const disk = new FakeInstance(instanceValueFixture({ downloads: { kind: 'listed', rows: [downloadRowFixture('foo.7z', {}, root)] } }));
    const provider = new DownloadsProvider({ instance: disk });
    const instance = { value: disk.value, refresh: () => { disk.fail('locked'); return Promise.resolve(); } };

    registerDownloadsMultiRowCommands(accessTo(root), instance, recordingReporter(), scriptedDialog(), trash, downloadsLog, () => []);
    await invoke('modbench.downloadedFile.exclude', node(root, 'foo.7z'));

    expect((await provider.getChildren()).map((n) => n.kind === 'download' && n.row.name)).toEqual(['foo.7z']);
    expect(provider.viewMessage()).toBe('Showing the last good read: locked');
  });

  it('declining to name the mod opens no bar', async () => {
    const root = await makeInstanceRoot();
    await writeArchive(root, 'foo.7z');

    registerModInstallForDownloadedFile(accessTo(root), instanceThatReads, recordingReporter(), installDeps({ nameNewMod: () => Promise.resolve(undefined) }));
    await invoke('modbench.mod.install', node(root, 'foo.7z'));

    expect(progressSteps).toEqual([]);
  });
});

describe('modbench.downloadedFile.exclude / include — a multi-name selection', () => {
  beforeEach(() => vi.clearAllMocks());

  it('given the right-clicked row and the selection, excludes the whole selection, refuses the gone file, and reports once', async () => {
    const root = await makeInstanceRoot();
    await writeArchive(root, 'a.7z');
    await writeArchive(root, 'b.7z');
    const reporter = recordingReporter();

    registerDownloadsMultiRowCommands(accessTo(root), instanceThatReads, reporter, scriptedDialog(), trash, downloadsLog, () => []);
    const outcome = await invoke(
      'modbench.downloadedFile.exclude',
      node(root, 'b.7z'),
      [node(root, 'a.7z'), node(root, 'b.7z'), node(root, 'gone.7z')],
    );

    const recordedCall = present(reporter.selectionOutcomeCalls[0], 'the one selection-outcome call');
    assertSelectionOutcome(recordedCall.outcome, {
      landed: ['a.7z', 'b.7z'],
      refused: [{ item: 'gone.7z', reasonContains: 'gone.7z' }],
    });
    expect(outcome).toEqual(recordedCall.outcome);
    expect(recordedCall.message).toBe('Could not exclude 1 of 3 downloaded files.');
    expect(await readFile(join(root, 'downloads', 'a.7z.meta'), 'utf8')).toContain('removed=true');
    expect(await readFile(join(root, 'downloads', 'b.7z.meta'), 'utf8')).toContain('removed=true');
  });

  it('given the right-clicked row and the selection, includes the whole selection, refuses the gone file, and reports once', async () => {
    const root = await makeInstanceRoot();
    await writeArchive(root, 'a.7z');
    await writeMeta(root, 'a.7z', '[General]\r\nremoved=true\r\n');
    await writeArchive(root, 'b.7z');
    await writeMeta(root, 'b.7z', '[General]\r\nremoved=true\r\n');
    const reporter = recordingReporter();

    registerDownloadsMultiRowCommands(accessTo(root), instanceThatReads, reporter, scriptedDialog(), trash, downloadsLog, () => []);
    const outcome = await invoke(
      'modbench.downloadedFile.include',
      node(root, 'b.7z', { excluded: true }),
      [node(root, 'a.7z', { excluded: true }), node(root, 'b.7z', { excluded: true }), node(root, 'gone.7z', { excluded: true })],
    );

    const recordedCall = present(reporter.selectionOutcomeCalls[0], 'the one selection-outcome call');
    assertSelectionOutcome(recordedCall.outcome, {
      landed: ['a.7z', 'b.7z'],
      refused: [{ item: 'gone.7z', reasonContains: 'gone.7z' }],
    });
    expect(outcome).toEqual(recordedCall.outcome);
    expect(recordedCall.message).toBe('Could not include 1 of 3 downloaded files.');
    expect(await readFile(join(root, 'downloads', 'a.7z.meta'), 'utf8')).toContain('removed=false');
    expect(await readFile(join(root, 'downloads', 'b.7z.meta'), 'utf8')).toContain('removed=false');
  });

  it('an empty selection excludes nothing and reports nothing', async () => {
    const root = await makeInstanceRoot();
    const reporter = recordingReporter();

    registerDownloadsMultiRowCommands(accessTo(root), instanceThatReads, reporter, scriptedDialog(), trash, downloadsLog, () => []);
    const outcome = await invoke('modbench.downloadedFile.exclude', undefined, []);

    expect(outcome).toEqual({ landed: [], refused: [] });
    expect(reporter.reports).toEqual([]);
    expect(reporter.selectionOutcomeCalls).toEqual([]);
  });
});

describe('modbench.downloadedFile.delete — a multi-name selection', () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => trash.mockReset());

  it('confirms once for the whole batch, then trashes every archive (+ its .meta, if present)', async () => {
    const root = await makeInstanceRoot();
    const a = await writeArchive(root, 'a.7z');
    const b = await writeArchive(root, 'b.7z');
    await writeMeta(root, 'a.7z');
    const ask = scriptedDialog('Delete');

    registerDownloadsMultiRowCommands(accessTo(root), instanceThatReads, recordingReporter(), ask, trash, downloadsLog, () => []);
    invoke('modbench.downloadedFile.delete', node(root, 'a.7z'), [node(root, 'a.7z'), node(root, 'b.7z')]);

    await vi.waitFor(() => expect(trashedPaths()).toEqual(expect.arrayContaining([a, b])));
    assertAskedOnce(ask, { messageContains: '2 items', buttons: ['Delete'] });
  });

  it('Esc deletes nothing and says nothing', async () => {
    const root = await makeInstanceRoot();
    await writeArchive(root, 'a.7z');
    await writeArchive(root, 'b.7z');
    const reporter = recordingReporter();
    const ask = scriptedDialog(undefined);

    registerDownloadsMultiRowCommands(accessTo(root), instanceThatReads, reporter, ask, trash, downloadsLog, () => []);
    const outcome = await invoke('modbench.downloadedFile.delete', node(root, 'a.7z'), [node(root, 'a.7z'), node(root, 'b.7z')]);

    expect(outcome).toEqual({ landed: [], refused: [] });
    expect(ask.asked).toHaveLength(1);
    expect(trash).not.toHaveBeenCalled();
    expect(reporter.reports).toEqual([]);
    expect(reporter.selectionOutcomeCalls).toEqual([]);
  });

  it('given the right-clicked row and the selection, deletes the whole selection in one call, refuses the file that cannot go, and reports once', async () => {
    const root = await makeInstanceRoot();
    const a = await writeArchive(root, 'a.7z');
    const b = await writeArchive(root, 'b.7z');
    const locked = await writeArchive(root, 'locked.7z');
    trash.mockImplementation(async (path) => {
      if (path === locked) throw new Error('EPERM: operation not permitted');
      await rm(path);
    });
    const reporter = recordingReporter();
    const ask = scriptedDialog('Delete');

    registerDownloadsMultiRowCommands(accessTo(root), instanceThatReads, reporter, ask, trash, downloadsLog, () => []);
    const outcome = await invoke(
      'modbench.downloadedFile.delete',
      node(root, 'b.7z'),
      [node(root, 'a.7z'), node(root, 'b.7z'), node(root, 'locked.7z')],
    );

    const refused = { item: { name: 'locked.7z' }, reason: 'EPERM: operation not permitted' };
    expect(outcome).toEqual({ landed: [{ name: 'a.7z' }, { name: 'b.7z' }], refused: [refused] });
    expect(vi.mocked(deleteDownloads).mock.calls.map((call) => call[1].map((file) => file.name))).toEqual([['a.7z', 'b.7z', 'locked.7z']]);
    assertAskedOnce(ask, { messageContains: '3 items', buttons: ['Delete'] });
    expect([await onDisk(a), await onDisk(b), await onDisk(locked)]).toEqual([false, false, true]);
    expect(reporter.selectionOutcomeCalls).toEqual([
      { message: 'Could not delete 1 of 3 downloaded files.', outcome },
    ]);
    expect(reporter.reports).toEqual([{
      severity: 'error',
      message: 'Could not delete 1 of 3 downloaded files.',
      detail: '"locked.7z" (EPERM: operation not permitted)',
    }]);
  });

  it('a selection array of exactly one item still uses the singular confirmation text', async () => {
    const root = await makeInstanceRoot();
    await writeArchive(root, 'foo.7z');
    const ask = scriptedDialog('Delete');

    registerDownloadsMultiRowCommands(accessTo(root), instanceThatReads, recordingReporter(), ask, trash, downloadsLog, () => []);
    invoke('modbench.downloadedFile.delete', node(root, 'foo.7z'), [node(root, 'foo.7z')]);

    await vi.waitFor(() => expect(trash).toHaveBeenCalledTimes(1));
    assertAskedOnce(ask, { messageContains: '"foo.7z"', buttons: ['Delete'] });
  });

  it('names the one file, says trash, and says the installed mod is untouched', async () => {
    const root = await makeInstanceRoot();
    await writeArchive(root, 'foo.7z');
    const ask = scriptedDialog('Delete');

    registerDownloadsMultiRowCommands(accessTo(root), instanceThatReads, recordingReporter(), ask, trash, downloadsLog, () => []);
    invoke('modbench.downloadedFile.delete', node(root, 'foo.7z'));

    await vi.waitFor(() => expect(ask.asked).toHaveLength(1));
    const question = present(ask.asked[0], 'the one recorded question').message;
    expect(question).toContain('"foo.7z"');
    expect(question).toMatch(/trash/i);
    expect(question).toMatch(/installed mod.*untouched/i);
  });

  it('names the count for several files, says trash, and says the installed mod is untouched', async () => {
    const root = await makeInstanceRoot();
    await writeArchive(root, 'a.7z');
    await writeArchive(root, 'b.7z');
    const ask = scriptedDialog('Delete');

    registerDownloadsMultiRowCommands(accessTo(root), instanceThatReads, recordingReporter(), ask, trash, downloadsLog, () => []);
    invoke('modbench.downloadedFile.delete', node(root, 'a.7z'), [node(root, 'a.7z'), node(root, 'b.7z')]);

    await vi.waitFor(() => expect(ask.asked).toHaveLength(1));
    const question = present(ask.asked[0], 'the one recorded question').message;
    expect(question).toContain('2');
    expect(question).toMatch(/trash/i);
    expect(question).toMatch(/installed mod.*untouched/i);
  });

  it('a `.meta` left behind after the file landed is one Output line, no notification', async () => {
    const root = await makeInstanceRoot();
    const archive = await writeArchive(root, 'foo.7z');
    const meta = await writeMeta(root, 'foo.7z');
    trash.mockImplementation(async (path) => {
      if (path === meta) throw new Error('EPERM: operation not permitted');
      await rm(path);
    });
    const reporter = recordingReporter();

    registerDownloadsMultiRowCommands(accessTo(root), instanceThatReads, reporter, scriptedDialog('Delete'), trash, downloadsLog, () => []);
    const outcome = await invoke('modbench.downloadedFile.delete', node(root, 'foo.7z'));

    expect(outcome).toEqual({ landed: [{ name: 'foo.7z', metaLeftBehind: 'EPERM: operation not permitted' }], refused: [] });
    expect(await onDisk(archive)).toBe(false);
    expect(await onDisk(meta)).toBe(true);
    expect(downloadsLogLines).toEqual([
      '"foo.7z" was deleted, but its ".meta" could not be moved to the trash and was left behind: EPERM: operation not permitted',
    ]);
    expect(reporter.reports).toEqual([]);
  });

  it('with no clicked row and no selection array, as VS Code invokes a keybinding\'s command, deletes the view\'s own current selection', async () => {
    const root = await makeInstanceRoot();
    const a = await writeArchive(root, 'a.7z');
    const b = await writeArchive(root, 'b.7z');
    const ask = scriptedDialog('Delete');
    const viewSelection = () => [node(root, 'a.7z'), node(root, 'b.7z')];

    registerDownloadsMultiRowCommands(accessTo(root), instanceThatReads, recordingReporter(), ask, trash, downloadsLog, viewSelection);
    invoke('modbench.downloadedFile.delete');

    await vi.waitFor(() => expect(trashedPaths()).toEqual(expect.arrayContaining([a, b])));
    assertAskedOnce(ask, { messageContains: '2', buttons: ['Delete'] });
  });

  it('with no clicked row and an empty view selection, deletes nothing and asks nothing', async () => {
    const root = await makeInstanceRoot();
    const reporter = recordingReporter();
    const ask = scriptedDialog('Delete');

    registerDownloadsMultiRowCommands(accessTo(root), instanceThatReads, reporter, ask, trash, downloadsLog, () => []);
    const outcome = await invoke('modbench.downloadedFile.delete');

    expect(outcome).toEqual({ landed: [], refused: [] });
    expect(ask.asked).toEqual([]);
    expect(trash).not.toHaveBeenCalled();
  });
});

interface FakeSortItem { label: string; column: string; descending: boolean }

describe('registerDownloadsSortCommand', () => {
  beforeEach(() => vi.clearAllMocks());

  it('registers modbench.downloadedFile.sort', () => {
    registerDownloadsSortCommand(fakeDownloadsProvider());
    expect(registerCommand.mock.calls.map((c) => c[0])).toContain('modbench.downloadedFile.sort');
  });

  it('applies the picked option to DownloadsProvider.setSort', async () => {
    const provider = fakeDownloadsProvider();
    const { qp, accept } = makeFakeQuickPickWhoseHideFiresOnDidHideAsTheRealOneDoes<FakeSortItem>();
    createQuickPick.mockReturnValue(qp);

    registerDownloadsSortCommand(provider);
    invoke('modbench.downloadedFile.sort');
    await vi.waitFor(() => expect(createQuickPick).toHaveBeenCalled());
    accept({ label: 'Size (Largest First)', column: 'size', descending: true });

    await vi.waitFor(() => {
      expect(provider.setSort).toHaveBeenCalledWith('size', true);
    });
  });

  it('does nothing when Esc is pressed', async () => {
    const provider = fakeDownloadsProvider();
    const { qp, escape } = makeFakeQuickPickWhoseHideFiresOnDidHideAsTheRealOneDoes<FakeSortItem>();
    createQuickPick.mockReturnValue(qp);

    registerDownloadsSortCommand(provider);
    invoke('modbench.downloadedFile.sort');
    await vi.waitFor(() => expect(createQuickPick).toHaveBeenCalled());
    escape();

    await vi.waitFor(() => expect(qp.dispose).toHaveBeenCalled());
    expect(provider.setSort).not.toHaveBeenCalled();
  });

  it('pre-selects the item matching the provider\'s current sort', async () => {
    const provider = fakeDownloadsProvider({ column: 'size', descending: false });
    const { qp, escape } = makeFakeQuickPickWhoseHideFiresOnDidHideAsTheRealOneDoes<FakeSortItem>();
    createQuickPick.mockReturnValue(qp);

    registerDownloadsSortCommand(provider);
    invoke('modbench.downloadedFile.sort');
    await vi.waitFor(() => expect(createQuickPick).toHaveBeenCalled());
    escape();

    expect(qp.activeItems).toEqual([{ label: 'Size (Smallest First)', column: 'size', descending: false }]);
  });

  it('pre-selects Filetime (Newest First) at the default sort', async () => {
    const provider = fakeDownloadsProvider();
    const { qp, escape } = makeFakeQuickPickWhoseHideFiresOnDidHideAsTheRealOneDoes<FakeSortItem>();
    createQuickPick.mockReturnValue(qp);

    registerDownloadsSortCommand(provider);
    invoke('modbench.downloadedFile.sort');
    await vi.waitFor(() => expect(createQuickPick).toHaveBeenCalled());
    escape();

    expect(qp.activeItems).toEqual([{ label: 'Filetime (Newest First)', column: 'mtimeMs', descending: true }]);
  });
});

describe('registerDownloadsExcludedToggleCommands', () => {
  beforeEach(() => vi.clearAllMocks());

  it('registers modbench.downloadedFile.showExcluded and .hideExcluded', () => {
    registerDownloadsExcludedToggleCommands(fakeDownloadsProvider());
    expect(registerCommand.mock.calls.map((c) => c[0])).toEqual(expect.arrayContaining([
      'modbench.downloadedFile.showExcluded',
      'modbench.downloadedFile.hideExcluded',
    ]));
  });

  it('showExcluded turns excluded rows on and sets the context key true', () => {
    const provider = fakeDownloadsProvider();
    registerDownloadsExcludedToggleCommands(provider);

    invoke('modbench.downloadedFile.showExcluded');

    expect(provider.setShowExcluded).toHaveBeenCalledWith(true);
    expect(executeCommand).toHaveBeenCalledWith('setContext', 'modbench.downloadedFile.excludedShown', true);
  });

  it('hideExcluded turns excluded rows off and sets the context key false', () => {
    const provider = fakeDownloadsProvider();
    registerDownloadsExcludedToggleCommands(provider);

    invoke('modbench.downloadedFile.hideExcluded');

    expect(provider.setShowExcluded).toHaveBeenCalledWith(false);
    expect(executeCommand).toHaveBeenCalledWith('setContext', 'modbench.downloadedFile.excludedShown', false);
  });
});

describe('the Downloads gestures from the palette, handed no row, act on the view\'s selection', () => {
  beforeEach(() => vi.clearAllMocks());

  it('open opens the one selected file', async () => {
    const root = await makeInstanceRoot();
    const archive = await writeArchive(root, 'foo.7z');

    registerDownloadsSingleRowCommands(recordingReporter(), () => [node(root, 'foo.7z')]);
    await invoke('modbench.downloadedFile.open');

    expect(calledFsPath(openExternal)).toBe(archive);
  });

  it('open .meta opens the one selected file\'s .meta', async () => {
    const root = await makeInstanceRoot();
    await writeArchive(root, 'foo.7z');
    const meta = await writeMeta(root, 'foo.7z');

    registerDownloadsSingleRowCommands(recordingReporter(), () => [node(root, 'foo.7z', { hasMeta: true })]);
    await invoke('modbench.downloadedFile.openMeta');

    expect(calledFsPath(showTextDocument)).toBe(meta);
  });

  it('open opens nothing over a selection of several files', async () => {
    const root = await makeInstanceRoot();

    registerDownloadsSingleRowCommands(recordingReporter(), () => [node(root, 'a.7z'), node(root, 'b.7z')]);
    await invoke('modbench.downloadedFile.open');

    expect(openExternal).not.toHaveBeenCalled();
  });

  it('exclude and include take the whole selection', async () => {
    const root = await makeInstanceRoot();
    await writeArchive(root, 'a.7z');
    await writeArchive(root, 'b.7z');
    const metaA = await writeMeta(root, 'a.7z');
    const metaB = await writeMeta(root, 'b.7z');
    let selection = [node(root, 'a.7z'), node(root, 'b.7z')];

    registerDownloadsMultiRowCommands(accessTo(root), instanceThatReads, recordingReporter(), scriptedDialog(), trash, downloadsLog, () => selection);
    await invoke('modbench.downloadedFile.exclude');
    expect([await readFile(metaA, 'utf8'), await readFile(metaB, 'utf8')]).toEqual([
      expect.stringContaining('removed=true'), expect.stringContaining('removed=true'),
    ]);

    selection = [node(root, 'a.7z', { excluded: true }), node(root, 'b.7z', { excluded: true })];
    await invoke('modbench.downloadedFile.include');
    expect([await readFile(metaA, 'utf8'), await readFile(metaB, 'utf8')]).toEqual([
      expect.stringContaining('removed=false'), expect.stringContaining('removed=false'),
    ]);
  });
});
