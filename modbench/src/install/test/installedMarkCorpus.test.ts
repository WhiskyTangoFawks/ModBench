import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { fakeVscodeModule } from '../../test/mo2/fakeVscodeWatcher';

vi.mock('vscode', () => fakeVscodeModule());

import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { markDownloadInstalled } from '../installedMark';
import { assertOnlyChanged, cloneCorpusFixture, snapshotTree } from '../../test/mo2/corpusFixture';
import { adapterOver, readDownloadedFileMeta } from '../../test/mo2/adapterOver';

const MANUAL = 'Manually Dropped Archive.7z';
const MANUAL_ARCHIVE = `downloads/${MANUAL}`;
const MANUAL_META = `${MANUAL_ARCHIVE}.meta`;

describe('installed mark on the committed corpus fixture, as the mark mutates MO2-owned state: the `.meta` sidecar and nothing else in the instance', () => {
  let dir: string;

  beforeEach(async () => {
    dir = cloneCorpusFixture();
    await writeFile(join(dir, MANUAL_ARCHIVE), 'archive bytes');
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  const statusOf = async (name: string) => (await readDownloadedFileMeta(dir, name))?.status;

  it('mark installed writes one sidecar and nothing else, clearing the `uninstalled` key MO2 left after an uninstall as its own markInstalled does — never the mod folder', async () => {
    await writeFile(join(dir, MANUAL_META), '[General]\r\nuninstalled=true\r\n');
    const before = await snapshotTree(dir);

    expect(await markDownloadInstalled(adapterOver(dir), MANUAL)).toEqual({ applied: true });

    assertOnlyChanged(before, await snapshotTree(dir), new Set([MANUAL_META]));
    expect(await statusOf(MANUAL)).toBe('Installed');
  });
});
