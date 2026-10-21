import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const {
  executeCommand, registerCommand, showErrorMessage, showTextDocument, showQuickPick, createQuickPick, openExternal, showInputBox,
} = vi.hoisted(() => ({
  executeCommand: vi.fn(),
  registerCommand: vi.fn((_id: string, handler: (...args: unknown[]) => unknown) => ({ dispose: vi.fn(), handler })),
  showErrorMessage: vi.fn(),
  showTextDocument: vi.fn(),
  showQuickPick: vi.fn(),
  createQuickPick: vi.fn(),
  openExternal: vi.fn(),
  showInputBox: vi.fn<(options: { value: string }) => Promise<string | undefined>>((options) => Promise.resolve(options.value)),
}));

import { TreeItem, TreeItemCollapsibleState, EventEmitter, ThemeIcon, ThemeColor, MarkdownString, type FakeUri } from '../../test/vscodeMock';
import { present } from '../../ports/present';
import { fakeQuickPick } from '../../drivingLib/test/quickPickDouble';
import { progressSteps, recordedWithProgress } from '../../test/recordedProgress';

vi.mock('vscode', () => ({
  commands: { executeCommand, registerCommand },
  window: { showErrorMessage, showTextDocument, showQuickPick, showInputBox, createQuickPick, withProgress: recordedWithProgress },
  env: { openExternal },
  Uri: {
    file: (p: string) => ({ fsPath: p, toString: () => `file://${p}` }),
    parse: (s: string) => ({ toString: () => s }),
  },
  ViewColumn: { One: 1 },
  TreeItem, TreeItemCollapsibleState, EventEmitter, ThemeIcon, ThemeColor, MarkdownString,
}));

import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  registerDownloadsExcludedToggleCommands,
  registerDownloadsMultiRowCommands,
  registerDownloadsSingleRowCommands,
  registerDownloadsSortCommand,
} from '../DownloadsPanel';
import { DownloadedFileNode, DownloadsProvider } from '../DownloadsProvider';
import { downloadedFileNodeFixture } from '../../test/mo2/downloadedFileNodeFixture';
import { FakeInstance } from '../../test/mo2/fakeInstance';
import { downloadedFileCommands } from '../../downloadedFileCommands/downloads';
import { AgentCall } from '../../drivingLib/agentGesture';
import { Refusal } from '../../drivingLib/refusal';
import type { MoveToTrash } from '../../ports/trash';
import type { LocatedDownloadedFileRow, DownloadedFileRow, Instance, InstanceValue } from '../../instanceLoader/instance';
import { recordingReporter, scriptedDialog, assertAskedOnce, assertSelectionOutcome } from '../../test/surfacingDoubles';
import { downloadedFileRowFixture } from '../../test/mo2/downloadedFileRowFixture';
import { downloadedFilesOf, fakeInstanceAdapter, readingFixture, type InstanceAnswers, type FakeInstanceAdapter } from '../../test/fakeInstanceAdapter';
import type { InstanceAdapter } from '../../instanceAdapter/instanceAdapter';
import { instanceValueFixture } from '../../test/mo2/instanceValueFixture';

const downloadsFake = (answers: InstanceAnswers = {}) =>
  fakeInstanceAdapter(readingFixture({ downloadedFiles: downloadedFilesOf('a.7z', 'b.7z', 'foo.7z', 'locked.7z') }), answers);

const node = (root: string, name: string, row: Partial<DownloadedFileRow> = {}): DownloadedFileNode =>
  downloadedFileNodeFixture(downloadedFileRowFixture(name, row, root));

const ROOT = '/instance';

const NO_INSTALLED_MODS_SO_THE_UPGRADE_PICK_NEVER_SHOWS: InstanceValue['mods'] = [];

const fakeInstance = (
  mods: InstanceValue['mods'] = NO_INSTALLED_MODS_SO_THE_UPGRADE_PICK_NEVER_SHOWS, downloads: readonly LocatedDownloadedFileRow[] = [], gameName = 'Fallout 4',
): Pick<Instance, 'value' | 'refresh'> => ({
  value: instanceValueFixture({ mods, downloadedFiles: { kind: 'listed', rows: downloads }, gameName }),
  refresh: () => { progressSteps.push('Instance loader: read every file again'); return Promise.resolve(); },
});

