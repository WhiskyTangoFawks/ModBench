import { describe, it, expect } from 'vitest';
import { downloadsCommands } from '../downloads';
import { fakeInstanceAdapter, readingFixture, type InstanceAnswers } from '../../test/fakeInstanceAdapter';
import { assertSelectionOutcome } from '../../test/surfacingDoubles';
import type { MoveToTrash } from '../../ports/trash';

const commandsOver = (answers: InstanceAnswers = {}) => {
  const fake = fakeInstanceAdapter(readingFixture(), answers);
  return { fake, commands: downloadsCommands(fake.adapter) };
};

const recordingTrash = (failFor?: string) => {
  const trashed: string[] = [];
  const trash: MoveToTrash = (path) => {
    trashed.push(path);
    return path === failFor ? Promise.reject(new Error('disk full')) : Promise.resolve();
  };
  return { trash, trashed };
};

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
    const { commands } = commandsOver({ refusals: { markDownloadedFile: 'EISDIR: illegal operation on a directory' } });

    assertSelectionOutcome(await commands.excludeDownloads(['foo.7z']), {
      landed: [],
      refused: [{ item: 'foo.7z', reasonContains: 'EISDIR' }],
    });
  });
});

describe('deleteDownloads', () => {
  const FILE = { name: 'foo.7z', path: '/downloads/foo.7z' };

  it('trashes the file, then hands the adapter the metadata by the file\'s name', async () => {
    const { fake, commands } = commandsOver();
    const { trash, trashed } = recordingTrash();

    const outcome = await commands.deleteDownloads([FILE], trash);

    expect(outcome).toEqual({ landed: [{ name: 'foo.7z' }], refused: [] });
    expect(trashed).toEqual([FILE.path]);
    expect(fake.calls).toEqual([{ verb: 'trashDownloadedFileMeta', name: 'foo.7z' }]);
  });

  it('a trash failure on the file refuses with why and leaves its metadata alone', async () => {
    const { fake, commands } = commandsOver();

    const outcome = await commands.deleteDownloads([FILE], recordingTrash(FILE.path).trash);

    expect(outcome).toEqual({ landed: [], refused: [{ item: { name: 'foo.7z' }, reason: 'disk full' }] });
    expect(fake.calls).toEqual([]);
  });

  it('a metadata failure after the file landed reports the delete as done, not a refusal', async () => {
    const { commands } = commandsOver({ refusals: { trashDownloadedFileMeta: 'disk full' } });

    const outcome = await commands.deleteDownloads([FILE], recordingTrash().trash);

    expect(outcome).toEqual({ landed: [{ name: 'foo.7z', metadataLeftBehind: 'disk full' }], refused: [] });
  });

  it('over a selection, a file that cannot be trashed is refused and the rest are deleted', async () => {
    const { fake, commands } = commandsOver();
    const locked = { name: 'locked.7z', path: '/downloads/locked.7z' };
    const other = { name: 'other.7z', path: '/downloads/other.7z' };

    const outcome = await commands.deleteDownloads([FILE, locked, other], recordingTrash(locked.path).trash);

    expect(outcome).toEqual({
      landed: [{ name: 'foo.7z' }, { name: 'other.7z' }],
      refused: [{ item: { name: 'locked.7z' }, reason: 'disk full' }],
    });
    expect(fake.calls).toEqual([
      { verb: 'trashDownloadedFileMeta', name: 'foo.7z' },
      { verb: 'trashDownloadedFileMeta', name: 'other.7z' },
    ]);
  });
});
