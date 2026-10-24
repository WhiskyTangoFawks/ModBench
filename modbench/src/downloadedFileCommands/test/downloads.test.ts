import { describe, it, expect } from 'vitest';
import { downloadedFileCommands } from '../downloads';
import { downloadedFilesOf, fakeInstanceAdapter, refusing, readingFixture, type InstanceAnswers } from '../../test/fakeInstanceAdapter';
import { assertSelectionOutcome } from '../../test/surfacingDoubles';
import type { MoveToTrash } from '../../ports/trash';

const commandsOver = (answers: InstanceAnswers = {}) => {
  const fake = fakeInstanceAdapter(readingFixture({ downloadedFiles: downloadedFilesOf('a.7z', 'b.7z', 'foo.7z', 'locked.7z', 'other.7z') }), answers);
  return { fake, commands: downloadedFileCommands(fake.adapter) };
};

const noopTrash: MoveToTrash = () => Promise.resolve();

describe('excluding and including downloaded files', () => {
  it.each([
    ['excludeDownloadedFiles', 'Excluded'],
    ['includeDownloadedFiles', 'Included'],
  ] as const)('%s marks every name %s and refuses the one gone from disk, by name', async (verb, mark) => {
    const { fake, commands } = commandsOver();

    const outcome = await commands[verb](['a.7z', 'gone.7z', 'b.7z']);

    assertSelectionOutcome(outcome, { landed: ['a.7z', 'b.7z'], refused: [{ item: 'gone.7z', reasonContains: 'gone.7z' }] });
    expect(fake.calls).toEqual(['a.7z', 'gone.7z', 'b.7z'].map((name) => ({ verb: 'markDownloadedFile', name, mark })));
  });

  it('refuses rather than throwing when the metadata cannot be written, with the adapter\'s reason', async () => {
    const { commands } = commandsOver({ refusals: refusing('markDownloadedFile', 'EISDIR: illegal operation on a directory') });

    assertSelectionOutcome(await commands.excludeDownloadedFiles(['foo.7z']), {
      landed: [],
      refused: [{ item: 'foo.7z', reasonContains: 'EISDIR' }],
    });
  });
});

describe('deleting downloaded files', () => {
  it('hands the adapter each name, and lands it', async () => {
    const { fake, commands } = commandsOver();

    const outcome = await commands.deleteDownloadedFiles(['foo.7z'], noopTrash);

    expect(outcome).toEqual({ landed: [{ name: 'foo.7z' }], refused: [] });
    expect(fake.calls).toEqual([{ verb: 'trashDownloadedFile', name: 'foo.7z' }]);
  });

  it('refuses a file gone from disk, by name', async () => {
    const { commands } = commandsOver();

    assertSelectionOutcome(await commands.deleteDownloadedFiles(['gone.7z'], noopTrash), {
      landed: [],
      refused: [{ item: { name: 'gone.7z' }, reasonContains: 'gone.7z' }],
    });
  });

  it('metadata left behind after the file landed reports the delete as done, not a refusal', async () => {
    const { commands } = commandsOver({ metadataLeftBehind: 'disk full' });

    const outcome = await commands.deleteDownloadedFiles(['foo.7z'], noopTrash);

    expect(outcome).toEqual({ landed: [{ name: 'foo.7z', metadataLeftBehind: 'disk full' }], refused: [] });
  });

  it('over a selection, a file that cannot be trashed is refused and the rest are deleted', async () => {
    const { commands } = commandsOver({ refusals: (call) => (call.verb === 'trashDownloadedFile' && call.name === 'locked.7z' ? 'disk full' : undefined) });

    const outcome = await commands.deleteDownloadedFiles(['foo.7z', 'locked.7z', 'other.7z'], noopTrash);

    expect(outcome).toEqual({
      landed: [{ name: 'foo.7z' }, { name: 'other.7z' }],
      refused: [{ item: { name: 'locked.7z' }, reason: 'disk full' }],
    });
  });
});
