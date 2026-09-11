// Runs against the committed corpus fixture, because these verbs mutate MO2-owned state: the
// `.meta` sidecar, the archive beside it, and nothing else in the instance.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  deleteDownload,
  hideDownload,
  markDownloadInstalled,
  markDownloadUninstalled,
  unhideDownload,
} from './downloads';
import { scanDownloads } from '../downloadsScan';
import { buildDownloadRows, modsByInstallationFile, parseDownloadMeta, type DownloadRow } from '../mo2/downloads';
import { assertOnlyChanged, cloneCorpusFixture, readModlistEntries, snapshotTree } from '../test/corpusFixture';

const NAME = 'Unofficial Fallout 4 Patch-4598-2-1-5-1679096028.7z';
const ARCHIVE = `downloads/${NAME}`;
const META = `${ARCHIVE}.meta`;

// A metaless archive, as a manual drop into downloads/ is: the verbs that create a sidecar are
// the ones whose touch-set is easiest to read wrong.
const MANUAL = 'Manually Dropped Archive.7z';
const MANUAL_ARCHIVE = `downloads/${MANUAL}`;
const MANUAL_META = `${MANUAL_ARCHIVE}.meta`;

describe('downloads commands corpus', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await cloneCorpusFixture();
    await writeFile(join(dir, MANUAL_ARCHIVE), 'archive bytes');
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  // The Instance's own read of downloads/, so a test never re-derives the row it asserts on.
  async function rowFor(name: string): Promise<DownloadRow> {
    const entries = (await scanDownloads(dir)) ?? [];
    const rows = buildDownloadRows(entries, modsByInstallationFile(await readModlistEntries(dir)));
    const row = rows.find((r) => r.name === name);
    if (!row) throw new Error(`no row for ${name}`);
    return row;
  }

  const sidecarOf = async (path: string) => parseDownloadMeta(await readFile(join(dir, path), 'utf8'));

  it('hide writes one sidecar and nothing else, and the row reads back hidden', async () => {
    const before = await snapshotTree(dir);

    expect(await hideDownload(dir, NAME)).toEqual({ applied: true });

    assertOnlyChanged(before, await snapshotTree(dir), new Set([META]));
    expect((await rowFor(NAME)).hidden).toBe(true);
  });

  it('hiding a metaless archive creates its sidecar and nothing else', async () => {
    const before = await snapshotTree(dir);

    expect(await hideDownload(dir, MANUAL)).toEqual({ applied: true });

    assertOnlyChanged(before, await snapshotTree(dir), new Set([MANUAL_META]));
    expect((await rowFor(MANUAL)).hidden).toBe(true);
  });

  it('unhide writes one sidecar and nothing else, and the row reads back visible', async () => {
    await hideDownload(dir, NAME);
    const before = await snapshotTree(dir);

    expect(await unhideDownload(dir, NAME)).toEqual({ applied: true });

    assertOnlyChanged(before, await snapshotTree(dir), new Set([META]));
    expect((await rowFor(NAME)).hidden).toBe(false);
  });

  // The other direction of the same key: MO2 hides a download, Modbench shows it hidden.
  it('a sidecar hidden by MO2 itself reads back hidden', async () => {
    await writeFile(join(dir, MANUAL_META), '[General]\r\nremoved=true\r\n');

    expect((await rowFor(MANUAL)).hidden).toBe(true);
  });

  it('mark installed writes one sidecar and nothing else — never the mod folder', async () => {
    const before = await snapshotTree(dir);

    expect(await markDownloadInstalled(dir, MANUAL)).toEqual({ applied: true });

    assertOnlyChanged(before, await snapshotTree(dir), new Set([MANUAL_META]));
    expect(await sidecarOf(MANUAL_META)).toMatchObject({ status: 'Installed' });
  });

  it('mark uninstalled writes one sidecar and nothing else — never the mod it was installed into', async () => {
    const before = await snapshotTree(dir);

    expect(await markDownloadUninstalled(dir, NAME)).toEqual({ applied: true });

    assertOnlyChanged(before, await snapshotTree(dir), new Set([META]));
    expect(await sidecarOf(META)).toMatchObject({ status: 'Uninstalled' });
  });

  it('delete trashes the sidecar and then the archive, and nothing else', async () => {
    const before = await snapshotTree(dir);
    const trashed: string[] = [];

    const outcome = await deleteDownload(dir, NAME, async (path) => {
      trashed.push(path);
      await rm(path);
    });

    expect(outcome).toEqual({ applied: true });
    const after = await snapshotTree(dir);
    assertOnlyChanged(before, after, new Set([ARCHIVE, META]));
    expect(after.has(ARCHIVE)).toBe(false);
    expect(after.has(META)).toBe(false);
    expect(trashed).toEqual([join(dir, META), join(dir, ARCHIVE)]);
  });

  it('a trash failure on the archive leaves the sidecar gone, the archive intact, and refuses', async () => {
    const before = await snapshotTree(dir);

    const outcome = await deleteDownload(dir, NAME, async (path) => {
      if (path === join(dir, ARCHIVE)) throw new Error('disk full');
      await rm(path);
    });

    expect(outcome).toEqual({ applied: false, refusal: 'disk full' });
    const after = await snapshotTree(dir);
    assertOnlyChanged(before, after, new Set([META]));
    expect(after.has(ARCHIVE)).toBe(true);
  });
});
