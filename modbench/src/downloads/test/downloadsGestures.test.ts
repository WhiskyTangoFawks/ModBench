import { describe, it, expect, vi, beforeEach, afterEach, onTestFinished } from 'vitest';
import { join } from 'node:path';

vi.mock('vscode', async () => (await import('./downloadsVscode')).downloadsVscode());

import { clearRegistered, openExternal, registered, showTextDocument } from './downloadsVscode';
import { command, downloadsTree, everyRow, instanceListing, namesShown, rowNamed, valueListing } from './downloadsViewHarness';
import { FakeInstance } from '../../test/mo2/fakeInstance';
import { downloadedFileCommands } from '../../downloadedFileCommands/downloads';
import type { QueryInfo } from '../../downloadedFileCommands/queryInfo';
import { AgentCall } from '../../drivingLib/agentGesture';
import { surfaceManagerRunning } from '../../drivingLib/writingGesture';
import { Refusal } from '../../drivingLib/refusal';
import { present } from '../../ports/present';
import type { DownloadedFileRow } from '../../instanceLoader/instance';
import { recordingReporter, assertSelectionOutcome } from '../../test/surfacingDoubles';
import { downloadedFileRowFixture } from '../../test/mo2/downloadedFileRowFixture';
import { downloadedFilesOf, fakeInstanceAdapter, readingFixture, type InstanceAnswers } from '../../test/fakeInstanceAdapter';
import type { InstanceAdapter } from '../../instanceAdapter/instanceAdapter';
import { instanceValueFixture } from '../../test/mo2/instanceValueFixture';
import { progressSteps } from '../../test/recordedProgress';

const downloadsFake = (answers: InstanceAnswers = {}) =>
  fakeInstanceAdapter(readingFixture({ downloadedFiles: downloadedFilesOf('a.7z', 'b.7z', 'foo.7z', 'locked.7z') }), answers);

const ROOT = '/instance';
const row = (name: string, over: Partial<DownloadedFileRow> = {}) => downloadedFileRowFixture(name, over);
const listing = (...names: string[]) => instanceListing(...names.map((name) => row(name)));

const commandsStillRunningWhenTheirTestEnded: Promise<unknown>[] = [];

function invoke(id: string, ...args: unknown[]): Promise<unknown> {
  const running = Promise.resolve(command(id)(...args));
  commandsStillRunningWhenTheirTestEnded.push(running);
  return running;
}

beforeEach(() => {
  clearRegistered();
  progressSteps.length = 0;
});

afterEach(async () => {
  await Promise.allSettled(commandsStillRunningWhenTheirTestEnded.splice(0));
});

describe('opening a downloaded file or its metadata', () => {
  it.each([
    ['open: OS-opens the downloaded file', 'modbench.downloadedFile.open', openExternal, join(ROOT, 'downloads', 'foo.7z'), showTextDocument],
    ['open metadata: opens the metadata file', 'modbench.downloadedFile.openMeta', showTextDocument, join(ROOT, 'downloads', 'foo.7z.meta'), openExternal],
  ])('%s, and opens nothing else', async (_case, id, opener, path, other) => {
    await everyRow(instanceListing(row('foo.7z', { hasMeta: true })));

    await invoke(id, await rowNamed('foo.7z'));

    expect(opener.mock.calls.map(([uri]) => uri.fsPath)).toEqual([path]);
    expect(other).not.toHaveBeenCalled();
  });

  it.each([
    ['open', 'modbench.downloadedFile.open', openExternal, 'no handler for this file type', 'Open File for "foo.7z" failed.'],
    ['open metadata', 'modbench.downloadedFile.openMeta', showTextDocument, 'file changed on disk', 'Open Meta File for "foo.7z" failed.'],
  ])('%s: on failure, reports an error naming the action and row', async (_case, id, opener, reason, message) => {
    opener.mockRejectedValueOnce(new Error(reason));
    const reporter = recordingReporter();
    await everyRow(instanceListing(row('foo.7z', { hasMeta: true })), { reporterFor: () => reporter });

    await invoke(id, await rowNamed('foo.7z'));

    expect(reporter.reports).toEqual([{ severity: 'error', message, detail: reason }]);
  });
});

