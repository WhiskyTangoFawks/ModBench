// #41 corpus — mod lifecycle (install/uninstall) against the committed
// mo2-instance-corpus fixture. These are the multi-file writers: install copies a
// source tree AND writes meta.ini AND inserts a modlist line; uninstall deletes a
// folder AND removes a modlist line AND writes back to an unrelated download's
// .meta sidecar. The composition risk is exactly at those seams — one leg
// succeeding while silently touching something it shouldn't.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Mo2ModlistSource } from './mo2/Mo2ModlistSource';
import { assertOnlyChanged, cloneCorpusFixture, snapshotTree } from './test/corpusFixture';
import type { Mod } from './model';

const MODLIST = 'profiles/Default/modlist.txt';

describe('mod lifecycle corpus (install / uninstall)', () => {
  let dir: string;
  let src: Mo2ModlistSource;

  beforeEach(async () => {
    dir = await cloneCorpusFixture();
    src = new Mo2ModlistSource(dir);
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  it('installMod copies the source tree, writes meta.ini, and inserts one modlist line — nothing else', async () => {
    const sourceDir = await mkdtemp(join(tmpdir(), 'medit-install-source-'));
    try {
      await writeFile(join(sourceDir, 'Installed.esp'), 'placeholder plugin bytes: Installed.esp');
      await mkdir(join(sourceDir, 'textures'), { recursive: true });
      await writeFile(join(sourceDir, 'textures', 'added.dds'), 'placeholder texture bytes');

      const before = await snapshotTree(dir);
      await src.installMod('Freshly Installed Mod', sourceDir, { modid: '1234', version: '1.0.0' });
      const after = await snapshotTree(dir);

      assertOnlyChanged(
        before,
        after,
        new Set([
          MODLIST,
          'mods/Freshly Installed Mod/Installed.esp',
          'mods/Freshly Installed Mod/textures/added.dds',
          'mods/Freshly Installed Mod/meta.ini',
        ]),
      );

      // Copied content is exact — an independent byte comparison against the source,
      // not a re-derivation of what the writer just did.
      expect(after.get('mods/Freshly Installed Mod/Installed.esp')?.toString('utf8')).toBe(
        'placeholder plugin bytes: Installed.esp',
      );
      expect(after.get('mods/Freshly Installed Mod/textures/added.dds')?.toString('utf8')).toBe(
        'placeholder texture bytes',
      );

      const entries = await src.readModlist();
      expect(entries[0].name).toBe('Freshly Installed Mod'); // winning end
      expect((entries[0] as Mod).enabled).toBe(false); // installed disabled, per IModlistSource contract
    } finally {
      await rm(sourceDir, { recursive: true, force: true });
    }
  });

  it('installMod rejects a name collision, touching nothing', async () => {
    const sourceDir = await mkdtemp(join(tmpdir(), 'medit-install-source-'));
    try {
      const before = await snapshotTree(dir);
      await expect(src.installMod('Harder VATS', sourceDir, {})).rejects.toThrow();
      const after = await snapshotTree(dir);
      assertOnlyChanged(before, after, new Set());
    } finally {
      await rm(sourceDir, { recursive: true, force: true });
    }
  });

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
