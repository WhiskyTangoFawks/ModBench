import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { fakeVscodeModule } from '../../test/mo2/fakeVscodeWatcher';

vi.mock('vscode', () => fakeVscodeModule());

import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { downloadsCommands } from '../downloads';
import { cloneCorpusFixture } from '../../test/mo2/corpusFixture';
import type { InstanceAdapter } from '../../instanceAdapter/instanceAdapter';
import { adapterOver, readDownloadedFileMeta } from '../../test/mo2/adapterOver';
import { assertSelectionOutcome } from '../../test/surfacingDoubles';
import type { MoveToTrash } from '../../ports/trash';

let root: string;
let adapter: InstanceAdapter;

beforeEach(() => {
  root = cloneCorpusFixture();
  adapter = adapterOver(root);
});
afterEach(() => rm(root, { recursive: true, force: true }));

const archivePath = (name: string): string => join(root, 'downloads', name);
const metaPath = (name: string): string => join(root, 'downloads', `${name}.meta`);

async function writeArchive(name: string): Promise<{ name: string; path: string }> {
  const path = archivePath(name);
  await writeFile(path, 'archive bytes');
  return { name, path };
}

const statusOf = (name: string) => readDownloadedFileMeta(root, name);

const recordingTrash = (fail: (path: string) => Error | undefined = () => undefined) => {
  const trashed: string[] = [];
  const trash: MoveToTrash = (path) => {
    trashed.push(path);
    const err = fail(path);
    return err === undefined ? rm(path) : Promise.reject(err);
  };
  return { trash, trashed };
};

describe('excludeDownloads / includeDownloads — one name', () => {
  const refusedFor = (name: string, reasonContains: string) => ({ landed: [], refused: [{ item: name, reasonContains }] });

  it('excluding a file gone from disk is refused, naming it, and writes it no metadata', async () => {
    assertSelectionOutcome(await downloadsCommands(adapter).excludeDownloads(['foo.7z']), refusedFor('foo.7z', 'foo.7z'));
    await expect(readFile(metaPath('foo.7z'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('including a file gone from disk is refused, naming it, and leaves its stale metadata alone', async () => {
    await writeFile(metaPath('foo.7z'), '[General]\r\nremoved=true\r\n');

    assertSelectionOutcome(await downloadsCommands(adapter).includeDownloads(['foo.7z']), refusedFor('foo.7z', 'foo.7z'));
    expect(await readFile(metaPath('foo.7z'), 'utf8')).toBe('[General]\r\nremoved=true\r\n');
  });

  it('refuses rather than throwing when the metadata cannot be written, here for a directory where it belongs', async () => {
    await writeArchive('foo.7z');
    await mkdir(metaPath('foo.7z'));

    assertSelectionOutcome(await downloadsCommands(adapter).excludeDownloads(['foo.7z']), refusedFor('foo.7z', 'EISDIR'));
  });

  it('an exclude racing an installed mark leaves both marks set, rather than the second writer dropping the first key', async () => {
    await writeArchive('foo.7z');

    await Promise.all([downloadsCommands(adapter).excludeDownloads(['foo.7z']), adapter.markDownloadedFile('foo.7z', 'Installed')]);

    expect(await statusOf('foo.7z')).toMatchObject({ excluded: true, status: 'Installed' });
  });
});

describe('deleteDownloads', () => {
  it('trashes only the file when it has no metadata', async () => {
    const file = await writeArchive('manual.7z');
    const { trash, trashed } = recordingTrash();

    const outcome = await downloadsCommands(adapter).deleteDownloads([file], trash);

    expect(outcome).toEqual({ landed: [{ name: 'manual.7z' }], refused: [] });
    expect(trashed).toEqual([file.path]);
  });

  it('hands the Instance adapter the metadata by the file\'s name, not a path the command joins itself', async () => {
    const file = await writeArchive('foo.7z');
    const asked: string[] = [];
    const counted: InstanceAdapter = {
      ...adapter,
      trashDownloadedFileMeta: (name, trash) => {
        asked.push(name);
        return adapter.trashDownloadedFileMeta(name, trash);
      },
    };

    await downloadsCommands(counted).deleteDownloads([file], recordingTrash().trash);

    expect(asked).toEqual(['foo.7z']);
  });
});
