import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const {
  executeCommand, registerCommand, showTextDocument, createQuickPick, openExternal,
} = vi.hoisted(() => ({
  executeCommand: vi.fn(),
  registerCommand: vi.fn((_id: string, handler: (...args: unknown[]) => unknown) => ({ dispose: vi.fn(), handler })),
  showTextDocument: vi.fn(),
  createQuickPick: vi.fn(),
  openExternal: vi.fn(),
}));

import { TreeItem, TreeItemCollapsibleState, EventEmitter, ThemeIcon, ThemeColor, MarkdownString, type FakeUri } from '../../test/vscodeMock';
import { present } from '../../ports/present';
import { fakeQuickPick } from '../../drivingLib/test/quickPickDouble';
import { progressSteps, recordedWithProgress } from '../../test/recordedProgress';

vi.mock('vscode', () => ({
  commands: { executeCommand, registerCommand },
  window: { showTextDocument, createQuickPick, withProgress: recordedWithProgress },
  env: { openExternal },
  Uri: { file: (p: string) => ({ fsPath: p, toString: () => `file://${p}` }) },
  TreeItem, TreeItemCollapsibleState, EventEmitter, ThemeIcon, ThemeColor, MarkdownString,
}));

import { join } from 'node:path';
import {
  registerDownloadsExcludedToggleCommands,
  registerDownloadsMultiRowCommands,
  registerDownloadsQueryInfoCommand,
  registerDownloadsSingleRowCommands,
  registerDownloadsSortCommand,
} from '../DownloadsPanel';
import { DownloadedFileNode, DownloadsProvider } from '../DownloadsProvider';
import { downloadedFileNodeFixture } from '../../test/mo2/downloadedFileNodeFixture';
import { FakeInstance } from '../../test/mo2/fakeInstance';
import { downloadedFileCommands } from '../../downloadedFileCommands/downloads';
import type { QueryInfo } from '../../downloadedFileCommands/queryInfo';
import { AgentCall } from '../../drivingLib/agentGesture';
import { Refusal } from '../../drivingLib/refusal';
import type { MoveToTrash } from '../../ports/trash';
import type { LocatedDownloadedFileRow, DownloadedFileRow, Instance } from '../../instanceLoader/instance';
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

const fakeInstance = (downloads: readonly LocatedDownloadedFileRow[] = []): Pick<Instance, 'value' | 'refresh'> => ({
  value: instanceValueFixture({ downloadedFiles: { kind: 'listed', rows: downloads } }),
  refresh: () => { progressSteps.push('Instance loader: read every file again'); return Promise.resolve(); },
});

const providerOver = (...rows: LocatedDownloadedFileRow[]) =>
  new DownloadsProvider({ instance: new FakeInstance(instanceValueFixture({ downloadedFiles: { kind: 'listed', rows } })) });

const instanceThatReads = fakeInstance();

const commandsStillRunningWhenTheirTestEnded: Promise<unknown>[] = [];

let downloadsLogLines: string[] = [];
const downloadsLog = (line: string): void => { downloadsLogLines.push(line); };

afterEach(async () => {
  await Promise.allSettled(commandsStillRunningWhenTheirTestEnded.splice(0));
  downloadsLogLines = [];
});

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

