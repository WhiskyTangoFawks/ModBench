import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { fakeVscodeModule } from '../../test/mo2/fakeVscodeWatcher';

vi.mock('vscode', () => fakeVscodeModule());

import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  deleteDownloads, excludeDownload, excludeDownloads, includeDownload, includeDownloads,
  type DownloadsAccess, type DownloadsCommandResult,
} from '../downloads';
import { cloneCorpusFixture } from '../../test/mo2/corpusFixture';
import { accessTo, readDownloadedFileMeta } from '../../test/mo2/adapterOver';
import { assertSelectionOutcome } from '../../test/surfacingDoubles';
import type { MoveToTrash } from '../../ports/trash';

function assertRefusalNarrowedByHandSinceExpectStringContainingIsTypedAny(result: DownloadsCommandResult, expectedSubstring: string): void {
  if (result.applied) throw new Error('expected a refusal, got applied:true');
  expect(result.refusal).toContain(expectedSubstring);
}

let root: string;
let access: DownloadsAccess;

beforeEach(() => {
  root = cloneCorpusFixture();
  access = accessTo(root);
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

describe('excludeDownload / includeDownload', () => {
  it('exclude marks the file excluded, and include marks it included again', async () => {
    await writeArchive('foo.7z');

    expect(await excludeDownload(access, 'foo.7z')).toEqual({ applied: true, wrote: true });
    expect(await statusOf('foo.7z')).toMatchObject({ excluded: true });

    expect(await includeDownload(access, 'foo.7z')).toEqual({ applied: true, wrote: true });
    expect(await statusOf('foo.7z')).toMatchObject({ excluded: false });
  });

  it('a file already at rest is applied, and says nothing was written', async () => {
    await writeArchive('manual.7z');

    expect(await includeDownload(access, 'manual.7z')).toEqual({ applied: true, wrote: false });
  });

  it('excluding a file gone from disk is refused, naming it, and writes it no metadata', async () => {
    const outcome = await excludeDownload(access, 'foo.7z');

    assertRefusalNarrowedByHandSinceExpectStringContainingIsTypedAny(outcome, 'foo.7z');
    await expect(readFile(metaPath('foo.7z'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('including a file gone from disk is refused, naming it, and leaves its stale metadata alone', async () => {
    await writeFile(metaPath('foo.7z'), '[General]\r\nremoved=true\r\n');

    const outcome = await includeDownload(access, 'foo.7z');

    assertRefusalNarrowedByHandSinceExpectStringContainingIsTypedAny(outcome, 'foo.7z');
    expect(await readFile(metaPath('foo.7z'), 'utf8')).toBe('[General]\r\nremoved=true\r\n');
  });

  it('refuses rather than throwing when the metadata cannot be written, here for a directory where it belongs', async () => {
    await writeArchive('foo.7z');
    await mkdir(metaPath('foo.7z'));

    assertRefusalNarrowedByHandSinceExpectStringContainingIsTypedAny(await excludeDownload(access, 'foo.7z'), 'EISDIR');
  });

  it('an exclude racing an installed mark leaves both marks set, rather than the second writer dropping the first key', async () => {
    await writeArchive('foo.7z');

    await Promise.all([excludeDownload(access, 'foo.7z'), access.adapter.markDownloadedFile('foo.7z', 'Installed')]);

    expect(await statusOf('foo.7z')).toMatchObject({ excluded: true, status: 'Installed' });
  });
});

describe('excludeDownloads / includeDownloads — over a selection', () => {
  it('excludes every landing name and refuses the one gone from disk, by name', async () => {
    await writeArchive('a.7z');
    await writeArchive('b.7z');

    const outcome = await excludeDownloads(access, ['a.7z', 'gone.7z', 'b.7z']);

    assertSelectionOutcome(outcome, {
      landed: ['a.7z', 'b.7z'],
      refused: [{ item: 'gone.7z', reasonContains: 'gone.7z' }],
    });
    expect(await statusOf('a.7z')).toMatchObject({ excluded: true });
    expect(await statusOf('b.7z')).toMatchObject({ excluded: true });
  });

  it('includes every landing name and refuses the one gone from disk, by name', async () => {
    await writeArchive('a.7z');
    await writeArchive('b.7z');
    await excludeDownloads(access, ['a.7z', 'b.7z']);

    const outcome = await includeDownloads(access, ['a.7z', 'gone.7z', 'b.7z']);

    assertSelectionOutcome(outcome, {
      landed: ['a.7z', 'b.7z'],
      refused: [{ item: 'gone.7z', reasonContains: 'gone.7z' }],
    });
    expect(await statusOf('a.7z')).toMatchObject({ excluded: false });
    expect(await statusOf('b.7z')).toMatchObject({ excluded: false });
  });
});

describe('deleteDownloads', () => {
  it('trashes the file BEFORE its metadata: a mid-failure leaves the metadata in place, never a metaless trash', async () => {
    const file = await writeArchive('foo.7z');
    await writeFile(metaPath('foo.7z'), '[General]\r\n');
    const { trash, trashed } = recordingTrash();

    const outcome = await deleteDownloads(access, [file], trash);

    expect(outcome).toEqual({ landed: [{ name: 'foo.7z' }], refused: [] });
    expect(trashed).toEqual([file.path, metaPath('foo.7z')]);
  });

  it('trashes only the file when it has no metadata', async () => {
    const file = await writeArchive('manual.7z');
    const { trash, trashed } = recordingTrash();

    const outcome = await deleteDownloads(access, [file], trash);

    expect(outcome).toEqual({ landed: [{ name: 'manual.7z' }], refused: [] });
    expect(trashed).toEqual([file.path]);
  });

  it('refuses with the trash’s own reason when the file cannot go, and never touches its metadata', async () => {
    const file = await writeArchive('foo.7z');
    await writeFile(metaPath('foo.7z'), '[General]\r\n');
    const { trash, trashed } = recordingTrash(() => new Error('EPERM'));

    const outcome = await deleteDownloads(access, [file], trash);

    expect(outcome).toEqual({ landed: [], refused: [{ item: { name: 'foo.7z' }, reason: 'EPERM' }] });
    expect(trashed).toEqual([file.path]);
  });

  it('a metadata trash failure after the file landed reports the delete as done rather than refusing it, naming the reason', async () => {
    const file = await writeArchive('foo.7z');
    await writeFile(metaPath('foo.7z'), '[General]\r\n');
    const { trash, trashed } = recordingTrash((path) => (path === metaPath('foo.7z') ? new Error('EPERM') : undefined));

    const outcome = await deleteDownloads(access, [file], trash);

    expect(outcome).toEqual({ landed: [{ name: 'foo.7z', metaLeftBehind: 'EPERM' }], refused: [] });
    expect(trashed).toEqual([file.path, metaPath('foo.7z')]);
  });

  it('hands the Instance adapter the metadata by the file\'s name, not a path the command joins itself', async () => {
    const file = await writeArchive('foo.7z');
    const asked: string[] = [];
    const counted: DownloadsAccess = {
      ...access,
      adapter: {
        ...access.adapter,
        trashDownloadedFileMeta: (name, trash) => {
          asked.push(name);
          return access.adapter.trashDownloadedFileMeta(name, trash);
        },
      },
    };

    await deleteDownloads(counted, [file], recordingTrash().trash);

    expect(asked).toEqual(['foo.7z']);
  });
});