describe('a Downloads gesture that writes ends when its writes return, with the view\'s progress bar open throughout', () => {
  const opens = 'progress opens on modbench.downloads';

  it.each([
    ['exclude', {}, 'Excluded'],
    ['include', { excluded: true }, 'Included'],
  ])('%s writes the mark, then the bar closes', async (verb, over, mark) => {
    const fake = downloadsFake();
    await everyRow(instanceListing(row('foo.7z', over)), { commands: downloadedFileCommands(fake.adapter) });

    await invoke(`modbench.downloadedFile.${verb}`, await rowNamed('foo.7z'));

    expect({ steps: progressSteps, calls: fake.calls }).toEqual({ steps: [opens, 'progress closes'], calls: [{ verb: 'markDownloadedFile', name: 'foo.7z', mark }] });
  });

  it.each([
    ['exclude', 'modbench.downloadedFile.exclude', { excluded: true }, 'Excluded'],
    ['include', 'modbench.downloadedFile.include', { excluded: false }, 'Included'],
  ])('%s still hands the adapter the mark for a row the view shows already in that state, since the disk decides', async (_name, id, over, mark) => {
    const fake = downloadsFake();
    await everyRow(instanceListing(row('foo.7z', over)), { commands: downloadedFileCommands(fake.adapter) });

    await invoke(id, await rowNamed('foo.7z'));

    expect(fake.calls).toEqual([{ verb: 'markDownloadedFile', name: 'foo.7z', mark }]);
  });

  it('warns the user, as a notification, when the mod manager is running', async () => {
    const told = recordingReporter();
    const surface = surfaceManagerRunning({ reporter: told, running: () => Promise.resolve({ kind: 'running' }), message: () => 'MO2 is running.' });
    onTestFinished(() => { surface.dispose(); });
    await everyRow(listing('foo.7z'), { commands: downloadedFileCommands(downloadsFake().adapter) });

    await invoke('modbench.downloadedFile.exclude', await rowNamed('foo.7z'));

    expect(told.reports.map(({ severity, message }) => ({ severity, message }))).toEqual([{ severity: 'warning', message: 'MO2 is running.' }]);
  });

  it('delete trashes, then the bar closes', async () => {
    const { adapter } = downloadsFake();
    const trashing: InstanceAdapter = {
      ...adapter,
      trashDownloadedFile: (name, trashFile) => { progressSteps.push('trash'); return adapter.trashDownloadedFile(name, trashFile); },
    };
    await everyRow(listing('foo.7z'), { commands: downloadedFileCommands(trashing) });

    await invoke('modbench.downloadedFile.delete', await rowNamed('foo.7z'));

    expect(progressSteps).toEqual([opens, 'trash', 'progress closes']);
  });
});

