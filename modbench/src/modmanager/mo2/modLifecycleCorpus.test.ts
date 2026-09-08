// Uninstall is a multi-file writer, so the composition risk is at its seams: one leg
// succeeding while silently touching something it should not.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { Mo2ModlistSource } from './Mo2ModlistSource';
import { assertOnlyChanged, cloneCorpusFixture, DEFAULT_MODLIST as MODLIST, snapshotTree } from '../test/corpusFixture';

describe('mod lifecycle corpus (uninstall)', () => {
  let dir: string;
  let src: Mo2ModlistSource;

  beforeEach(async () => {
    dir = await cloneCorpusFixture();
    src = new Mo2ModlistSource(dir);
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  // "Unofficial Fallout 4 Patch"'s meta.ini names a real archive under downloads/
  // (installationFile=...) — removeMod's downstream writeback must land on exactly
  // that archive's .meta and nowhere else.
  it('removeMod deletes the folder, removes the modlist line, and marks its download uninstalled — nothing else', async () => {
    const downloadMeta = 'downloads/Unofficial Fallout 4 Patch-4598-2-1-5-1679096028.7z.meta';
    const before = await snapshotTree(dir);
    await src.removeMod('Unofficial Fallout 4 Patch');
    const after = await snapshotTree(dir);

    assertOnlyChanged(before, after, new Set(['mods/Unofficial Fallout 4 Patch/meta.ini', MODLIST, downloadMeta]));

    expect(after.has('mods/Unofficial Fallout 4 Patch/meta.ini')).toBe(false);
    expect((await src.readModlist()).some((e) => e.name === 'Unofficial Fallout 4 Patch')).toBe(false);
    const metaText = await readFile(join(dir, downloadMeta), 'utf8');
    expect(metaText).toContain('uninstalled=true');
  });

  // "Harder VATS"' meta.ini has installationFile= (blank) — nothing to writeback to.
  // The rival this catches: a writeback path that throws or writes somewhere
  // unexpected when there's no linked download, instead of skipping silently.
  it('removeMod on a mod with no linked download touches only its own folder and modlist.txt', async () => {
    const before = await snapshotTree(dir);
    await src.removeMod('Harder VATS');
    const after = await snapshotTree(dir);

    assertOnlyChanged(before, after, new Set(['mods/Harder VATS/meta.ini', MODLIST]));
    expect(after.has('mods/Harder VATS/meta.ini')).toBe(false);
  });
});
