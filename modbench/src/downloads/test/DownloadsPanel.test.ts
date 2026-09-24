import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { executeCommand, registerCommand, showErrorMessage, showTextDocument, showQuickPick, openExternal } = vi.hoisted(() => ({
  executeCommand: vi.fn(),
  registerCommand: vi.fn((_id: string, handler: (...args: unknown[]) => unknown) => ({ dispose: vi.fn(), handler })),
  showErrorMessage: vi.fn(),
  showTextDocument: vi.fn(),
  showQuickPick: vi.fn(),
  openExternal: vi.fn(),
}));

import { TreeItem, TreeItemCollapsibleState, ThemeIcon, ThemeColor, MarkdownString, type FakeUri } from '../../test/vscodeMock';
import { present } from '../../ports/present';

vi.mock('vscode', () => ({
  commands: { executeCommand, registerCommand },
  window: { showErrorMessage, showTextDocument, showQuickPick },
  env: { openExternal },
  Uri: {
    file: (p: string) => ({ fsPath: p, toString: () => `file://${p}` }),
    parse: (s: string) => ({ toString: () => s }),
  },
  ViewColumn: { One: 1 },
  TreeItem, TreeItemCollapsibleState, ThemeIcon, ThemeColor, MarkdownString,
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

import { mkdtemp, mkdir, writeFile, readFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  registerDownloadsHiddenToggleCommands,
  registerDownloadsMultiRowCommands,
  registerDownloadsSingleRowCommands,
  registerDownloadsSortCommand,
  type DownloadInstallDeps,
} from '../DownloadsPanel';
import { DownloadNode, type DownloadsProvider } from '../DownloadsProvider';
import type { DownloadRow } from '../../mo2Codecs/downloads';
import { deleteDownloads } from '../../downloadsCommands/downloads';
import type { MoveToTrash } from '../../ports/trash';
import type { Instance, InstanceValue } from '../../instanceLoader/instance';
import { recordingReporter, scriptedDialog, assertAskedOnce } from '../../test/surfacingDoubles';
import { downloadRowFixture } from '../../test/mo2/downloadRowFixture';
import { instanceValueFixture } from '../../test/mo2/instanceValueFixture';

// The row the Instance would publish for this instance root: its two paths are what the panel
// opens, so every gesture is driven by the same tree the test wrote.
const node = (root: string, name: string, row: Partial<DownloadRow> = {}): DownloadNode =>
  new DownloadNode(downloadRowFixture(name, row, root));

// No installed mods by default, so `selectUpgradeCandidates` finds none and the pick never
// shows — the shape every install test not about the pick itself relies on.
const fakeInstance = (
  mods: InstanceValue['mods'] = [], downloads: InstanceValue['downloads'] = [], gameRelease = 'Fallout4',
): Pick<Instance, 'value'> => ({
  value: instanceValueFixture({ mods, downloads, gameRelease }),
});

const mod = (over: Partial<InstanceValue['mods'][number]> & { name: string }): InstanceValue['mods'][number] => ({
  kind: 'mod',
  enabled: true,
  ...over,
});

const fakeDownloadsProvider = (): Pick<DownloadsProvider, 'setSort' | 'setShowHidden'> => ({
  setSort: vi.fn(), setShowHidden: vi.fn(),
});

// The composition root's two answers, doubled: a new mod keeps the name install proposed, and
// the FOMOD notice is recorded rather than shown.
const installDeps = (over: Partial<DownloadInstallDeps> = {}): DownloadInstallDeps => ({
  nameNewMod: (defaultName: string) => Promise.resolve(defaultName),
  warnIfFomod: vi.fn(),
  ...over,
});

// tmpdirs created via makeInstanceRoot() this test, cleaned up in afterEach even
// if the test fails partway through (an inline rm() at the end of a test body
// would be skipped by a failed assertion above it and leak the tmpdir).
let instanceRoots: string[] = [];

afterEach(async () => {
  await Promise.all(instanceRoots.map((root) => rm(root, { recursive: true, force: true })));
  instanceRoots = [];
});

async function makeInstanceRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'downloads-panel-'));
  await mkdir(join(root, 'downloads'), { recursive: true });
  instanceRoots.push(root);
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

// The composition root's trash, doubled: each call records the path it was handed.
const trash = vi.fn<MoveToTrash>();
const trashedPaths = (): string[] => trash.mock.calls.map(([path]) => path);

// vi.fn()'s own generic default types every call's args and return as `any`; this witnesses the
// one call this file's own test cares about, at the type the test itself expects.
function calledWith<T>(mockFn: { mock: { calls: T[][] } }, argIndex = 0): T {
  const call = present(mockFn.mock.calls[0], "the mock function's sole call");
  return present(call[argIndex], "the call's argument");
}

function invoke(commandId: string, ...args: unknown[]): unknown {
  const call = registerCommand.mock.calls.find((c) => c[0] === commandId);
  if (!call) throw new Error(`command not registered: ${commandId}`);
  return call[1](...args);
}

const onDisk = (path: string): Promise<boolean> => access(path).then(() => true, () => false);

// ── registerDownloadsSingleRowCommands ──────────────────────────────────────

describe('registerDownloadsSingleRowCommands', () => {
  beforeEach(() => vi.clearAllMocks());

  // View on Nexus is the mod's gesture, registered once for both views, so a second
  // registration here would make activation throw.
  it('registers install, open and open .meta, and leaves view on Nexus to the mod', () => {
    registerDownloadsSingleRowCommands('/instance', fakeInstance(), recordingReporter(), installDeps());
    expect(registerCommand.mock.calls.map((c) => c[0])).toEqual([
      'modbench.downloads.install',
      'modbench.downloadedFile.open',
      'modbench.downloadedFile.openMeta',
    ]);
  });

  it('invoking modbench.downloads.install with a DownloadNode installs that row\'s archive', async () => {
    const root = await makeInstanceRoot();
    const archive = await writeArchive(root, 'foo.7z');
    await writeMeta(root, 'foo.7z');
    installFromArchive.mockResolvedValueOnce({ applied: true, wrote: true, isFomod: false });

    registerDownloadsSingleRowCommands(root, fakeInstance(), recordingReporter(), installDeps());
    invoke('modbench.downloads.install', node(root, 'foo.7z'));

    await vi.waitFor(() => {
      expect(installFromArchive).toHaveBeenCalledWith(
        root, { kind: 'new', name: 'foo' }, archive,
        { gameName: 'Fallout4', modID: undefined, fileID: undefined, version: undefined });
    });
  });

  it('carries the row\'s modID, fileID and version into install, reading no sidecar', async () => {
    const root = await makeInstanceRoot();
    const archive = await writeArchive(root, 'foo.7z');
    installFromArchive.mockResolvedValueOnce({ applied: true, wrote: true, isFomod: false });

    registerDownloadsSingleRowCommands(root, fakeInstance(), recordingReporter(), installDeps());
    invoke('modbench.downloads.install', node(root, 'foo.7z', { modID: '123', fileID: '456', version: '2.0' }));

    await vi.waitFor(() => {
      expect(installFromArchive).toHaveBeenCalledWith(
        root, { kind: 'new', name: 'foo' }, archive,
        { gameName: 'Fallout4', modID: '123', fileID: '456', version: '2.0' });
    });
  });

  it('is a no-op when invoked with no node (no row to act on)', () => {
    registerDownloadsSingleRowCommands('/instance', fakeInstance(), recordingReporter(), installDeps());
    expect(() => invoke('modbench.downloads.install', undefined)).not.toThrow();
    expect(installFromArchive).not.toHaveBeenCalled();
  });

  it('ignores the rest of a multi-selection — only the clicked row is installed', async () => {
    const root = await makeInstanceRoot();
    const archive = await writeArchive(root, 'foo.7z');
    await writeArchive(root, 'other.7z');
    await writeMeta(root, 'foo.7z');
    installFromArchive.mockResolvedValueOnce({ applied: true, wrote: true, isFomod: false });

    registerDownloadsSingleRowCommands(root, fakeInstance(), recordingReporter(), installDeps());
    invoke('modbench.downloads.install', node(root, 'foo.7z'), [node(root, 'foo.7z'), node(root, 'other.7z')]);

    await vi.waitFor(() => {
      expect(installFromArchive).toHaveBeenCalledWith(
        root, { kind: 'new', name: 'foo' }, archive,
        { gameName: 'Fallout4', modID: undefined, fileID: undefined, version: undefined });
    });
    expect(installFromArchive).toHaveBeenCalledTimes(1);
  });

  // Rival: the view marking the sidecar itself. Install owns that write, so a `.meta` the view
  // touched would be a second writer of MO2's own file.
  it('install: writes no sidecar of its own — the mark is install\'s', async () => {
    const root = await makeInstanceRoot();
    const archive = await writeArchive(root, 'foo.7z');
    const meta = await writeMeta(root, 'foo.7z');
    const before = await readFile(meta, 'utf8');
    installFromArchive.mockResolvedValueOnce({ applied: true, wrote: true, isFomod: false });

    registerDownloadsSingleRowCommands(root, fakeInstance(), recordingReporter(), installDeps());
    invoke('modbench.downloads.install', node(root, 'foo.7z'));

    await vi.waitFor(() => {
      expect(installFromArchive).toHaveBeenCalledWith(
        root, { kind: 'new', name: 'foo' }, archive,
        { gameName: 'Fallout4', modID: undefined, fileID: undefined, version: undefined });
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

    registerDownloadsSingleRowCommands(root, fakeInstance(), report, installDeps());
    invoke('modbench.downloads.install', node(root, 'foo.7z'));

    await vi.waitFor(() => expect(report.dialogFailures).toHaveLength(1));
    const reportEntry = present(report.dialogFailures[0], 'the one recorded Output line');
    expect(reportEntry.severity).toBe('warning');
    expect(reportEntry.message).toBe('"foo.7z" was installed, but its Downloads status could not be updated.');
    expect(reportEntry.detail).toContain('EISDIR');
    expect(report.reports).toEqual([]); // no failure notification — the install already landed
    expect(installFromArchive).toHaveBeenCalledWith(
      root, { kind: 'new', name: 'foo' }, archive,
      { gameName: 'Fallout4', modID: undefined, fileID: undefined, version: undefined });
  });

  it('install: cancelling the name prompt installs nothing', async () => {
    const root = await makeInstanceRoot();
    await writeArchive(root, 'foo.7z');
    const meta = await writeMeta(root, 'foo.7z');
    let asked = false;
    const nameNewMod = () => { asked = true; return Promise.resolve(undefined); };

    registerDownloadsSingleRowCommands(root, fakeInstance(), recordingReporter(), installDeps({ nameNewMod }));
    invoke('modbench.downloads.install', node(root, 'foo.7z'));

    // The prompt's answer is what install waits on, so the refusal is ordered before any write.
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

    registerDownloadsSingleRowCommands(root, fakeInstance(), report, installDeps());
    invoke('modbench.downloads.install', node(root, 'foo.7z'));

    await vi.waitFor(() => expect(report.reports).toHaveLength(1));
    expect(report.reports).toEqual([{ severity: 'error', message: 'Failed to install "foo.7z".', detail: 'boom' }]);
    expect(await readFile(meta, 'utf8')).not.toContain('installed=true');
  });

  it('install: a FOMOD archive installs and the notice names the mod install made', async () => {
    const root = await makeInstanceRoot();
    await writeArchive(root, 'foo.7z');
    installFromArchive.mockResolvedValueOnce({ applied: true, wrote: true, isFomod: true });
    const warnIfFomod = vi.fn();

    registerDownloadsSingleRowCommands(root, fakeInstance(), recordingReporter(), installDeps({ warnIfFomod }));
    invoke('modbench.downloads.install', node(root, 'foo.7z'));

    await vi.waitFor(() => expect(warnIfFomod).toHaveBeenCalledWith('foo', true));
  });

  it('open: OS-opens the archive and asks nothing, whether or not there is a .meta', async () => {
    const root = await makeInstanceRoot();
    const archive = await writeArchive(root, 'foo.7z');
    await writeMeta(root, 'foo.7z');

    registerDownloadsSingleRowCommands(root, fakeInstance(), recordingReporter(), installDeps());
    invoke('modbench.downloadedFile.open', node(root, 'foo.7z', { hasMeta: true }));

    await vi.waitFor(() => expect(openExternal).toHaveBeenCalled());
    expect(calledFsPath(openExternal)).toBe(archive);
    expect(showQuickPick).not.toHaveBeenCalled();
    expect(showTextDocument).not.toHaveBeenCalled();
  });

  it('open: is a no-op when invoked with no node', async () => {
    registerDownloadsSingleRowCommands('/instance', fakeInstance(), recordingReporter(), installDeps());
    await invoke('modbench.downloadedFile.open', undefined);
    expect(openExternal).not.toHaveBeenCalled();
  });

  it('open: on failure, logs and surfaces an error notification naming the action and row', async () => {
    const root = await makeInstanceRoot();
    await writeArchive(root, 'foo.7z');
    openExternal.mockRejectedValueOnce(new Error('no handler for this file type'));
    const report = recordingReporter();

    registerDownloadsSingleRowCommands(root, fakeInstance(), report, installDeps());
    invoke('modbench.downloadedFile.open', node(root, 'foo.7z'));

    await vi.waitFor(() => expect(report.reports).toHaveLength(1));
    expect(report.reports).toEqual([
      { severity: 'error', message: 'Open File for "foo.7z" failed.', detail: 'no handler for this file type' },
    ]);
  });

  it('open .meta: opens the sidecar in the editor and asks nothing', async () => {
    const root = await makeInstanceRoot();
    const meta = await writeMeta(root, 'foo.7z');

    registerDownloadsSingleRowCommands(root, fakeInstance(), recordingReporter(), installDeps());
    invoke('modbench.downloadedFile.openMeta', node(root, 'foo.7z', { hasMeta: true }));

    await vi.waitFor(() => expect(showTextDocument).toHaveBeenCalled());
    expect(calledFsPath(showTextDocument)).toBe(meta);
    expect(openExternal).not.toHaveBeenCalled();
    expect(showQuickPick).not.toHaveBeenCalled();
  });

  it('open .meta: is a no-op when invoked with no node', async () => {
    registerDownloadsSingleRowCommands('/instance', fakeInstance(), recordingReporter(), installDeps());
    await invoke('modbench.downloadedFile.openMeta', undefined);
    expect(showTextDocument).not.toHaveBeenCalled();
  });

  it('open .meta: on failure, logs and surfaces an error notification naming the action and row', async () => {
    const root = await makeInstanceRoot();
    await writeMeta(root, 'foo.7z');
    showTextDocument.mockRejectedValueOnce(new Error('file changed on disk'));
    const report = recordingReporter();

    registerDownloadsSingleRowCommands(root, fakeInstance(), report, installDeps());
    invoke('modbench.downloadedFile.openMeta', node(root, 'foo.7z', { hasMeta: true }));

    await vi.waitFor(() => expect(report.reports).toHaveLength(1));
    expect(report.reports).toEqual([
      { severity: 'error', message: 'Open Meta File for "foo.7z" failed.', detail: 'file changed on disk' },
    ]);
  });
});

// ── the upgrade pick (install on a download whose mod id is already installed) ──────────────

// The row's own Nexus ids, as the Instance read them off the sidecar.
const NEXUS_IDS = { modID: '111', fileID: '999' };

describe('registerDownloadsSingleRowCommands: the upgrade pick', () => {
  beforeEach(() => vi.clearAllMocks());

  it('shows one row per candidate — file-id match named and first — plus a trailing new-mod row', async () => {
    const root = await makeInstanceRoot();
    await writeArchive(root, 'foo.7z');
    const instance = fakeInstance([
      mod({ name: 'No Match', nexusId: '111', version: '1.0' }),
      mod({ name: 'The Match', nexusId: '111', version: '2.0', installedFiles: [{ modid: '111', fileid: '999' }] }),
    ]);
    showQuickPick.mockResolvedValueOnce(undefined);

    registerDownloadsSingleRowCommands(root, instance, recordingReporter(), installDeps());
    invoke('modbench.downloads.install', node(root, 'foo.7z', NEXUS_IDS));

    await vi.waitFor(() => expect(showQuickPick).toHaveBeenCalled());
    const items = calledWith<{ label: string; description?: string; choice: unknown }[]>(showQuickPick);
    expect(items).toEqual([
      { label: 'The Match (v2.0)', description: 'File ID match', choice: { kind: 'upgrade', name: 'The Match' } },
      { label: 'No Match (v1.0)', description: undefined, choice: { kind: 'upgrade', name: 'No Match' } },
      { label: 'Install as a new mod…', choice: { kind: 'new' } },
    ]);
  });

  // No fileId match anywhere in the pool, so the mod meta.ini names as this exact download's own
  // installationFile wins the "Installed from this file" tier and the pre-selected first row.
  it('labels an installationFile match "Installed from this file" and lists it first, with no fileId match present', async () => {
    const root = await makeInstanceRoot();
    await writeArchive(root, 'foo.7z');
    const instance = fakeInstance([
      mod({ name: 'Harder VATS', nexusId: '111', version: '1.0', archiveFilename: 'foo.7z' }),
    ]);
    showQuickPick.mockResolvedValueOnce(undefined);

    registerDownloadsSingleRowCommands(root, instance, recordingReporter(), installDeps());
    invoke('modbench.downloads.install', node(root, 'foo.7z', NEXUS_IDS));

    await vi.waitFor(() => expect(showQuickPick).toHaveBeenCalled());
    const items = calledWith<{ label: string; description?: string; choice: unknown }[]>(showQuickPick);
    expect(items).toEqual([
      { label: 'Harder VATS (v1.0)', description: 'Installed from this file', choice: { kind: 'upgrade', name: 'Harder VATS' } },
      { label: 'Install as a new mod…', choice: { kind: 'new' } },
    ]);
  });

  // Tier 2 hidden: an installationFile match beside a fileId match elsewhere in the pool loses
  // its "Installed from this file" label — the fileId match alone is first and pre-selected.
  it('hides the installationFile label when a fileId match exists elsewhere in the pool', async () => {
    const root = await makeInstanceRoot();
    await writeArchive(root, 'foo.7z');
    const instance = fakeInstance([
      mod({ name: 'By Name', nexusId: '111', version: '1.0', archiveFilename: 'foo.7z' }),
      mod({ name: 'By File Id', nexusId: '111', version: '2.0', installedFiles: [{ modid: '111', fileid: '999' }] }),
    ]);
    showQuickPick.mockResolvedValueOnce(undefined);

    registerDownloadsSingleRowCommands(root, instance, recordingReporter(), installDeps());
    invoke('modbench.downloads.install', node(root, 'foo.7z', NEXUS_IDS));

    await vi.waitFor(() => expect(showQuickPick).toHaveBeenCalled());
    const items = calledWith<{ label: string; description?: string; choice: unknown }[]>(showQuickPick);
    expect(items).toEqual([
      { label: 'By File Id (v2.0)', description: 'File ID match', choice: { kind: 'upgrade', name: 'By File Id' } },
      { label: 'By Name (v1.0)', description: undefined, choice: { kind: 'upgrade', name: 'By Name' } },
      { label: 'Install as a new mod…', choice: { kind: 'new' } },
    ]);
  });

  it('choosing a candidate calls install with the upgrade shape naming that mod', async () => {
    const root = await makeInstanceRoot();
    const archive = await writeArchive(root, 'foo.7z');
    const instance = fakeInstance([mod({ name: 'Harder VATS', nexusId: '111', version: '1.0' })]);
    showQuickPick.mockResolvedValueOnce({ label: 'Harder VATS (v1.0)', choice: { kind: 'upgrade', name: 'Harder VATS' } });
    installFromArchive.mockResolvedValueOnce({ applied: true, wrote: true, isFomod: false });
    const nameNewMod = vi.fn();

    registerDownloadsSingleRowCommands(root, instance, recordingReporter(), installDeps({ nameNewMod }));
    invoke('modbench.downloads.install', node(root, 'foo.7z', NEXUS_IDS));

    await vi.waitFor(() => {
      expect(installFromArchive).toHaveBeenCalledWith(
        root, { kind: 'upgrade', name: 'Harder VATS' }, archive,
        { gameName: 'Fallout4', modID: '111', fileID: '999', version: undefined },
      );
    });
    expect(nameNewMod).not.toHaveBeenCalled();
  });

  it('choosing "Install as a new mod…" calls install with the new-mod shape', async () => {
    const root = await makeInstanceRoot();
    const archive = await writeArchive(root, 'foo.7z');
    const instance = fakeInstance([mod({ name: 'Harder VATS', nexusId: '111', version: '1.0' })]);
    showQuickPick.mockResolvedValueOnce({ label: 'Install as a new mod…', choice: { kind: 'new' } });
    installFromArchive.mockResolvedValueOnce({ applied: true, wrote: true, isFomod: false });

    registerDownloadsSingleRowCommands(root, instance, recordingReporter(), installDeps());
    invoke('modbench.downloads.install', node(root, 'foo.7z', NEXUS_IDS));

    await vi.waitFor(() => {
      expect(installFromArchive).toHaveBeenCalledWith(
        root, { kind: 'new', name: 'foo' }, archive,
        { gameName: 'Fallout4', modID: '111', fileID: '999', version: undefined },
      );
    });
  });

  it('Esc installs nothing', async () => {
    const root = await makeInstanceRoot();
    await writeArchive(root, 'foo.7z');
    const instance = fakeInstance([mod({ name: 'Harder VATS', nexusId: '111', version: '1.0' })]);
    showQuickPick.mockResolvedValueOnce(undefined);

    registerDownloadsSingleRowCommands(root, instance, recordingReporter(), installDeps());
    invoke('modbench.downloads.install', node(root, 'foo.7z', NEXUS_IDS));

    await vi.waitFor(() => expect(showQuickPick).toHaveBeenCalled());
    // A macrotask boundary, not a microtask one: the resolved pick still has to unwind through
    // pickUpgradeChoice's and installArchive's own awaits before the early return lands.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(installFromArchive).not.toHaveBeenCalled();
  });

  it('a download with no mod id never shows the pick, even with installed mods present', async () => {
    const root = await makeInstanceRoot();
    const archive = await writeArchive(root, 'foo.7z');
    const instance = fakeInstance([mod({ name: 'Harder VATS', nexusId: '111', version: '1.0' })]);
    installFromArchive.mockResolvedValueOnce({ applied: true, wrote: true, isFomod: false });

    registerDownloadsSingleRowCommands(root, instance, recordingReporter(), installDeps());
    invoke('modbench.downloads.install', node(root, 'foo.7z'));

    await vi.waitFor(() => {
      expect(installFromArchive).toHaveBeenCalledWith(
        root, { kind: 'new', name: 'foo' }, archive,
        { gameName: 'Fallout4', modID: undefined, fileID: undefined, version: undefined },
      );
    });
    expect(showQuickPick).not.toHaveBeenCalled();
  });

  it('a download with a mod id no installed mod carries never shows the pick', async () => {
    const root = await makeInstanceRoot();
    const archive = await writeArchive(root, 'foo.7z');
    const instance = fakeInstance([mod({ name: 'Harder VATS', nexusId: '111', version: '1.0' })]);
    installFromArchive.mockResolvedValueOnce({ applied: true, wrote: true, isFomod: false });

    registerDownloadsSingleRowCommands(root, instance, recordingReporter(), installDeps());
    invoke('modbench.downloads.install', node(root, 'foo.7z', { modID: '222' }));

    await vi.waitFor(() => {
      expect(installFromArchive).toHaveBeenCalledWith(
        root, { kind: 'new', name: 'foo' }, archive,
        { gameName: 'Fallout4', modID: '222', fileID: undefined, version: undefined },
      );
    });
    expect(showQuickPick).not.toHaveBeenCalled();
  });
});

describe('registerDownloadsMultiRowCommands', () => {
  beforeEach(() => vi.clearAllMocks());

  it('registers delete, exclude and include', () => {
    registerDownloadsMultiRowCommands('/instance', recordingReporter(), scriptedDialog(), trash);
    const ids = registerCommand.mock.calls.map((c) => c[0]);
    expect(ids).toEqual(expect.arrayContaining([
      'modbench.downloadedFile.delete',
      'modbench.downloadedFile.exclude',
      'modbench.downloadedFile.include',
    ]));
  });

  it('hide applies to the whole selection, not just the clicked row', async () => {
    const root = await makeInstanceRoot();
    const metaA = await writeMeta(root, 'a.7z');
    const metaB = await writeMeta(root, 'b.7z');

    registerDownloadsMultiRowCommands(root, recordingReporter(), scriptedDialog(), trash);
    invoke('modbench.downloadedFile.exclude', node(root, 'a.7z'), [node(root, 'a.7z'), node(root, 'b.7z')]);

    await vi.waitFor(async () => {
      expect(await readFile(metaA, 'utf8')).toContain('removed=true');
      expect(await readFile(metaB, 'utf8')).toContain('removed=true');
    });
  });

  it('is idempotent over a mixed hidden/visible selection — hide leaves both hidden, no error', async () => {
    const root = await makeInstanceRoot();
    const already = await writeMeta(root, 'already-hidden.7z', '[General]\r\nremoved=true\r\n');
    const visible = await writeMeta(root, 'visible.7z');

    registerDownloadsMultiRowCommands(root, recordingReporter(), scriptedDialog(), trash);
    invoke('modbench.downloadedFile.exclude', node(root, 'visible.7z'), [node(root, 'already-hidden.7z'), node(root, 'visible.7z')]);

    await vi.waitFor(async () => {
      expect(await readFile(already, 'utf8')).toContain('removed=true');
      expect(await readFile(visible, 'utf8')).toContain('removed=true');
    });
    expect(showErrorMessage).not.toHaveBeenCalled();
  });

  it('is idempotent over a mixed selection for unhide too — both end up unhidden, no error', async () => {
    const root = await makeInstanceRoot();
    const hidden = await writeMeta(root, 'hidden.7z', '[General]\r\nremoved=true\r\n');
    const already = await writeMeta(root, 'already-visible.7z');

    registerDownloadsMultiRowCommands(root, recordingReporter(), scriptedDialog(), trash);
    invoke('modbench.downloadedFile.include', node(root, 'hidden.7z'), [node(root, 'hidden.7z'), node(root, 'already-visible.7z')]);

    await vi.waitFor(async () => {
      expect(await readFile(hidden, 'utf8')).toContain('removed=false');
      expect(await readFile(already, 'utf8')).toContain('removed=false');
    });
    expect(showErrorMessage).not.toHaveBeenCalled();
  });

  it('exclude: a refused write is reported under the gesture\'s own verb', async () => {
    const root = await makeInstanceRoot();
    const report = recordingReporter();

    registerDownloadsMultiRowCommands(join(root, 'gone'), report, scriptedDialog(), trash);
    invoke('modbench.downloadedFile.exclude', node(root, 'foo.7z'));

    await vi.waitFor(() => expect(report.reports).toHaveLength(1));
    expect(present(report.reports[0], 'the one report').message).toBe('Exclude for "foo.7z" failed.');
  });

  it('exclude: sets removed=true on the .meta sidecar (clicked row alone, no selection array)', async () => {
    const root = await makeInstanceRoot();
    const meta = await writeMeta(root, 'foo.7z');

    registerDownloadsMultiRowCommands(root, recordingReporter(), scriptedDialog(), trash);
    invoke('modbench.downloadedFile.exclude', node(root, 'foo.7z'));

    await vi.waitFor(async () => {
      expect(await readFile(meta, 'utf8')).toContain('removed=true');
    });
  });

  it('include: clears removed to false on the .meta sidecar (clicked row alone, no selection array)', async () => {
    const root = await makeInstanceRoot();
    const meta = await writeMeta(root, 'foo.7z', '[General]\r\nremoved=true\r\n');

    registerDownloadsMultiRowCommands(root, recordingReporter(), scriptedDialog(), trash);
    invoke('modbench.downloadedFile.include', node(root, 'foo.7z'));

    await vi.waitFor(async () => {
      expect(await readFile(meta, 'utf8')).toContain('removed=false');
    });
  });

  it('delete falls back to the clicked row alone when no selection array is passed', async () => {
    const root = await makeInstanceRoot();
    await writeArchive(root, 'foo.7z');
    const ask = scriptedDialog('Delete');

    registerDownloadsMultiRowCommands(root, recordingReporter(), ask, trash);
    invoke('modbench.downloadedFile.delete', node(root, 'foo.7z'));

    await vi.waitFor(() => expect(trash).toHaveBeenCalledTimes(1));
    assertAskedOnce(ask, { messageContains: '"foo.7z"', buttons: ['Delete'] });
  });

  // The negative case on a destructive operation — the single most valuable assertion in this
  // group: declining the confirmation must trash nothing.
  it('delete: on confirm-cancel, does not trash anything', async () => {
    const root = await makeInstanceRoot();
    await writeArchive(root, 'foo.7z');
    const ask = scriptedDialog(undefined); // user dismissed, not "Delete"

    registerDownloadsMultiRowCommands(root, recordingReporter(), ask, trash);
    await invoke('modbench.downloadedFile.delete', node(root, 'foo.7z'));

    expect(ask.asked).toHaveLength(1);
    expect(trash).not.toHaveBeenCalled();
  });

  it('delete: on confirm-accept, trashes the archive (and its .meta, if present)', async () => {
    const root = await makeInstanceRoot();
    const archive = await writeArchive(root, 'foo.7z');
    const meta = await writeMeta(root, 'foo.7z');

    registerDownloadsMultiRowCommands(root, recordingReporter(), scriptedDialog('Delete'), trash);
    invoke('modbench.downloadedFile.delete', node(root, 'foo.7z'));

    await vi.waitFor(() => expect(trash).toHaveBeenCalledTimes(2));
    expect(trashedPaths()).toEqual(expect.arrayContaining([archive, meta]));
  });
});

// ── modbench.downloadedFile.delete over a selection ─────────────────────────
describe('modbench.downloadedFile.delete — a multi-name selection', () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => trash.mockReset());

  it('confirms once for the whole batch, then trashes every archive (+ its .meta, if present)', async () => {
    const root = await makeInstanceRoot();
    const a = await writeArchive(root, 'a.7z');
    const b = await writeArchive(root, 'b.7z');
    await writeMeta(root, 'a.7z');
    const ask = scriptedDialog('Delete');

    registerDownloadsMultiRowCommands(root, recordingReporter(), ask, trash);
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

    registerDownloadsMultiRowCommands(root, reporter, ask, trash);
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

    registerDownloadsMultiRowCommands(root, reporter, ask, trash);
    const outcome = await invoke(
      'modbench.downloadedFile.delete',
      node(root, 'b.7z'),
      [node(root, 'a.7z'), node(root, 'b.7z'), node(root, 'locked.7z')],
    );

    const refused = { item: 'locked.7z', reason: 'EPERM: operation not permitted' };
    expect(outcome).toEqual({ landed: ['a.7z', 'b.7z'], refused: [refused] });
    expect(vi.mocked(deleteDownloads).mock.calls.map((call) => call[1])).toEqual([['a.7z', 'b.7z', 'locked.7z']]);
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

    registerDownloadsMultiRowCommands(root, recordingReporter(), ask, trash);
    invoke('modbench.downloadedFile.delete', node(root, 'foo.7z'), [node(root, 'foo.7z')]);

    await vi.waitFor(() => expect(trash).toHaveBeenCalledTimes(1));
    assertAskedOnce(ask, { messageContains: '"foo.7z"', buttons: ['Delete'] });
  });
});

// ── registerDownloadsSortCommand ─────────────────────────────────────────────

describe('registerDownloadsSortCommand', () => {
  beforeEach(() => vi.clearAllMocks());

  it('registers modbench.downloadedFile.sort', () => {
    registerDownloadsSortCommand(fakeDownloadsProvider());
    expect(registerCommand.mock.calls.map((c) => c[0])).toContain('modbench.downloadedFile.sort');
  });

  it('applies the picked option to DownloadsProvider.setSort', async () => {
    const provider = fakeDownloadsProvider();
    showQuickPick.mockResolvedValueOnce({ label: 'Size (Largest First)', column: 'size', descending: true });

    registerDownloadsSortCommand(provider);
    invoke('modbench.downloadedFile.sort');

    await vi.waitFor(() => {
      expect(provider.setSort).toHaveBeenCalledWith('size', true);
    });
  });

  it('does nothing when the pick is cancelled', async () => {
    const provider = fakeDownloadsProvider();
    showQuickPick.mockResolvedValueOnce(undefined);

    registerDownloadsSortCommand(provider);
    invoke('modbench.downloadedFile.sort');

    await vi.waitFor(() => {
      expect(showQuickPick).toHaveBeenCalled();
    });
    expect(provider.setSort).not.toHaveBeenCalled();
  });
});

// ── registerDownloadsHiddenToggleCommands ────────────────────────────────────

describe('registerDownloadsHiddenToggleCommands', () => {
  beforeEach(() => vi.clearAllMocks());

  it('registers modbench.downloadedFile.showExcluded and .hideExcluded', () => {
    registerDownloadsHiddenToggleCommands(fakeDownloadsProvider());
    expect(registerCommand.mock.calls.map((c) => c[0])).toEqual(expect.arrayContaining([
      'modbench.downloadedFile.showExcluded',
      'modbench.downloadedFile.hideExcluded',
    ]));
  });

  it('showExcluded turns excluded rows on and sets the context key true', () => {
    const provider = fakeDownloadsProvider();
    registerDownloadsHiddenToggleCommands(provider);

    invoke('modbench.downloadedFile.showExcluded');

    expect(provider.setShowHidden).toHaveBeenCalledWith(true);
    expect(executeCommand).toHaveBeenCalledWith('setContext', 'modbench.downloadedFile.excludedShown', true);
  });

  it('hideExcluded turns excluded rows off and sets the context key false', () => {
    const provider = fakeDownloadsProvider();
    registerDownloadsHiddenToggleCommands(provider);

    invoke('modbench.downloadedFile.hideExcluded');

    expect(provider.setShowHidden).toHaveBeenCalledWith(false);
    expect(executeCommand).toHaveBeenCalledWith('setContext', 'modbench.downloadedFile.excludedShown', false);
  });
});