describe('modbench.downloadedFile.exclude / include — a multi-name selection', () => {
  it.each([
    ['exclude', {}, 'Excluded'],
    ['include', { excluded: true }, 'Included'],
  ])('%s: given the right-clicked row and the selection, changes the whole selection, refuses the gone file, and reports once', async (verb, over, mark) => {
    const fake = downloadsFake();
    const reporter = recordingReporter();
    await everyRow(instanceListing(row('a.7z', over), row('b.7z', over), row('gone.7z', over)), {
      commands: downloadedFileCommands(fake.adapter), reporterFor: () => reporter,
    });

    await invoke(`modbench.downloadedFile.${verb}`, await rowNamed('b.7z'), [await rowNamed('a.7z'), await rowNamed('b.7z'), await rowNamed('gone.7z')]);

    expect(reporter.selectionOutcomeCalls).toHaveLength(1);
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
  it('given the right-clicked row and the selection, deletes the whole selection in one call, refuses the file that cannot go, and reports once', async () => {
    const fake = downloadsFake({
      refusals: (call) => (call.verb === 'trashDownloadedFile' && call.name === 'locked.7z' ? 'EPERM: operation not permitted' : undefined),
    });
    const reporter = recordingReporter();
    await everyRow(listing('a.7z', 'b.7z', 'locked.7z'), { commands: downloadedFileCommands(fake.adapter), reporterFor: () => reporter });

    await invoke('modbench.downloadedFile.delete', await rowNamed('b.7z'), [await rowNamed('a.7z'), await rowNamed('b.7z'), await rowNamed('locked.7z')]);

    const outcome = {
      landed: [{ name: 'a.7z' }, { name: 'b.7z' }],
      refused: [{ item: { name: 'locked.7z' }, reason: 'EPERM: operation not permitted' }],
    };
    expect(fake.calls).toEqual(['a.7z', 'b.7z', 'locked.7z'].map((name) => ({ verb: 'trashDownloadedFile', name })));
    expect(reporter.selectionOutcomeCalls).toEqual([
      { message: 'Could not delete 1 of 3 downloaded files.', outcome },
    ]);
    expect(reporter.reports).toEqual([{
      severity: 'error',
      message: 'Could not delete 1 of 3 downloaded files.',
      detail: '"locked.7z" (EPERM: operation not permitted)',
    }]);
  });

  it('metadata left behind after the file landed is one Output line, under the view\'s tag, naming the word the instance supplies, no notification', async () => {
    const fake = downloadsFake({ metadataLeftBehind: 'EPERM: operation not permitted' });
    const reporter = recordingReporter();
    const lines: string[] = [];
    const instance = new FakeInstance(instanceValueFixture({
      ...valueListing(row('foo.7z')),
      managerNames: { manager: 'Another Manager', modOrderFile: 'order.txt', downloadedFileMetadataFile: 'zzz-managers-word' },
    }));
    await everyRow(instance, { commands: downloadedFileCommands(fake.adapter), reporterFor: () => reporter, channel: { warn: (line) => lines.push(line) } });

    await invoke('modbench.downloadedFile.delete', await rowNamed('foo.7z'));

    expect(lines).toEqual([
      '[downloadedFiles] "foo.7z" was deleted, but its zzz-managers-word could not be moved to the trash and was left behind: EPERM: operation not permitted',
    ]);
    expect(reporter.reports).toEqual([]);
  });
});

describe('the Downloads gestures called by the agent', () => {
  const named = (...names: string[]) => new AgentCall(names.map((name) => ({ kind: 'downloadedFile' as const, name })), {});

  async function agentsView(fake: ReturnType<typeof downloadsFake>, names: string[], reporter = recordingReporter(), lines: string[] = []) {
    await everyRow(listing(...names, 'selected.7z'), {
      commands: downloadedFileCommands(fake.adapter), reporterFor: () => reporter, channel: { warn: (line) => lines.push(line) },
    });
    downloadsTree().selectRows([await rowNamed('selected.7z')]);
  }

  it.each([
    ['exclude', 'Excluded'],
    ['include', 'Included'],
  ])('%s marks the files given, never the selection, and answers the outcome without reporting it', async (verb, mark) => {
    const fake = downloadsFake();
    const reporter = recordingReporter();
    await agentsView(fake, ['a.7z', 'b.7z'], reporter);

    const answered = await invoke(`modbench.downloadedFile.${verb}`, named('a.7z', 'b.7z'));

    expect(answered).toEqual({ applied: true, outcome: { landed: ['a.7z', 'b.7z'], refused: [] }, partial: [] });
    expect(fake.calls).toEqual(['a.7z', 'b.7z'].map((name) => ({ verb: 'markDownloadedFile', name, mark })));
    expect(reporter.reports).toEqual([]);
    expect(reporter.selectionOutcomeCalls).toEqual([]);
  });

  it('exclude answers the file gone from disk as refused, and the others as landed', async () => {
    const fake = downloadsFake();
    await agentsView(fake, ['a.7z', 'gone.7z']);

    const answered = await invoke('modbench.downloadedFile.exclude', named('a.7z', 'gone.7z'));

    expect(answered).toMatchObject({ applied: true, outcome: { landed: ['a.7z'], refused: [{ item: 'gone.7z' }] } });
  });

  it('delete trashes the files given, never the selection, and answers what it deleted', async () => {
    const reporter = recordingReporter();
    const fake = downloadsFake();
    await agentsView(fake, ['a.7z'], reporter);

    const answered = await invoke('modbench.downloadedFile.delete', named('a.7z'));

    expect(answered).toEqual({ applied: true, outcome: { landed: [{ name: 'a.7z' }], refused: [] }, partial: [] });
    expect(fake.calls).toEqual([{ verb: 'trashDownloadedFile', name: 'a.7z' }]);
    expect(reporter.reports).toEqual([]);
  });

  it('delete answers the metadata left behind as a log partial, writing no line itself', async () => {
    const fake = downloadsFake({ metadataLeftBehind: 'EPERM' });
    const lines: string[] = [];
    await agentsView(fake, ['a.7z'], recordingReporter(), lines);

    const answered = await invoke('modbench.downloadedFile.delete', named('a.7z'));

    expect(answered).toMatchObject({
      applied: true,
      partial: [{ message: '"a.7z" was deleted, but its .meta could not be moved to the trash and was left behind', detail: 'EPERM', severity: 'log' }],
    });
    expect(lines).toEqual([]);
  });

  it('delete refuses, item by item, a file the adapter finds gone, whatever the Instance value lists', async () => {
    const fake = downloadsFake();
    await agentsView(fake, ['a.7z']);

    const answered = await invoke('modbench.downloadedFile.delete', named('a.7z', 'gone.7z'));

    expect(answered).toMatchObject({ applied: true, outcome: { landed: [{ name: 'a.7z' }], refused: [{ item: { name: 'gone.7z' } }] } });
  });

  it.each(['delete', 'exclude', 'include'])('%s refuses an Argument that is not a downloaded file, writing nothing', async (verb) => {
    const fake = downloadsFake();
    await agentsView(fake, ['a.7z']);

    await expect(invoke(`modbench.downloadedFile.${verb}`, new AgentCall([{ kind: 'mod', name: 'a.7z' }], {}))).rejects.toBeInstanceOf(Refusal);

    expect(fake.calls).toEqual([]);
  });
});

describe('query info from the Downloads view', () => {
  const QUERY = 'modbench.downloadedFile.queryInfo';
  const queryInfo = vi.fn<QueryInfo>();

  async function queryView(answer: Awaited<ReturnType<QueryInfo>>) {
    queryInfo.mockResolvedValue(answer);
    const reporter = recordingReporter();
    await everyRow(listing('a.7z', 'b.7z', 'c.7z', 'selected.7z'), { queryInfo, reporterFor: () => reporter });
    downloadsTree().selectRows([await rowNamed('selected.7z')]);
    return reporter;
  }

  it('asks about the selected files, in one bar', async () => {
    await queryView({ applied: true, outcome: { landed: [{ name: 'a.7z' }, { name: 'b.7z' }], refused: [] } });

    await invoke(QUERY, await rowNamed('a.7z'), [await rowNamed('a.7z'), await rowNamed('b.7z')]);

    expect(queryInfo.mock.calls).toEqual([[['a.7z', 'b.7z']]]);
    expect(progressSteps).toEqual(['progress opens on modbench.downloads', 'progress closes']);
  });

  it('says in one line how many files it filled', async () => {
    const reporter = await queryView({ applied: true, outcome: { landed: [{ name: 'a.7z' }, { name: 'b.7z' }], refused: [] } });

    await invoke(QUERY, await rowNamed('a.7z'), [await rowNamed('a.7z'), await rowNamed('b.7z')]);

    expect(reporter.landings).toEqual(['Query info: 2 of 2 files filled.']);
    expect(reporter.reports).toEqual([]);
  });

  it('warns once, naming each file Nexus does not know in the Output', async () => {
    const reporter = await queryView({
      applied: true,
      outcome: { landed: [{ name: 'b.7z' }], refused: [{ item: { name: 'a.7z' }, reason: 'Nexus does not know this file.' }, { item: { name: 'c.7z' }, reason: 'EACCES' }] },
    });

    await invoke(QUERY, await rowNamed('a.7z'), [await rowNamed('a.7z'), await rowNamed('b.7z'), await rowNamed('c.7z')]);

    expect(reporter.reports).toEqual([{
      severity: 'warning', message: 'Query info: 1 of 3 files filled.', detail: '"a.7z" (Nexus does not know this file.)\n"c.7z" (EACCES)',
    }]);
    expect(reporter.landings).toEqual([]);
  });

  it('warns of each file that was written although a request for more failed', async () => {
    const reporter = await queryView({ applied: true, outcome: { landed: [{ name: 'a.7z', notice: 'Failed to request file info from Nexus: Nexus answered 503.' }], refused: [] } });

    await invoke(QUERY, await rowNamed('a.7z'));

    expect(reporter.landings).toEqual(['Query info: 1 of 1 files filled.']);
    expect(reporter.reports).toEqual([{
      severity: 'warning', message: 'Query info for "a.7z" wrote less than Nexus knows', detail: 'Failed to request file info from Nexus: Nexus answered 503.',
    }]);
  });

  it('reports a refused selection as an error', async () => {
    const reporter = await queryView({ applied: false, refusal: 'You are not logged in to Nexus.' });

    await invoke(QUERY, await rowNamed('a.7z'));

    expect(reporter.reports).toEqual([{ severity: 'error', message: 'You are not logged in to Nexus.', detail: undefined }]);
  });

  it('asks about the files an agent names, never the selection, and answers the outcome without reporting it', async () => {
    const outcome = { landed: [{ name: 'a.7z' }], refused: [] };
    const reporter = await queryView({ applied: true, outcome });

    const answered = await invoke(QUERY, new AgentCall([{ kind: 'downloadedFile', name: 'a.7z' }], {}));

    expect(queryInfo.mock.calls).toEqual([[['a.7z']]]);
    expect(answered).toEqual({ applied: true, outcome, partial: [] });
    expect([reporter.reports, reporter.landings]).toEqual([[], []]);
  });

  it('refuses an Argument that is not a downloaded file, asking nothing', async () => {
    await queryView({ applied: true, outcome: { landed: [], refused: [] } });

    await expect(invoke(QUERY, new AgentCall([{ kind: 'mod', name: 'a.7z' }], {}))).rejects.toBeInstanceOf(Refusal);

    expect(queryInfo).not.toHaveBeenCalled();
  });
});

describe('showing and hiding excluded downloaded files', () => {
  it.each([
    ['showExcluded shows the excluded file and sets the context key true', 'modbench.downloadedFile.hideExcluded', 'modbench.downloadedFile.showExcluded', ['hidden.7z'], true],
    ['hideExcluded hides the excluded file and sets the context key false', 'modbench.downloadedFile.showExcluded', 'modbench.downloadedFile.hideExcluded', [], false],
  ])('%s', async (_case, before, id, names, keyValue) => {
    await everyRow(instanceListing(row('hidden.7z', { excluded: true })));
    await invoke(before);

    await invoke(id);

    expect([await namesShown(), registered.contextKeys.get('modbench.downloadedFile.excludedShown')]).toEqual([names, keyValue]);
  });
});

describe('the Downloads gestures from the palette, handed no row, act on the view\'s selection', () => {
  it.each([
    ['open opens the one selected file', 'modbench.downloadedFile.open', openExternal, join(ROOT, 'downloads', 'foo.7z')],
    ['open metadata opens the one selected file\'s metadata', 'modbench.downloadedFile.openMeta', showTextDocument, join(ROOT, 'downloads', 'foo.7z.meta')],
  ])('%s', async (_case, id, opener, path) => {
    await everyRow(instanceListing(row('foo.7z', { hasMeta: true })));
    downloadsTree().selectRows([await rowNamed('foo.7z')]);

    await invoke(id);

    expect(opener.mock.calls.map(([uri]) => uri.fsPath)).toEqual([path]);
  });

  it.each([
    ['exclude', {}, 'Excluded'],
    ['include', { excluded: true }, 'Included'],
  ])('%s takes the whole selection', async (verb, over, mark) => {
    const fake = downloadsFake();
    await everyRow(instanceListing(row('a.7z', over), row('b.7z', over)), { commands: downloadedFileCommands(fake.adapter) });
    downloadsTree().selectRows([await rowNamed('a.7z'), await rowNamed('b.7z')]);

    await invoke(`modbench.downloadedFile.${verb}`);

    expect(fake.calls).toEqual(['a.7z', 'b.7z'].map((name) => ({ verb: 'markDownloadedFile', name, mark })));
  });
});