describe('opening a downloaded file or its metadata', () => {
  beforeEach(() => vi.clearAllMocks());

  it.each([
    ['open: OS-opens the downloaded file', 'modbench.downloadedFile.open', openExternal, join(ROOT, 'downloads', 'foo.7z'), showTextDocument],
    ['open metadata: opens the metadata file', 'modbench.downloadedFile.openMeta', showTextDocument, join(ROOT, 'downloads', 'foo.7z.meta'), openExternal],
  ])('%s, and opens nothing else', async (_case, command, opener, path, other) => {
    registerDownloadsSingleRowCommands(recordingReporter(), () => []);
    invoke(command, node(ROOT, 'foo.7z', { hasMeta: true }));

    await vi.waitFor(() => expect(opener).toHaveBeenCalled());
    expect(calledFsPath(opener)).toBe(path);
    expect(other).not.toHaveBeenCalled();
  });

  it.each([
    ['open', 'modbench.downloadedFile.open', openExternal, 'no handler for this file type', 'Open File for "foo.7z" failed.'],
    ['open metadata', 'modbench.downloadedFile.openMeta', showTextDocument, 'file changed on disk', 'Open Metadata for "foo.7z" failed.'],
  ])('%s: on failure, reports an error naming the action and row', async (_case, command, opener, reason, message) => {
    opener.mockRejectedValueOnce(new Error(reason));
    const report = recordingReporter();

    registerDownloadsSingleRowCommands(report, () => []);
    invoke(command, node(ROOT, 'foo.7z', { hasMeta: true }));

    await vi.waitFor(() => expect(report.reports).toHaveLength(1));
    expect(report.reports).toEqual([{ severity: 'error', message, detail: reason }]);
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

  it.each([
    ['exclude', {}, 'Excluded'],
    ['include', { excluded: true }, 'Included'],
  ])('%s writes the mark, then the read, then the bar closes', async (verb, row, mark) => {
    const fake = downloadsFake();

    registerDownloadsMultiRowCommands(downloadedFileCommands(fake.adapter), instanceReadingTheWrites(fake), recordingReporter(), scriptedDialog(), trash, downloadsLog, () => []);
    await invoke(`modbench.downloadedFile.${verb}`, node(ROOT, 'foo.7z', row));

    expect(progressSteps).toEqual([opens, `read finds markDownloadedFile ${mark}`, 'progress closes']);
  });

  it.each([
    ['exclude', 'modbench.downloadedFile.exclude', { excluded: true }, 'Excluded'],
    ['include', 'modbench.downloadedFile.include', { excluded: false }, 'Included'],
  ])('%s still hands the adapter the mark for a row the view shows already in that state, since the disk decides', async (_name, command, row, mark) => {
    const fake = downloadsFake();

    registerDownloadsMultiRowCommands(downloadedFileCommands(fake.adapter), instanceThatReads, recordingReporter(), scriptedDialog(), trash, downloadsLog, () => []);
    await invoke(command, node(ROOT, 'foo.7z', row));

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
    ['one file', (a) => [a], 'Delete "a.7z"? It will be moved to the system trash. The installed mod, if any, is untouched.'],
    ['the count for several files', (a, b) => [a, b], 'Delete 2 items? They will be moved to the system trash. The installed mod, if any, is untouched.'],
  ])('names %s, says trash, and says the installed mod is untouched', async (_name, selecting, question) => {
    const selection = selecting(node(ROOT, 'a.7z'), node(ROOT, 'b.7z'));
    const ask = scriptedDialog('Delete');

    registerDownloadsMultiRowCommands(downloadedFileCommands(downloadsFake().adapter), instanceThatReads, recordingReporter(), ask, trash, downloadsLog, () => []);
    invoke('modbench.downloadedFile.delete', selection[0], selection);

    await vi.waitFor(() => expect(ask.asked).toHaveLength(1));
    expect(present(ask.asked[0], 'the one recorded question').message).toBe(question);
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
  const listing = (...names: string[]) => fakeInstance(names.map((name) => downloadedFileRowFixture(name, {}, ROOT)));
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

describe('query info from the Downloads view', () => {
  beforeEach(() => { vi.clearAllMocks(); progressSteps.length = 0; });

  const QUERY = 'modbench.downloadedFile.queryInfo';
  const queryInfo = vi.fn<QueryInfo>();
  const register = (reporter = recordingReporter(), instance = instanceThatReads) => {
    registerDownloadsQueryInfoCommand(queryInfo, instance, reporter, () => [node(ROOT, 'selected.7z')]);
    return reporter;
  };

  it('asks about the selected files, then reads the instance again, in one bar', async () => {
    queryInfo.mockResolvedValue({ applied: true, outcome: { landed: [{ name: 'a.7z' }, { name: 'b.7z' }], refused: [] } });
    register();

    await invoke(QUERY, node(ROOT, 'a.7z'), [node(ROOT, 'a.7z'), node(ROOT, 'b.7z')]);

    expect(queryInfo).toHaveBeenCalledWith(['a.7z', 'b.7z']);
    expect(progressSteps).toEqual(['progress opens on modbench.downloads', 'Instance loader: read every file again', 'progress closes']);
  });

  it('says in one line how many files it filled', async () => {
    queryInfo.mockResolvedValue({ applied: true, outcome: { landed: [{ name: 'a.7z' }, { name: 'b.7z' }], refused: [] } });
    const reporter = register();

    await invoke(QUERY, node(ROOT, 'a.7z'), [node(ROOT, 'a.7z'), node(ROOT, 'b.7z')]);

    expect(reporter.landings).toEqual(['Query info: 2 of 2 files filled.']);
    expect(reporter.reports).toEqual([]);
  });

  it('warns once, naming each file Nexus does not know in the Output', async () => {
    queryInfo.mockResolvedValue({
      applied: true,
      outcome: { landed: [{ name: 'b.7z' }], refused: [{ item: { name: 'a.7z' }, reason: 'Nexus does not know this file.' }, { item: { name: 'c.7z' }, reason: 'EACCES' }] },
    });
    const reporter = register();

    await invoke(QUERY, node(ROOT, 'a.7z'), [node(ROOT, 'a.7z'), node(ROOT, 'b.7z'), node(ROOT, 'c.7z')]);

    expect(reporter.reports).toEqual([{
      severity: 'warning', message: 'Query info: 1 of 3 files filled.', detail: '"a.7z" (Nexus does not know this file.)\n"c.7z" (EACCES)',
    }]);
    expect(reporter.landings).toEqual([]);
  });

  it('warns of each file that was written although a request for more failed', async () => {
    queryInfo.mockResolvedValue({ applied: true, outcome: { landed: [{ name: 'a.7z', notice: 'Failed to request file info from Nexus: Nexus answered 503.' }], refused: [] } });
    const reporter = register();

    await invoke(QUERY, node(ROOT, 'a.7z'));

    expect(reporter.landings).toEqual(['Query info: 1 of 1 files filled.']);
    expect(reporter.reports).toEqual([{
      severity: 'warning', message: 'Query info for "a.7z" wrote less than Nexus knows', detail: 'Failed to request file info from Nexus: Nexus answered 503.',
    }]);
  });

  it('reports a refused selection as an error', async () => {
    queryInfo.mockResolvedValue({ applied: false, refusal: 'You are not logged in to Nexus.' });
    const reporter = register();

    await invoke(QUERY, node(ROOT, 'a.7z'));

    expect(reporter.reports).toEqual([{ severity: 'error', message: 'You are not logged in to Nexus.', detail: undefined }]);
  });

  it('asks about the files an agent names, never the selection, and answers the outcome without reporting it', async () => {
    const outcome = { landed: [{ name: 'a.7z' }], refused: [] };
    queryInfo.mockResolvedValue({ applied: true, outcome });
    const reporter = register();

    const answered = await invoke(QUERY, new AgentCall([{ kind: 'downloadedFile', name: 'a.7z' }], {}));

    expect(queryInfo).toHaveBeenCalledWith(['a.7z']);
    expect(answered).toEqual({ applied: true, outcome, partial: [] });
    expect([reporter.reports, reporter.landings]).toEqual([[], []]);
  });

  it('refuses an Argument that is not a downloaded file, asking nothing', async () => {
    register();

    await expect(invoke(QUERY, new AgentCall([{ kind: 'mod', name: 'a.7z' }], {}))).rejects.toBeInstanceOf(Refusal);

    expect(queryInfo).not.toHaveBeenCalled();
  });
});

interface FakeSortItem { label: string; column: string; descending: boolean }

describe('sorting the Downloads view', () => {
  beforeEach(() => vi.clearAllMocks());

  it('sorts the view by the picked option', async () => {
    const provider = providerOver();
    const { qp, accept } = fakeQuickPick<FakeSortItem>();
    createQuickPick.mockReturnValue(qp);

    registerDownloadsSortCommand(provider);
    invoke('modbench.downloadedFile.sort');
    await vi.waitFor(() => expect(createQuickPick).toHaveBeenCalled());
    accept({ label: 'Size (Largest First)', column: 'size', descending: true });

    await vi.waitFor(() => {
      expect(provider.currentSort()).toEqual({ column: 'size', descending: true });
    });
  });

  it('leaves the sort as it was when Esc is pressed', async () => {
    const provider = providerOver();
    const { qp, escape } = fakeQuickPick<FakeSortItem>();
    createQuickPick.mockReturnValue(qp);

    registerDownloadsSortCommand(provider);
    invoke('modbench.downloadedFile.sort');
    await vi.waitFor(() => expect(createQuickPick).toHaveBeenCalled());
    escape();

    await vi.waitFor(() => expect(qp.dispose).toHaveBeenCalled());
    expect(provider.currentSort()).toEqual({ column: 'mtimeMs', descending: true });
  });

  it.each<[string, (provider: DownloadsProvider) => void, FakeSortItem]>([
    ['the item matching the view\'s current sort', (provider) => { provider.setSort('size', false); }, { label: 'Size (Smallest First)', column: 'size', descending: false }],
    ['Filetime (Newest First) at the default sort', () => undefined, { label: 'Filetime (Newest First)', column: 'mtimeMs', descending: true }],
  ])('pre-selects %s', async (_case, sorted, marked) => {
    const provider = providerOver();
    sorted(provider);
    const { qp, escape } = fakeQuickPick<FakeSortItem>();
    createQuickPick.mockReturnValue(qp);

    registerDownloadsSortCommand(provider);
    invoke('modbench.downloadedFile.sort');
    await vi.waitFor(() => expect(createQuickPick).toHaveBeenCalled());
    escape();

    expect(qp.activeItems).toEqual([marked]);
  });
});

describe('showing and hiding excluded downloaded files', () => {
  beforeEach(() => vi.clearAllMocks());

  it.each([
    ['showExcluded turns Show excluded on and sets the context key true', false, 'modbench.downloadedFile.showExcluded', false, true],
    ['hideExcluded turns Show excluded off and sets the context key false', true, 'modbench.downloadedFile.hideExcluded', true, false],
  ])('%s', (_case, shownBefore, command, allExcluded, keyValue) => {
    const provider = providerOver(downloadedFileRowFixture('hidden.7z', { excluded: true }, ROOT));
    provider.setShowExcluded(shownBefore);
    registerDownloadsExcludedToggleCommands(provider);

    invoke(command);

    expect(provider.allExcluded()).toBe(allExcluded);
    expect(executeCommand).toHaveBeenCalledWith('setContext', 'modbench.downloadedFile.excludedShown', keyValue);
  });
});

describe('the Downloads gestures from the palette, handed no row, act on the view\'s selection', () => {
  beforeEach(() => vi.clearAllMocks());

  it.each([
    ['open opens the one selected file', 'modbench.downloadedFile.open', openExternal, join(ROOT, 'downloads', 'foo.7z')],
    ['open metadata opens the one selected file\'s metadata', 'modbench.downloadedFile.openMeta', showTextDocument, join(ROOT, 'downloads', 'foo.7z.meta')],
  ])('%s', async (_case, command, opener, path) => {
    registerDownloadsSingleRowCommands(recordingReporter(), () => [node(ROOT, 'foo.7z', { hasMeta: true })]);
    await invoke(command);

    expect(calledFsPath(opener)).toBe(path);
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
