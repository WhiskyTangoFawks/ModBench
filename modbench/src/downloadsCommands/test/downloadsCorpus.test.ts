// Runs against the committed corpus fixture, because these verbs mutate MO2-owned state: the
// `.meta` sidecar, the archive beside it, and nothing else in the instance.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { deleteDownloads, excludeDownload, excludeDownloads, includeDownload, includeDownloads } from '../downloads';
import { scanDownloads } from '../../instanceLoader/downloadsScan';
import { buildDownloadRows, modsByInstallationFile, type DownloadRow } from '../../mo2Codecs/downloads';
import { assertOnlyChanged, cloneCorpusFixture, readModlistEntries, snapshotTree } from '../../test/mo2/corpusFixture';
import { assertSelectionOutcome } from '../../test/surfacingDoubles';

const NAME = 'Unofficial Fallout 4 Patch-4598-2-1-5-1679096028.7z';
const ARCHIVE = `downloads/${NAME}`;
const META = `${ARCHIVE}.meta`;

// A metaless archive, as a manual drop into downloads/ is: the verbs that create a sidecar are
// the ones whose touch-set is easiest to read wrong.
const MANUAL = 'Manually Dropped Archive.7z';
const MANUAL_ARCHIVE = `downloads/${MANUAL}`;
const MANUAL_META = `${MANUAL_ARCHIVE}.meta`;

const LOCKED = 'Locked Archive.7z';
const LOCKED_ARCHIVE = `downloads/${LOCKED}`;

