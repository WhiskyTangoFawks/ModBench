// Runs against the committed corpus fixture, because the mark mutates MO2-owned state: the
// `.meta` sidecar and nothing else in the instance.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { fakeVscodeModule } from '../../test/mo2/fakeVscodeWatcher';

vi.mock('vscode', () => fakeVscodeModule());

import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { markDownloadInstalled } from '../installedMark';
import { assertOnlyChanged, cloneCorpusFixture, snapshotTree } from '../../test/mo2/corpusFixture';
import { adapterOver } from '../../test/mo2/adapterOver';

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

  const statusOf = async (name: string) => {
    const listed = await (await adapterOver(dir).settings()).downloadedFiles();
    if (listed.kind !== 'listed') throw new Error(`expected listed, got ${listed.reason}`);
    return listed.files?.find((file) => file.name === name)?.meta?.status;
  };

  it('mark installed writes one sidecar and nothing else — never the mod folder', async () => {
    // As MO2 left it after an uninstall: its tab resolves `uninstalled` first, so the mark has
    // to clear that key too, exactly as MO2's own markInstalled does.
    await writeFile(join(dir, MANUAL_META), '[General]\r\nuninstalled=true\r\n');
    const before = await snapshotTree(dir);

    expect(await markDownloadInstalled(adapterOver(dir), MANUAL)).toEqual({ applied: true });

    assertOnlyChanged(before, await snapshotTree(dir), new Set([MANUAL_META]));
    expect(await statusOf(MANUAL)).toBe('Installed');
  });
});