const fakeDownloadsProvider = (
  currentSort: ReturnType<DownloadsProvider['currentSort']> = { column: 'mtimeMs', descending: true },
): Pick<DownloadsProvider, 'setSort' | 'setShowExcluded' | 'currentSort'> => ({
  setSort: vi.fn(), setShowExcluded: vi.fn(), currentSort: vi.fn(() => currentSort),
});

let instanceRootsRemovedInAfterEachSoAFailedAssertionDoesNotLeakThem: string[] = [];

const instanceThatReads = fakeInstance();

const commandsStillRunningWhenTheirTestEnded: Promise<unknown>[] = [];

let downloadsLogLines: string[] = [];
const downloadsLog = (line: string): void => { downloadsLogLines.push(line); };

afterEach(async () => {
  await Promise.allSettled(commandsStillRunningWhenTheirTestEnded.splice(0));
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

async function writeDownloadedFile(root: string, name: string, data = 'data'): Promise<string> {
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

function invoke(commandId: string, ...args: unknown[]): unknown {
  const call = registerCommand.mock.calls.find((c) => c[0] === commandId);
  if (!call) throw new Error(`command not registered: ${commandId}`);
  const running = call[1](...args);
  commandsStillRunningWhenTheirTestEnded.push(Promise.resolve(running));
  return running;
}

describe('registerDownloadsSingleRowCommands', () => {
  beforeEach(() => vi.clearAllMocks());

  it('open: OS-opens the downloaded file and asks nothing, whether or not there is a .meta', async () => {
    const root = await makeInstanceRoot();
    const downloadedFile = await writeDownloadedFile(root, 'foo.7z');
    await writeMeta(root, 'foo.7z');

    registerDownloadsSingleRowCommands(recordingReporter(), () => []);
    invoke('modbench.downloadedFile.open', node(root, 'foo.7z', { hasMeta: true }));

    await vi.waitFor(() => expect(openExternal).toHaveBeenCalled());
    expect(calledFsPath(openExternal)).toBe(downloadedFile);
    expect(showQuickPick).not.toHaveBeenCalled();
    expect(showTextDocument).not.toHaveBeenCalled();
  });

  it('open: on failure, logs and surfaces an error notification naming the action and row', async () => {
    const root = await makeInstanceRoot();
    await writeDownloadedFile(root, 'foo.7z');
    openExternal.mockRejectedValueOnce(new Error('no handler for this file type'));
    const report = recordingReporter();

    registerDownloadsSingleRowCommands(report, () => []);
    invoke('modbench.downloadedFile.open', node(root, 'foo.7z'));

    await vi.waitFor(() => expect(report.reports).toHaveLength(1));
    expect(report.reports).toEqual([
      { severity: 'error', message: 'Open File for "foo.7z" failed.', detail: 'no handler for this file type' },
    ]);
  });

  it('open metadata: opens the metadata file and asks nothing', async () => {
    const root = await makeInstanceRoot();
    const meta = await writeMeta(root, 'foo.7z');

    registerDownloadsSingleRowCommands(recordingReporter(), () => []);
    invoke('modbench.downloadedFile.openMeta', node(root, 'foo.7z', { hasMeta: true }));

    await vi.waitFor(() => expect(showTextDocument).toHaveBeenCalled());
    expect(calledFsPath(showTextDocument)).toBe(meta);
    expect(openExternal).not.toHaveBeenCalled();
    expect(showQuickPick).not.toHaveBeenCalled();
  });

  it('open metadata: on failure, logs and surfaces an error notification naming the action and row', async () => {
    const root = await makeInstanceRoot();
    await writeMeta(root, 'foo.7z');
    showTextDocument.mockRejectedValueOnce(new Error('file changed on disk'));
    const report = recordingReporter();

    registerDownloadsSingleRowCommands(report, () => []);
    invoke('modbench.downloadedFile.openMeta', node(root, 'foo.7z', { hasMeta: true }));

    await vi.waitFor(() => expect(report.reports).toHaveLength(1));
    expect(report.reports).toEqual([
      { severity: 'error', message: 'Open Metadata for "foo.7z" failed.', detail: 'file changed on disk' },
    ]);
  });
});


describe('a Downloads gesture that writes ends on the Instance loader\'s read, with the view\'s progress bar open throughout', () => {
  beforeEach(() => { vi.clearAllMocks(); progressSteps.length = 0; });

  const opens = 'progress opens on modbench.downloads';
  const reads = 'Instance loader: read every file again';

  const instanceReadingTheWrites = (fake: FakeInstanceAdapter): Pick<Instance, 'value' | 'refresh'> => ({
    ...fakeInstance(),
    refresh: () => {
      progressSteps.push(`read finds ${fake.calls.map((call) => (call.verb === 'markDownloadedFile' ? `${call.verb} ${call.mark}` : call.verb)).join()}`);
      return Promise.resolve();
    },
  });

  it('exclude writes the mark, then the read, then the bar closes', async () => {
    const fake = downloadsFake();

    registerDownloadsMultiRowCommands(downloadedFileCommands(fake.adapter), instanceReadingTheWrites(fake), recordingReporter(), scriptedDialog(), trash, downloadsLog, () => []);
    await invoke('modbench.downloadedFile.exclude', node(ROOT, 'foo.7z'));

    expect(progressSteps).toEqual([opens, 'read finds markDownloadedFile Excluded', 'progress closes']);
  });

  it('a selection of several runs one bar and one read', async () => {
    registerDownloadsMultiRowCommands(downloadedFileCommands(downloadsFake().adapter), instanceThatReads, recordingReporter(), scriptedDialog(), trash, downloadsLog, () => []);
    await invoke('modbench.downloadedFile.exclude', node(ROOT, 'a.7z'), [node(ROOT, 'a.7z'), node(ROOT, 'b.7z')]);

    expect(progressSteps).toEqual([opens, reads, 'progress closes']);
  });

  it.each([
    ['exclude', 'modbench.downloadedFile.exclude', { excluded: true }, 'Excluded'],
    ['include', 'modbench.downloadedFile.include', { excluded: false }, 'Included'],
  ])('%s still hands the adapter the mark for a row the view shows already in that state, since the disk decides', async (_name, command, row, mark) => {
    const fake = downloadsFake();

    registerDownloadsMultiRowCommands(downloadedFileCommands(fake.adapter), instanceThatReads, recordingReporter(), scriptedDialog(), trash, downloadsLog, () => []);
    await invoke(command, node(ROOT, 'foo.7z', row));

    expect(progressSteps).toEqual([opens, reads, 'progress closes']);
    expect(fake.calls).toEqual([{ verb: 'markDownloadedFile', name: 'foo.7z', mark }]);
  });

  it('delete trashes, then the read, then the bar closes', async () => {
    const { adapter } = downloadsFake();
    const trashing: InstanceAdapter = {
      ...adapter,
      trashDownloadedFile: (name, trashFile) => { progressSteps.push('trash'); return adapter.trashDownloadedFile(name, trashFile); },
    };

    registerDownloadsMultiRowCommands(downloadedFileCommands(trashing), instanceThatReads, recordingReporter(), scriptedDialog('Delete'), trash, downloadsLog, () => []);
    await invoke('modbench.downloadedFile.delete', node(ROOT, 'foo.7z'));

    expect(progressSteps).toEqual([opens, 'trash', reads, 'progress closes']);
  });

  it('a declined delete opens no bar', async () => {
    registerDownloadsMultiRowCommands(downloadedFileCommands(downloadsFake().adapter), instanceThatReads, recordingReporter(), scriptedDialog(undefined), trash, downloadsLog, () => []);
    await invoke('modbench.downloadedFile.delete', node(ROOT, 'foo.7z'));

    expect(progressSteps).toEqual([]);
  });


  it('a read that fails after the gesture leaves the rows and says so', async () => {
    const disk = new FakeInstance(instanceValueFixture({ downloadedFiles: { kind: 'listed', rows: [downloadedFileRowFixture('foo.7z', {}, ROOT)] } }));
    const provider = new DownloadsProvider({ instance: disk });
    const instance = { value: disk.value, refresh: () => { disk.fail('locked'); return Promise.resolve(); } };

    registerDownloadsMultiRowCommands(downloadedFileCommands(downloadsFake().adapter), instance, recordingReporter(), scriptedDialog(), trash, downloadsLog, () => []);
    await invoke('modbench.downloadedFile.exclude', node(ROOT, 'foo.7z'));

    expect((await provider.getChildren()).map((n) => n.kind === 'downloadedFile' && n.argument.row.name)).toEqual(['foo.7z']);
    expect(provider.viewMessage()).toBe('Showing the last good read: locked');
  });
});

describe('modbench.downloadedFile.exclude / include — a multi-name selection', () => {
  beforeEach(() => vi.clearAllMocks());

  it.each([
    ['exclude', {}, 'Excluded'],
    ['include', { excluded: true }, 'Included'],
  ])('%s: given the right-clicked row and the selection, changes the whole selection, refuses the gone file, and reports once', async (verb, row, mark) => {
    const fake = downloadsFake();
    const reporter = recordingReporter();

    registerDownloadsMultiRowCommands(downloadedFileCommands(fake.adapter), instanceThatReads, reporter, scriptedDialog(), trash, downloadsLog, () => []);
    await invoke(
      `modbench.downloadedFile.${verb}`,
      node(ROOT, 'b.7z', row),
      [node(ROOT, 'a.7z', row), node(ROOT, 'b.7z', row), node(ROOT, 'gone.7z', row)],
    );

    const recordedCall = present(reporter.selectionOutcomeCalls[0], 'the one selection-outcome call');
    assertSelectionOutcome(recordedCall.outcome, {
      landed: ['a.7z', 'b.7z'],
      refused: [{ item: 'gone.7z', reasonContains: 'gone.7z' }],
    });
    expect(recordedCall.message).toBe(`Could not ${verb} 1 of 3 downloaded files.`);
    expect(fake.calls).toEqual(['a.7z', 'b.7z', 'gone.7z'].map((name) => ({ verb: 'markDownloadedFile', name, mark })));
  });
});

describe('modbench.downloadedFile.delete — a multi-name selection', () => {
  beforeEach(() => vi.clearAllMocks());

  it('Esc deletes nothing and says nothing', async () => {
    const fake = downloadsFake();
    const reporter = recordingReporter();
    const ask = scriptedDialog(undefined);

    registerDownloadsMultiRowCommands(downloadedFileCommands(fake.adapter), instanceThatReads, reporter, ask, trash, downloadsLog, () => []);
    await invoke('modbench.downloadedFile.delete', node(ROOT, 'a.7z'), [node(ROOT, 'a.7z'), node(ROOT, 'b.7z')]);

    expect(ask.asked).toHaveLength(1);
    expect(fake.calls).toEqual([]);
    expect(reporter.reports).toEqual([]);
    expect(reporter.selectionOutcomeCalls).toEqual([]);
  });

  it('given the right-clicked row and the selection, deletes the whole selection in one call, refuses the file that cannot go, and reports once', async () => {
    const fake = downloadsFake({
      refusals: (call) => (call.verb === 'trashDownloadedFile' && call.name === 'locked.7z' ? 'EPERM: operation not permitted' : undefined),
    });
    const reporter = recordingReporter();
    const ask = scriptedDialog('Delete');

    registerDownloadsMultiRowCommands(downloadedFileCommands(fake.adapter), instanceThatReads, reporter, ask, trash, downloadsLog, () => []);
    await invoke(
      'modbench.downloadedFile.delete',
      node(ROOT, 'b.7z'),
      [node(ROOT, 'a.7z'), node(ROOT, 'b.7z'), node(ROOT, 'locked.7z')],
    );

    const outcome = {
      landed: [{ name: 'a.7z' }, { name: 'b.7z' }],
      refused: [{ item: { name: 'locked.7z' }, reason: 'EPERM: operation not permitted' }],
    };
    expect(fake.calls).toEqual(['a.7z', 'b.7z', 'locked.7z'].map((name) => ({ verb: 'trashDownloadedFile', name })));
    assertAskedOnce(ask, { messageContains: '3 items', buttons: ['Delete'] });
    expect(reporter.selectionOutcomeCalls).toEqual([
      { message: 'Could not delete 1 of 3 downloaded files.', outcome },
    ]);
    expect(reporter.reports).toEqual([{
      severity: 'error',
      message: 'Could not delete 1 of 3 downloaded files.',
      detail: '"locked.7z" (EPERM: operation not permitted)',
    }]);
  });

  it.each<[string, (a: DownloadedFileNode, b: DownloadedFileNode) => DownloadedFileNode[], string]>([
    ['one file', (a) => [a], '"a.7z"'],
    ['the count for several files', (a, b) => [a, b], '2'],
  ])('names %s, says trash, and says the installed mod is untouched', async (_name, selecting, named) => {
    const selection = selecting(node(ROOT, 'a.7z'), node(ROOT, 'b.7z'));
    const ask = scriptedDialog('Delete');

    registerDownloadsMultiRowCommands(downloadedFileCommands(downloadsFake().adapter), instanceThatReads, recordingReporter(), ask, trash, downloadsLog, () => []);
    invoke('modbench.downloadedFile.delete', selection[0], selection);

    await vi.waitFor(() => expect(ask.asked).toHaveLength(1));
    const question = present(ask.asked[0], 'the one recorded question').message;
    expect(question).toContain(named);
    expect(question).toMatch(/trash/i);
    expect(question).toMatch(/installed mod.*untouched/i);
  });

  it('metadata left behind after the file landed is one Output line naming the word the instance supplies, no notification', async () => {
    const fake = downloadsFake({ metadataLeftBehind: 'EPERM: operation not permitted' });
    const reporter = recordingReporter();

    const instance = {
      ...instanceThatReads,
      value: instanceValueFixture({ managerNames: { manager: 'Another Manager', modOrderFile: 'order.txt', downloadedFileMetadataFile: 'zzz-managers-word' } }),
    };

    registerDownloadsMultiRowCommands(downloadedFileCommands(fake.adapter), instance, reporter, scriptedDialog('Delete'), trash, downloadsLog, () => []);
    await invoke('modbench.downloadedFile.delete', node(ROOT, 'foo.7z'));

    expect(downloadsLogLines).toEqual([
      '"foo.7z" was deleted, but its zzz-managers-word could not be moved to the trash and was left behind: EPERM: operation not permitted',
    ]);
    expect(reporter.reports).toEqual([]);
  });
});

describe('the Downloads gestures called by the agent', () => {
  beforeEach(() => vi.clearAllMocks());

  const named = (...names: string[]) => new AgentCall(names.map((name) => ({ kind: 'downloadedFile' as const, name })), {});
  const listing = (...names: string[]) => fakeInstance([], names.map((name) => downloadedFileRowFixture(name, {}, ROOT)));
  const viewSelection = () => [node(ROOT, 'selected.7z')];

  it.each([
    ['exclude', 'Excluded'],
    ['include', 'Included'],
  ])('%s marks the files given, never the selection, and answers the outcome without reporting it', async (verb, mark) => {
    const fake = downloadsFake();
    const reporter = recordingReporter();

    registerDownloadsMultiRowCommands(downloadedFileCommands(fake.adapter), listing('a.7z', 'b.7z'), reporter, scriptedDialog(), trash, downloadsLog, viewSelection);
    const answered = await invoke(`modbench.downloadedFile.${verb}`, named('a.7z', 'b.7z'));

    expect(answered).toEqual({ applied: true, outcome: { landed: ['a.7z', 'b.7z'], refused: [] }, partial: [] });
    expect(fake.calls).toEqual(['a.7z', 'b.7z'].map((name) => ({ verb: 'markDownloadedFile', name, mark })));
    expect(reporter.reports).toEqual([]);
    expect(reporter.selectionOutcomeCalls).toEqual([]);
  });

  it('exclude answers the file gone from disk as refused, and the others as landed', async () => {
    const fake = downloadsFake();

    registerDownloadsMultiRowCommands(downloadedFileCommands(fake.adapter), listing('a.7z', 'gone.7z'), recordingReporter(), scriptedDialog(), trash, downloadsLog, viewSelection);
    const answered = await invoke('modbench.downloadedFile.exclude', named('a.7z', 'gone.7z'));

    expect(answered).toMatchObject({ applied: true, outcome: { landed: ['a.7z'], refused: [{ item: 'gone.7z' }] } });
  });

  it('delete trashes the files given, never the selection, asking nothing, and answers what it deleted', async () => {
    const ask = scriptedDialog('Delete');
    const reporter = recordingReporter();
    const fake = downloadsFake();

    registerDownloadsMultiRowCommands(downloadedFileCommands(fake.adapter), listing('a.7z'), reporter, ask, trash, downloadsLog, viewSelection);
    const answered = await invoke('modbench.downloadedFile.delete', named('a.7z'));

    expect(answered).toEqual({ applied: true, outcome: { landed: [{ name: 'a.7z' }], refused: [] }, partial: [] });
    expect(fake.calls).toEqual([{ verb: 'trashDownloadedFile', name: 'a.7z' }]);
    expect(ask.asked).toEqual([]);
    expect(reporter.reports).toEqual([]);
  });

  it('delete answers the metadata left behind as a log partial, writing no line itself', async () => {
    const fake = downloadsFake({ metadataLeftBehind: 'EPERM' });

    registerDownloadsMultiRowCommands(downloadedFileCommands(fake.adapter), listing('a.7z'), recordingReporter(), scriptedDialog(), trash, downloadsLog, viewSelection);
    const answered = await invoke('modbench.downloadedFile.delete', named('a.7z'));

    expect(answered).toMatchObject({
      applied: true,
      partial: [{ message: '"a.7z" was deleted, but its .meta could not be moved to the trash and was left behind', detail: 'EPERM', severity: 'log' }],
    });
    expect(downloadsLogLines).toEqual([]);
  });

  it('delete refuses, item by item, a file the adapter finds gone, whatever the Instance value lists', async () => {
    const fake = downloadsFake();

    registerDownloadsMultiRowCommands(downloadedFileCommands(fake.adapter), listing('a.7z'), recordingReporter(), scriptedDialog(), trash, downloadsLog, viewSelection);
    const answered = await invoke('modbench.downloadedFile.delete', named('a.7z', 'gone.7z'));

    expect(answered).toMatchObject({ applied: true, outcome: { landed: [{ name: 'a.7z' }], refused: [{ item: { name: 'gone.7z' } }] } });
  });

  it.each(['delete', 'exclude', 'include'])('%s refuses an Argument that is not a downloaded file, writing nothing', async (verb) => {
    const fake = downloadsFake();

    registerDownloadsMultiRowCommands(downloadedFileCommands(fake.adapter), listing('a.7z'), recordingReporter(), scriptedDialog(), trash, downloadsLog, viewSelection);
    await expect(invoke(`modbench.downloadedFile.${verb}`, new AgentCall([{ kind: 'mod', name: 'a.7z' }], {}))).rejects.toBeInstanceOf(Refusal);

    expect(fake.calls).toEqual([]);
  });
});

interface FakeSortItem { label: string; column: string; descending: boolean }

describe('registerDownloadsSortCommand', () => {
  beforeEach(() => vi.clearAllMocks());

  it('applies the picked option to DownloadsProvider.setSort', async () => {
    const provider = fakeDownloadsProvider();
    const { qp, accept } = fakeQuickPick<FakeSortItem>();
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
    const { qp, escape } = fakeQuickPick<FakeSortItem>();
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
    const { qp, escape } = fakeQuickPick<FakeSortItem>();
    createQuickPick.mockReturnValue(qp);

    registerDownloadsSortCommand(provider);
    invoke('modbench.downloadedFile.sort');
    await vi.waitFor(() => expect(createQuickPick).toHaveBeenCalled());
    escape();

    expect(qp.activeItems).toEqual([{ label: 'Size (Smallest First)', column: 'size', descending: false }]);
  });

  it('pre-selects Filetime (Newest First) at the default sort', async () => {
    const provider = fakeDownloadsProvider();
    const { qp, escape } = fakeQuickPick<FakeSortItem>();
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
    const downloadedFile = await writeDownloadedFile(root, 'foo.7z');

    registerDownloadsSingleRowCommands(recordingReporter(), () => [node(root, 'foo.7z')]);
    await invoke('modbench.downloadedFile.open');

    expect(calledFsPath(openExternal)).toBe(downloadedFile);
  });

  it('open metadata opens the one selected file\'s metadata', async () => {
    const root = await makeInstanceRoot();
    await writeDownloadedFile(root, 'foo.7z');
    const meta = await writeMeta(root, 'foo.7z');

    registerDownloadsSingleRowCommands(recordingReporter(), () => [node(root, 'foo.7z', { hasMeta: true })]);
    await invoke('modbench.downloadedFile.openMeta');

    expect(calledFsPath(showTextDocument)).toBe(meta);
  });

  it.each([
    ['exclude', {}, 'Excluded'],
    ['include', { excluded: true }, 'Included'],
  ])('%s takes the whole selection', async (verb, row, mark) => {
    const fake = downloadsFake();

    registerDownloadsMultiRowCommands(downloadedFileCommands(fake.adapter), instanceThatReads, recordingReporter(), scriptedDialog(), trash, downloadsLog, () => [node(ROOT, 'a.7z', row), node(ROOT, 'b.7z', row)]);
    await invoke(`modbench.downloadedFile.${verb}`);

    expect(fake.calls).toEqual(['a.7z', 'b.7z'].map((name) => ({ verb: 'markDownloadedFile', name, mark })));
  });
});