describe('downloads commands corpus', () => {
  let dir: string;
  let downloadsDir: string;

  beforeEach(async () => {
    dir = await cloneCorpusFixture();
    downloadsDir = join(dir, 'downloads');
    await writeFile(join(dir, MANUAL_ARCHIVE), 'archive bytes');
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  // The Instance's own read of downloads/, so a test never re-derives the row it asserts on.
  async function rowFor(name: string): Promise<DownloadRow> {
    const entries = (await scanDownloads(downloadsDir)) ?? [];
    const rows = buildDownloadRows(entries, modsByInstallationFile(await readModlistEntries(dir)));
    const row = rows.find((r) => r.name === name);
    if (!row) throw new Error(`no row for ${name}`);
    return row;
  }

  it('exclude writes one sidecar and nothing else, and the row reads back hidden', async () => {
    const before = await snapshotTree(dir);

    expect(await excludeDownload(downloadsDir, NAME)).toEqual({ applied: true, wrote: true });

    assertOnlyChanged(before, await snapshotTree(dir), new Set([META]));
    expect((await rowFor(NAME)).hidden).toBe(true);
  });

  it('excluding a metaless archive creates its sidecar and nothing else', async () => {
    const before = await snapshotTree(dir);

    expect(await excludeDownload(downloadsDir, MANUAL)).toEqual({ applied: true, wrote: true });

    assertOnlyChanged(before, await snapshotTree(dir), new Set([MANUAL_META]));
    expect((await rowFor(MANUAL)).hidden).toBe(true);
  });

  it('include writes one sidecar and nothing else, and the row reads back visible', async () => {
    await excludeDownload(downloadsDir, NAME);
    const before = await snapshotTree(dir);

    expect(await includeDownload(downloadsDir, NAME)).toEqual({ applied: true, wrote: true });

    assertOnlyChanged(before, await snapshotTree(dir), new Set([META]));
    expect((await rowFor(NAME)).hidden).toBe(false);
  });

  it('including a metaless archive touches nothing — visible is already its default', async () => {
    const before = await snapshotTree(dir);

    expect(await includeDownload(downloadsDir, MANUAL)).toEqual({ applied: true, wrote: false });

    assertOnlyChanged(before, await snapshotTree(dir), new Set());
    expect((await rowFor(MANUAL)).hidden).toBe(false);
  });

  it('excluding an already excluded download touches nothing', async () => {
    await excludeDownload(downloadsDir, NAME);
    const before = await snapshotTree(dir);

    expect(await excludeDownload(downloadsDir, NAME)).toEqual({ applied: true, wrote: false });

    assertOnlyChanged(before, await snapshotTree(dir), new Set());
  });

  it('including an already included download touches nothing, with a real removed=false key on disk', async () => {
    await excludeDownload(downloadsDir, NAME); // removed=true, a real change
    await includeDownload(downloadsDir, NAME); // removed=false, a real change — the key now exists on disk
    const before = await snapshotTree(dir);

    expect(await includeDownload(downloadsDir, NAME)).toEqual({ applied: true, wrote: false });

    assertOnlyChanged(before, await snapshotTree(dir), new Set());
  });

  it('excludeDownloads excludes every landing name and refuses the one gone from disk, by name', async () => {
    const before = await snapshotTree(dir);

    const outcome = await excludeDownloads(downloadsDir, [NAME, 'Gone Archive.7z', MANUAL]);

    assertSelectionOutcome(outcome, {
      landed: [NAME, MANUAL],
      refused: [{ item: 'Gone Archive.7z', reasonContains: 'Gone Archive.7z' }],
    });
    assertOnlyChanged(before, await snapshotTree(dir), new Set([META, MANUAL_META]));
    expect((await rowFor(NAME)).hidden).toBe(true);
    expect((await rowFor(MANUAL)).hidden).toBe(true);
  });

  it('includeDownloads includes every landing name and refuses the one gone from disk, by name', async () => {
    await excludeDownload(downloadsDir, NAME);
    await excludeDownload(downloadsDir, MANUAL);
    const before = await snapshotTree(dir);

    const outcome = await includeDownloads(downloadsDir, [NAME, 'Gone Archive.7z', MANUAL]);

    assertSelectionOutcome(outcome, {
      landed: [NAME, MANUAL],
      refused: [{ item: 'Gone Archive.7z', reasonContains: 'Gone Archive.7z' }],
    });
    assertOnlyChanged(before, await snapshotTree(dir), new Set([META, MANUAL_META]));
    expect((await rowFor(NAME)).hidden).toBe(false);
    expect((await rowFor(MANUAL)).hidden).toBe(false);
  });

  // The other direction of the same key: MO2 hides a download, Modbench shows it hidden.
  it('a sidecar hidden by MO2 itself reads back hidden', async () => {
    await writeFile(join(dir, MANUAL_META), '[General]\r\nremoved=true\r\n');

    expect((await rowFor(MANUAL)).hidden).toBe(true);
  });

  it('delete trashes the archive and then the sidecar, and nothing else', async () => {
    const before = await snapshotTree(dir);
    const trashed: string[] = [];

    const outcome = await deleteDownloads(downloadsDir, [NAME], async (path) => {
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

    const outcome = await deleteDownloads(downloadsDir, [NAME], async (path) => {
      if (path === join(dir, ARCHIVE)) throw new Error('disk full');
      await rm(path);
    });

    expect(outcome).toEqual({ landed: [], refused: [{ item: { name: NAME }, reason: 'disk full' }] });
    const after = await snapshotTree(dir);
    assertOnlyChanged(before, after, new Set());
    expect(after.has(ARCHIVE)).toBe(true);
    expect(after.has(META)).toBe(true);
  });

  // The archive is already gone by the time the sidecar's trash runs, so this is not a refusal —
  // the Output line naming it is the view's job (downloads.md, Reporting story 2).
  it('a trash failure on the sidecar after the archive landed reports the delete as done', async () => {
    const before = await snapshotTree(dir);

    const outcome = await deleteDownloads(downloadsDir, [NAME], async (path) => {
      if (path === join(dir, META)) throw new Error('disk full');
      await rm(path);
    });

    expect(outcome).toEqual({ landed: [{ name: NAME, metaLeftBehind: 'disk full' }], refused: [] });
    const after = await snapshotTree(dir);
    assertOnlyChanged(before, after, new Set([ARCHIVE]));
    expect(after.has(ARCHIVE)).toBe(false);
    expect(after.has(META)).toBe(true);
  });

  it('over a selection, a file that cannot be deleted is refused with why, writes nothing, and the rest are deleted', async () => {
    await writeFile(join(dir, LOCKED_ARCHIVE), 'archive bytes');
    const before = await snapshotTree(dir);

    const outcome = await deleteDownloads(downloadsDir, [NAME, LOCKED, MANUAL], async (path) => {
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
