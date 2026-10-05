import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { fakeVscodeModule } from '../../test/mo2/fakeVscodeWatcher';

vi.mock('vscode', () => fakeVscodeModule());

import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  deleteDownloads, excludeDownload, excludeDownloads, includeDownload, includeDownloads, type DownloadsAccess,
} from '../downloads';
import { assertOnlyChanged, cloneCorpusFixture, snapshotTree } from '../../test/mo2/corpusFixture';
import { accessTo, readDownloadedFileMeta } from '../../test/mo2/adapterOver';
import { assertSelectionOutcome } from '../../test/surfacingDoubles';

const NAME = 'Unofficial Fallout 4 Patch-4598-2-1-5-1679096028.7z';
const ARCHIVE = `downloads/${NAME}`;
const META = `${ARCHIVE}.meta`;

const MANUAL = 'Manually Dropped Archive.7z';
const MANUAL_ARCHIVE = `downloads/${MANUAL}`;
const MANUAL_META = `${MANUAL_ARCHIVE}.meta`;

const LOCKED = 'Locked Archive.7z';
const LOCKED_ARCHIVE = `downloads/${LOCKED}`;

describe('downloads commands over the committed corpus fixture, since these verbs mutate MO2-owned state', () => {
  let dir: string;
  let access: DownloadsAccess;

  beforeEach(async () => {
    dir = cloneCorpusFixture();
    access = accessTo(dir);
    await writeFile(join(dir, MANUAL_ARCHIVE), 'archive bytes');
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  const excludedOrFalseWithNoMetadata =async (name: string): Promise<boolean> => (await readDownloadedFileMeta(dir, name))?.excluded ?? false;

  const fileOf = (name: string) => ({ name, path: join(dir, 'downloads', name) });

  it('exclude writes one sidecar and nothing else, and the row reads back excluded', async () => {
    const before = await snapshotTree(dir);

    expect(await excludeDownload(access, NAME)).toEqual({ applied: true, wrote: true });

    assertOnlyChanged(before, await snapshotTree(dir), new Set([META]));
    expect((await excludedOrFalseWithNoMetadata(NAME))).toBe(true);
  });

  it('excluding a metaless archive creates its sidecar and nothing else', async () => {
    const before = await snapshotTree(dir);

    expect(await excludeDownload(access, MANUAL)).toEqual({ applied: true, wrote: true });

    assertOnlyChanged(before, await snapshotTree(dir), new Set([MANUAL_META]));
    expect((await excludedOrFalseWithNoMetadata(MANUAL))).toBe(true);
  });

  it('include writes one sidecar and nothing else, and the row reads back visible', async () => {
    await excludeDownload(access, NAME);
    const before = await snapshotTree(dir);

    expect(await includeDownload(access, NAME)).toEqual({ applied: true, wrote: true });

    assertOnlyChanged(before, await snapshotTree(dir), new Set([META]));
    expect((await excludedOrFalseWithNoMetadata(NAME))).toBe(false);
  });

  it('including a metaless archive touches nothing — visible is already its default', async () => {
    const before = await snapshotTree(dir);

    expect(await includeDownload(access, MANUAL)).toEqual({ applied: true, wrote: false });

    assertOnlyChanged(before, await snapshotTree(dir), new Set());
    expect((await excludedOrFalseWithNoMetadata(MANUAL))).toBe(false);
  });

  it('excluding an already excluded download touches nothing', async () => {
    await excludeDownload(access, NAME);
    const before = await snapshotTree(dir);

    expect(await excludeDownload(access, NAME)).toEqual({ applied: true, wrote: false });

    assertOnlyChanged(before, await snapshotTree(dir), new Set());
  });

  it('including an already included download touches nothing, with a real removed=false key on disk', async () => {
    await excludeDownload(access, NAME);
    await includeDownload(access, NAME);
    const before = await snapshotTree(dir);

    expect(await includeDownload(access, NAME)).toEqual({ applied: true, wrote: false });

    assertOnlyChanged(before, await snapshotTree(dir), new Set());
  });

  it('excludeDownloads excludes every landing name and refuses the one gone from disk, by name', async () => {
    const before = await snapshotTree(dir);

    const outcome = await excludeDownloads(access, [NAME, 'Gone Archive.7z', MANUAL]);

    assertSelectionOutcome(outcome, {
      landed: [NAME, MANUAL],
      refused: [{ item: 'Gone Archive.7z', reasonContains: 'Gone Archive.7z' }],
    });
    assertOnlyChanged(before, await snapshotTree(dir), new Set([META, MANUAL_META]));
    expect((await excludedOrFalseWithNoMetadata(NAME))).toBe(true);
    expect((await excludedOrFalseWithNoMetadata(MANUAL))).toBe(true);
  });

  it('includeDownloads includes every landing name and refuses the one gone from disk, by name', async () => {
    await excludeDownload(access, NAME);
    await excludeDownload(access, MANUAL);
    const before = await snapshotTree(dir);

    const outcome = await includeDownloads(access, [NAME, 'Gone Archive.7z', MANUAL]);

    assertSelectionOutcome(outcome, {
      landed: [NAME, MANUAL],
      refused: [{ item: 'Gone Archive.7z', reasonContains: 'Gone Archive.7z' }],
    });
    assertOnlyChanged(before, await snapshotTree(dir), new Set([META, MANUAL_META]));
    expect((await excludedOrFalseWithNoMetadata(NAME))).toBe(false);
    expect((await excludedOrFalseWithNoMetadata(MANUAL))).toBe(false);
  });

  it('a sidecar hidden by MO2 itself reads back excluded', async () => {
    await writeFile(join(dir, MANUAL_META), '[General]\r\nremoved=true\r\n');

    expect((await excludedOrFalseWithNoMetadata(MANUAL))).toBe(true);
  });

  it('delete trashes the archive and then the sidecar, and nothing else', async () => {
    const before = await snapshotTree(dir);
    const trashed: string[] = [];

    const outcome = await deleteDownloads(access, [fileOf(NAME)], async (path) => {
      trashed.push(path);
      await rm(path);
    });

    expect(outcome).toEqual({ landed: [{ name: NAME }], refused: [] });
    const after = await snapshotTree(dir);
    assertOnlyChanged(before, after, new Set([ARCHIVE, META]));
    expect(after.has(ARCHIVE)).toBe(false);
    expect(after.has(META)).toBe(false);
    expect(trashed).toEqual([join(dir, ARCHIVE), join(dir, META)]);
  });

  it('a trash failure on the archive leaves the archive and its sidecar in place, and refuses', async () => {
    const before = await snapshotTree(dir);

    const outcome = await deleteDownloads(access, [fileOf(NAME)], async (path) => {
      if (path === join(dir, ARCHIVE)) throw new Error('disk full');
      await rm(path);
    });

    expect(outcome).toEqual({ landed: [], refused: [{ item: { name: NAME }, reason: 'disk full' }] });
    const after = await snapshotTree(dir);
    assertOnlyChanged(before, after, new Set());
    expect(after.has(ARCHIVE)).toBe(true);
    expect(after.has(META)).toBe(true);
  });

  it('a trash failure on the sidecar after the archive landed reports the delete as done, not a refusal', async () => {
    const before = await snapshotTree(dir);

    const outcome = await deleteDownloads(access, [fileOf(NAME)], async (path) => {
      if (path === join(dir, META)) throw new Error('disk full');
      await rm(path);
    });

    expect(outcome).toEqual({ landed: [{ name: NAME, metadataLeftBehind: 'disk full' }], refused: [] });
    const after = await snapshotTree(dir);
    assertOnlyChanged(before, after, new Set([ARCHIVE]));
    expect(after.has(ARCHIVE)).toBe(false);
    expect(after.has(META)).toBe(true);
  });

  it('over a selection, a file that cannot be deleted is refused with why, writes nothing, and the rest are deleted', async () => {
    await writeFile(join(dir, LOCKED_ARCHIVE), 'archive bytes');
    const before = await snapshotTree(dir);

    const outcome = await deleteDownloads(access, [fileOf(NAME), fileOf(LOCKED), fileOf(MANUAL)], async (path) => {
      if (path === join(dir, LOCKED_ARCHIVE)) throw new Error('EPERM: operation not permitted');
      await rm(path);
    });

    expect(outcome).toEqual({
      landed: [{ name: NAME }, { name: MANUAL }],
      refused: [{ item: { name: LOCKED }, reason: 'EPERM: operation not permitted' }],
    });
    const after = await snapshotTree(dir);
    assertOnlyChanged(before, after, new Set([ARCHIVE, META, MANUAL_ARCHIVE]));
    expect([ARCHIVE, META, MANUAL_ARCHIVE].filter((path) => after.has(path))).toEqual([]);
  });
});
