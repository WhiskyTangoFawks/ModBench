import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { fakeVscodeModule } from '../../test/mo2/fakeVscodeWatcher';

vi.mock('vscode', () => fakeVscodeModule());

import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { downloadedFileCommands } from '../downloads';
import { assertOnlyChanged, cloneCorpusFixture, snapshotTree } from '../../test/mo2/corpusFixture';
import { adapterOver, readDownloadedFile } from '../../test/mo2/adapterOver';
import { assertSelectionOutcome } from '../../test/surfacingDoubles';

const NAME = 'Unofficial Fallout 4 Patch-4598-2-1-5-1679096028.7z';
const DOWNLOADED_FILE_NAME = `downloads/${NAME}`;
const META = `${DOWNLOADED_FILE_NAME}.meta`;

describe('downloaded file commands over the committed corpus fixture: one path each from the command through the real adapter to disk', () => {
  let dir: string;

  beforeEach(() => { dir = cloneCorpusFixture(); });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  it('exclude writes one metadata file and nothing else, and the row reads back excluded', async () => {
    const before = await snapshotTree(dir);

    assertSelectionOutcome(await downloadedFileCommands(adapterOver(dir)).excludeDownloadedFiles([NAME]), { landed: [NAME], refused: [] });

    assertOnlyChanged(before, await snapshotTree(dir), new Set([META]));
    expect((await readDownloadedFile(dir, NAME))?.excluded).toBe(true);
  });

  it('include writes one metadata file and nothing else, and the row reads back included', async () => {
    assertSelectionOutcome(await downloadedFileCommands(adapterOver(dir)).excludeDownloadedFiles([NAME]), { landed: [NAME], refused: [] });
    const before = await snapshotTree(dir);

    assertSelectionOutcome(await downloadedFileCommands(adapterOver(dir)).includeDownloadedFiles([NAME]), { landed: [NAME], refused: [] });

    assertOnlyChanged(before, await snapshotTree(dir), new Set([META]));
    expect((await readDownloadedFile(dir, NAME))?.excluded).toBe(false);
  });

  it('delete trashes the downloaded file and then the metadata file, and nothing else', async () => {
    const before = await snapshotTree(dir);
    const trashed: string[] = [];

    const outcome = await downloadedFileCommands(adapterOver(dir)).deleteDownloadedFiles([NAME], async (path) => {
      trashed.push(path);
      await rm(path);
    });

    expect(outcome).toEqual({ landed: [{ name: NAME }], refused: [] });
    assertOnlyChanged(before, await snapshotTree(dir), new Set([DOWNLOADED_FILE_NAME, META]));
    expect(trashed).toEqual([join(dir, DOWNLOADED_FILE_NAME), join(dir, META)]);
  });
});
