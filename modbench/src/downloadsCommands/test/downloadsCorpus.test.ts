import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { fakeVscodeModule } from '../../test/mo2/fakeVscodeWatcher';

vi.mock('vscode', () => fakeVscodeModule());

import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { downloadsCommands } from '../downloads';
import { assertOnlyChanged, cloneCorpusFixture, snapshotTree } from '../../test/mo2/corpusFixture';
import { adapterOver, readDownloadedFileMeta } from '../../test/mo2/adapterOver';
import { assertSelectionOutcome } from '../../test/surfacingDoubles';

const NAME = 'Unofficial Fallout 4 Patch-4598-2-1-5-1679096028.7z';
const ARCHIVE = `downloads/${NAME}`;
const META = `${ARCHIVE}.meta`;

describe('downloads commands over the committed corpus fixture: one path each from the command through the real adapter to disk', () => {
  let dir: string;

  beforeEach(() => { dir = cloneCorpusFixture(); });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  it('exclude writes one sidecar and nothing else, and the row reads back excluded', async () => {
    const before = await snapshotTree(dir);

    assertSelectionOutcome(await downloadsCommands(adapterOver(dir)).excludeDownloads([NAME]), { landed: [NAME], refused: [] });

    assertOnlyChanged(before, await snapshotTree(dir), new Set([META]));
    expect((await readDownloadedFileMeta(dir, NAME))?.excluded).toBe(true);
  });

  it('include writes one sidecar and nothing else, and the row reads back included', async () => {
    assertSelectionOutcome(await downloadsCommands(adapterOver(dir)).excludeDownloads([NAME]), { landed: [NAME], refused: [] });
    const before = await snapshotTree(dir);

    assertSelectionOutcome(await downloadsCommands(adapterOver(dir)).includeDownloads([NAME]), { landed: [NAME], refused: [] });

    assertOnlyChanged(before, await snapshotTree(dir), new Set([META]));
    expect((await readDownloadedFileMeta(dir, NAME))?.excluded).toBe(false);
  });

  it('delete trashes the archive and then the sidecar, and nothing else', async () => {
    const before = await snapshotTree(dir);
    const trashed: string[] = [];

    const outcome = await downloadsCommands(adapterOver(dir)).deleteDownloads([{ name: NAME, path: join(dir, ARCHIVE) }], async (path) => {
      trashed.push(path);
      await rm(path);
    });

    expect(outcome).toEqual({ landed: [{ name: NAME }], refused: [] });
    assertOnlyChanged(before, await snapshotTree(dir), new Set([ARCHIVE, META]));
    expect(trashed).toEqual([join(dir, ARCHIVE), join(dir, META)]);
  });
});
