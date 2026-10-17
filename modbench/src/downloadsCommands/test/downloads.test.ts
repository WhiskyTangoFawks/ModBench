import { describe, it, expect } from 'vitest';
import { downloadsCommands } from '../downloads';
import { fakeInstanceAdapter, refusing, readingFixture, type InstanceAnswers } from '../../test/fakeInstanceAdapter';
import { assertSelectionOutcome } from '../../test/surfacingDoubles';
import type { MoveToTrash } from '../../ports/trash';

const commandsOver = (answers: InstanceAnswers = {}) => {
  const fake = fakeInstanceAdapter(readingFixture(), answers);
  return { fake, commands: downloadsCommands(fake.adapter) };
};

const recordingTrash = () => ({ trash: ((): Promise<void> => Promise.resolve()) satisfies MoveToTrash });

describe('excludeDownloads / includeDownloads', () => {
  it.each([
    ['excludeDownloads', 'Excluded'],
    ['includeDownloads', 'Included'],
  ] as const)('%s marks every name %s and refuses the one gone from disk, by name', async (verb, mark) => {
    const { fake, commands } = commandsOver({ goneDownloads: new Set(['gone.7z']) });

    const outcome = await commands[verb](['a.7z', 'gone.7z', 'b.7z']);

    assertSelectionOutcome(outcome, { landed: ['a.7z', 'b.7z'], refused: [{ item: 'gone.7z', reasonContains: 'gone.7z' }] });
    expect(fake.calls).toEqual(['a.7z', 'gone.7z', 'b.7z'].map((name) => ({ verb: 'markDownloadedFile', name, mark })));
  });

  it('refuses rather than throwing when the metadata cannot be written, with the adapter\'s reason', async () => {
    const { commands } = commandsOver({ refusals: refusing('markDownloadedFile', 'EISDIR: illegal operation on a directory') });

    assertSelectionOutcome(await commands.excludeDownloads(['foo.7z']), {
      landed: [],
      refused: [{ item: 'foo.7z', reasonContains: 'EISDIR' }],
    });
  });
});

describe('deleteDownloads', () => {
  it('hands the adapter each name with the trash, and lands it', async () => {
    const { fake, commands } = commandsOver();

    const outcome = await commands.deleteDownloads(['foo.7z'], recordingTrash().trash);

    expect(outcome).toEqual({ landed: [{ name: 'foo.7z' }], refused: [] });
    expect(fake.calls).toEqual([{ verb: 'trashDownloadedFile', name: 'foo.7z' }]);
  });

  it('refuses a file gone from disk, by name', async () => {
    const { commands } = commandsOver({ goneDownloads: new Set(['gone.7z']) });

    assertSelectionOutcome(await commands.deleteDownloads(['gone.7z']), {
      landed: [],
      refused: [{ item: { name: 'gone.7z' }, reasonContains: 'gone.7z' }],
    });
  });

  it('a trash failure on the file refuses with why', async () => {
    const { commands } = commandsOver({ refusals: refusing('trashDownloadedFile', 'disk full') });

    const outcome = await commands.deleteDownloads(['foo.7z'], recordingTrash().trash);

    expect(outcome).toEqual({ landed: [], refused: [{ item: { name: 'foo.7z' }, reason: 'disk full' }] });
  });

  it('metadata left behind after the file landed reports the delete as done, not a refusal', async () => {
    const { commands } = commandsOver({ metadataLeftBehind: 'disk full' });

    const outcome = await commands.deleteDownloads(['foo.7z'], recordingTrash().trash);

    expect(outcome).toEqual({ landed: [{ name: 'foo.7z', metadataLeftBehind: 'disk full' }], refused: [] });
  });

  it('over a selection, a file that cannot be trashed is refused and the rest are deleted', async () => {
    const { commands } = commandsOver({ refusals: (call) => (call.verb === 'trashDownloadedFile' && call.name === 'locked.7z' ? 'disk full' : undefined) });

    const outcome = await commands.deleteDownloads(['foo.7z', 'locked.7z', 'other.7z'], recordingTrash().trash);

    expect(outcome).toEqual({
      landed: [{ name: 'foo.7z' }, { name: 'other.7z' }],
      refused: [{ item: { name: 'locked.7z' }, reason: 'disk full' }],
    });
  });
});
