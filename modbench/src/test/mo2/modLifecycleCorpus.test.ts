// Uninstall is a multi-file writer, so the composition risk is at its seams: one leg
// succeeding while silently touching something it should not.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { uninstallMods } from '../../modlist/modlist';
import {
  assertOnlyChanged, cloneCorpusFixture, DEFAULT_MODLIST as MODLIST, readModlistEntries, snapshotTree,
} from './corpusFixture';

const PROFILE = 'Default';

// The system trash, as the Ports hand it in: the path leaves mods/.
const trash = async (path: string): Promise<void> => { await rm(path, { recursive: true }); };

describe('mod lifecycle corpus (uninstall)', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await cloneCorpusFixture();
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  // The archive the value's row names, as the Mods tree hands it in — uninstallMods' downstream
  // writeback must land on exactly that archive's .meta and nowhere else.
  const ARCHIVE = 'Unofficial Fallout 4 Patch-4598-2-1-5-1679096028.7z';

  it('uninstallMods trashes the folder, removes the modlist line, and marks its download uninstalled — nothing else', async () => {
    const downloadMeta = `downloads/${ARCHIVE}.meta`;
    const before = await snapshotTree(dir);
    await uninstallMods(dir, PROFILE, [{ name: 'Unofficial Fallout 4 Patch', archiveFilename: ARCHIVE }], trash);
    const after = await snapshotTree(dir);

    assertOnlyChanged(before, after, new Set(['mods/Unofficial Fallout 4 Patch/meta.ini', MODLIST, downloadMeta]));

    expect(after.has('mods/Unofficial Fallout 4 Patch/meta.ini')).toBe(false);
    expect((await readModlistEntries(dir)).some((e) => e.name === 'Unofficial Fallout 4 Patch')).toBe(false);
    const metaText = await readFile(join(dir, downloadMeta), 'utf8');
    expect(metaText).toContain('uninstalled=true');
  });

  // The rival this catches: uninstall reading the mod's meta.ini for the archive instead of
  // taking the one the value's row names, which would mark a download nobody named.
  it('uninstallMods marks no download when none is handed in, though the mod\'s meta.ini names one', async () => {
    const downloadMeta = `downloads/${ARCHIVE}.meta`;
    const before = await snapshotTree(dir);
    await uninstallMods(dir, PROFILE, [{ name: 'Unofficial Fallout 4 Patch' }], trash);
    const after = await snapshotTree(dir);

    assertOnlyChanged(before, after, new Set(['mods/Unofficial Fallout 4 Patch/meta.ini', MODLIST]));
    expect(after.get(downloadMeta)).toEqual(before.get(downloadMeta));
  });

  // "Harder VATS"' row names no download. The rival this catches: a writeback path that throws
  // or writes somewhere unexpected with none named, instead of skipping silently.
  it('uninstallMods on a mod with no linked download touches only its own folder and modlist.txt', async () => {
    const before = await snapshotTree(dir);
    await uninstallMods(dir, PROFILE, [{ name: 'Harder VATS' }], trash);
    const after = await snapshotTree(dir);

    assertOnlyChanged(before, after, new Set(['mods/Harder VATS/meta.ini', MODLIST]));
    expect(after.has('mods/Harder VATS/meta.ini')).toBe(false);
  });
});
