// Corpus test: deleteDownload against the committed mo2-instance-corpus fixture.
// deleteDownload() mutates MO2-owned state (downloads/*.meta and the archive
// itself) via injected deps, purpose-built for exactly this kind of
// unit-testability (see deleteDownload.ts's own module comment).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { deleteDownload } from './deleteDownload';
import { assertOnlyChanged, cloneCorpusFixture, snapshotTree } from './test/corpusFixture';

const ARCHIVE = 'downloads/Unofficial Fallout 4 Patch-4598-2-1-5-1679096028.7z';
const META = `${ARCHIVE}.meta`;

describe('deleteDownload corpus', () => {
  let dir: string;
  let archivePath: string;
  let metaPath: string;

  beforeEach(async () => {
    dir = await cloneCorpusFixture();
    archivePath = join(dir, ARCHIVE);
    metaPath = join(dir, META);
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  it('trashes the archive and its .meta sidecar, touching nothing else', async () => {
    const before = await snapshotTree(dir);
    const trashed: string[] = [];
    await deleteDownload({
      archivePath,
      metaPath,
      confirm: () => Promise.resolve(true),
      metaExists: () => Promise.resolve(true),
      trash: async (p) => {
        trashed.push(p);
        await rm(p, { force: true });
      },
      reportFailure: () => {
        throw new Error('should not be called');
      },
    });
    const after = await snapshotTree(dir);

    assertOnlyChanged(before, after, new Set([ARCHIVE, META]));
    expect(after.has(ARCHIVE)).toBe(false);
    expect(after.has(META)).toBe(false);
    // .meta trashed before the archive (deleteDownload.ts's own ordering guarantee).
    expect(trashed).toEqual([metaPath, archivePath]);
  });

  it('a cancelled confirmation is a byte-identical no-op over the whole instance', async () => {
    const before = await snapshotTree(dir);
    await deleteDownload({
      archivePath,
      metaPath,
      confirm: () => Promise.resolve(false),
      metaExists: () => Promise.resolve(true),
      trash: () => {
        throw new Error('should not be called');
      },
      reportFailure: () => {
        throw new Error('should not be called');
      },
    });
    const after = await snapshotTree(dir);
    assertOnlyChanged(before, after, new Set());
  });

  // Rival this catches: trashing the archive before the .meta (the reverse order)
  // would leave a lone `.meta` on a mid-failure — deleteDownload.ts's own comment
  // calls this out as the failure mode it exists to avoid.
  it('a trash failure on the archive leaves the .meta already gone but the archive intact, and reports the failure', async () => {
    const before = await snapshotTree(dir);
    const report = vi.fn();
    await deleteDownload({
      archivePath,
      metaPath,
      confirm: () => Promise.resolve(true),
      metaExists: () => Promise.resolve(true),
      trash: async (p) => {
        if (p === archivePath) throw new Error('disk full');
        await rm(p, { force: true });
      },
      reportFailure: report,
    });
    const after = await snapshotTree(dir);

    assertOnlyChanged(before, after, new Set([META]));
    expect(after.has(META)).toBe(false);
    expect(after.has(ARCHIVE)).toBe(true);
    expect(report).toHaveBeenCalledWith('disk full');
  });
});
