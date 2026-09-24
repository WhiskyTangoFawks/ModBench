// Runs against the committed corpus fixture, because the mark mutates MO2-owned state: the
// `.meta` sidecar and nothing else in the instance.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { markDownloadInstalled } from '../installedMark';
import { parseDownloadMeta } from '../../mo2Codecs/downloads';
import { assertOnlyChanged, cloneCorpusFixture, snapshotTree } from '../../test/mo2/corpusFixture';

// A metaless archive, as a manual drop into downloads/ is: a mark that creates a sidecar is the
// one whose touch-set is easiest to read wrong.
const MANUAL = 'Manually Dropped Archive.7z';
const MANUAL_ARCHIVE = `downloads/${MANUAL}`;
const MANUAL_META = `${MANUAL_ARCHIVE}.meta`;

describe('installed mark corpus', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await cloneCorpusFixture();
    await writeFile(join(dir, MANUAL_ARCHIVE), 'archive bytes');
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  const sidecarOf = async (path: string) => parseDownloadMeta(await readFile(join(dir, path), 'utf8'));

  it('mark installed writes one sidecar and nothing else — never the mod folder', async () => {
    // As MO2 left it after an uninstall: its tab resolves `uninstalled` first, so the mark has
    // to clear that key too, exactly as MO2's own markInstalled does.
    await writeFile(join(dir, MANUAL_META), '[General]\r\nuninstalled=true\r\n');
    const before = await snapshotTree(dir);

    expect(await markDownloadInstalled(join(dir, 'downloads'), MANUAL)).toEqual({ applied: true });

    assertOnlyChanged(before, await snapshotTree(dir), new Set([MANUAL_META]));
    expect(await sidecarOf(MANUAL_META)).toMatchObject({ status: 'Installed' });
  });
});
