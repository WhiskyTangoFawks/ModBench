// #41 corpus — plugins.txt mutations and profile switching against the committed
// mo2-instance-corpus fixture. As with modlistCorpus.test.ts, the point is composition:
// proving these writers touch only their own file and nothing else (not modlist.txt,
// not meta.ini, not the other profile) — pluginsText.test.ts already proves plugins.txt
// itself is byte-faithful in isolation.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { rm } from 'node:fs/promises';
import { Mo2ModlistSource } from './mo2/Mo2ModlistSource';
import { assertOnlyChanged, cloneCorpusFixture, DEFAULT_PLUGINS, snapshotTree } from './test/corpusFixture';

const INI = 'ModOrganizer.ini';

describe('plugins.txt + profile corpus', () => {
  let dir: string;
  let src: Mo2ModlistSource;

  beforeEach(async () => {
    dir = await cloneCorpusFixture();
    src = new Mo2ModlistSource(dir);
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  it('setPluginEnabled(false) touches only the active profile\'s plugins.txt', async () => {
    const before = await snapshotTree(dir);
    await src.setPluginEnabled('Tracked Patch Mod.esp', false);
    const after = await snapshotTree(dir);
    assertOnlyChanged(before, after, new Set([DEFAULT_PLUGINS]));

    expect(await src.readEnabledPlugins()).not.toContain('Tracked Patch Mod.esp');
    // Order is preserved — only the marker changed.
    expect(await src.readPluginOrder()).toContain('Tracked Patch Mod.esp');
  });

  it('reorderPlugins moves a plugin within load order, touching only plugins.txt', async () => {
    const before = await snapshotTree(dir);
    await src.reorderPlugins(['NonAsciiRetexture.esp'], 999);
    const after = await snapshotTree(dir);
    assertOnlyChanged(before, after, new Set([DEFAULT_PLUGINS]));

    const order = await src.readPluginOrder();
    expect(order.at(-1)).toBe('NonAsciiRetexture.esp');
  });

  // "NonAsciiRetexture - Addon.esl" ships on disk but was never given a plugins.txt
  // line at all (the fixture's "on disk, absent from load order" quirk) — appendPlugin
  // is the real production path that closes that gap.
  it('appendPlugin registers a disk-only plugin at the winning end, touching only plugins.txt', async () => {
    const before = await snapshotTree(dir);
    await src.appendPlugin('NonAsciiRetexture - Addon.esl');
    const after = await snapshotTree(dir);
    assertOnlyChanged(before, after, new Set([DEFAULT_PLUGINS]));

    expect(await src.readPluginOrder()).toContain('NonAsciiRetexture - Addon.esl');
    expect(await src.readEnabledPlugins()).toContain('NonAsciiRetexture - Addon.esl');
  });

  // Rival this catches: an implementation that copies or merges profile content
  // instead of repointing selected_profile — both profiles' modlist.txt/plugins.txt
  // must stay byte-identical across a switch.
  it('setActiveProfile repoints ModOrganizer.ini only, leaving every profile file untouched', async () => {
    const before = await snapshotTree(dir);
    await src.setActiveProfile('Secondary');
    const after = await snapshotTree(dir);
    assertOnlyChanged(before, after, new Set([INI]));

    expect(await src.getActiveProfile()).toBe('Secondary');
    expect((await src.readModlist()).map((e) => e.name)).toEqual([
      'Unofficial Fallout 4 Patch',
      'Harder VATS',
    ]);
  });
});
