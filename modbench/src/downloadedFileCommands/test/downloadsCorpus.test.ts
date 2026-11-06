import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { fakeVscodeModule } from '../../test/mo2/fakeVscodeWatcher';

vi.mock('vscode', () => fakeVscodeModule());

import { readFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { downloadedFileCommands } from '../downloads';
import { heldTexts } from '../../symbolNames/symbolNames';
import { assertOnlyChanged, cloneCorpusFixture, snapshotTree } from '../../test/mo2/corpusFixture';
import { adapterOver, readDownloadedFile } from '../../test/mo2/adapterOver';

const NAME = 'Unofficial Fallout 4 Patch-4598-2-1-5-1679096028.7z';

describe('downloaded file commands over the committed corpus fixture: one path each from the command through the real adapter to disk', () => {
  let dir: string;

  beforeEach(() => { dir = cloneCorpusFixture(); });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  it('exclude lands, and the row reads back excluded', async () => {
    const outcome = await downloadedFileCommands(adapterOver(dir)).excludeDownloadedFiles([NAME]);

    expect({ outcome, excluded: (await readDownloadedFile(dir, NAME))?.excluded }).toEqual({ outcome: { landed: [NAME], refused: [] }, excluded: true });
  });

  it('include lands, and the excluded row reads back included', async () => {
    await downloadedFileCommands(adapterOver(dir)).excludeDownloadedFiles([NAME]);

    const outcome = await downloadedFileCommands(adapterOver(dir)).includeDownloadedFiles([NAME]);

    expect({ outcome, excluded: (await readDownloadedFile(dir, NAME))?.excluded }).toEqual({ outcome: { landed: [NAME], refused: [] }, excluded: false });
  });

  it('delete lands, and the row is gone', async () => {
    const outcome = await downloadedFileCommands(adapterOver(dir)).deleteDownloadedFiles([NAME], (path) => rm(path));

    expect({ outcome, row: await readDownloadedFile(dir, NAME) }).toEqual({ outcome: { landed: [{ name: NAME }], refused: [] }, row: undefined });
  });

  it('rename, once another program has renamed the file, moves its metadata and follows in the meta.ini of the mod installed from it, and nothing else', async () => {
    const meta = 'mods/Unofficial Fallout 4 Patch/meta.ini';
    await rename(join(dir, 'downloads', NAME), join(dir, 'downloads', 'UFO4P.7z'));
    const before = await snapshotTree(dir);

    const outcome = await downloadedFileCommands(adapterOver(dir)).renameDownloadedFile({ held: heldTexts([]), apply: () => Promise.resolve(undefined) }, NAME, 'UFO4P.7z');

    assertOnlyChanged(before, await snapshotTree(dir), new Set([`downloads/${NAME}.meta`, 'downloads/UFO4P.7z.meta', meta]));
    expect({ outcome, followed: (await readFile(join(dir, meta), 'utf8')).includes('installationFile=UFO4P.7z') }).toEqual({ outcome: { applied: true, cannotFollow: [] }, followed: true });
  });
});
