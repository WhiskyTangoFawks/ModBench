import { describe, it, expect } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { downloadedFileCommands } from '../downloads';
import { downloadedFilesOf, fakeInstanceAdapter, modFoldersIn, refusing, readingFixture, type InstanceAnswers } from '../../test/fakeInstanceAdapter';
import { heldTexts, type FileChanges } from '../../symbolNames/symbolNames';
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

describe('renaming a downloaded file another program renames (symbols.md, The features, stories 6 and 9)', () => {
  const MANIFEST = '{\n"version":1,\n"packages":[\n{"kind":"installationFile","name":"foo.7z","size":1,"hash":"AAAAAAAAAAA="}\n]\n}\n';

  async function renamer(answers: InstanceAnswers = {}) {
    const mods = await mkdtemp(join(tmpdir(), 'renameDownloadedFile-'));
    await mkdir(join(mods, 'Foo'));
    await writeFile(join(mods, 'Foo', 'Foo.manifest.json'), MANIFEST);
    const fake = fakeInstanceAdapter(readingFixture({ downloadedFiles: downloadedFilesOf('foo.7z'), modFolders: modFoldersIn(mods, { kind: 'mod', name: 'Foo' }) }), answers);
    const applied: (readonly FileChanges[])[] = [];
    const editing = { held: heldTexts([]), apply: (changes: readonly FileChanges[]) => { applied.push(changes); return Promise.resolve(undefined); } };
    const rename = (to: string) => downloadedFileCommands(fake.adapter).renameDownloadedFile(editing, 'foo.7z', to);
    return { fake, applied, rename, mods, done: () => rm(mods, { recursive: true, force: true }) };
  }

  it('applies each manifest\'s package renamed, then renames the file and the mods\' metadata through the adapter', async () => {
    const { fake, applied, rename, mods, done } = await renamer();

    expect(await rename('bar.7z')).toEqual({ applied: true, cannotFollow: [] });
    expect(applied.flat().flatMap(({ documents }) => documents)).toEqual([{ path: join(mods, 'Foo', 'Foo.manifest.json'), text: MANIFEST.replace('foo.7z', 'bar.7z') }]);
    expect(fake.calls).toEqual([{ verb: 'renameDownloadedFile', from: 'foo.7z', to: 'bar.7z' }]);
    await done();
  });

  it('refuses a name install cannot take, carrying nothing', async () => {
    const { fake, applied, rename, done } = await renamer();

    expect(await rename('foo.7z.bak')).toEqual({ applied: false, refusal: 'Not a file install can take: "foo.7z.bak"' });
    expect([fake.calls, applied]).toEqual([[], []]);
    await done();
  });

  it('fails, its references changed, when the adapter cannot move the file', async () => {
    const { rename, done } = await renamer({ refusals: refusing('renameDownloadedFile', '"bar.7z" is in the way') });

    expect(await rename('bar.7z')).toEqual({ applied: false, failed: '"bar.7z" is in the way', edited: true, moved: [] });
    await done();
  });
});
