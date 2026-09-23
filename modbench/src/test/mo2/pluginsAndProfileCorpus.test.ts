// Composition, against the committed mo2-instance-corpus fixture: proving these writers touch
// only their own file and nothing else.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { rm } from 'node:fs/promises';
import { appendPlugin, syncPlugins, reorderPlugins, setPluginEnabled } from '../../pluginsCommands/plugins';
import { switchProfile } from '../../instanceCommands/profile';
import {
  assertOnlyChanged, cloneCorpusFixture, DEFAULT_PLUGINS, providedPluginsIn, readActiveProfile,
  readModlistEntries, readPluginLines, snapshotTree,
} from './corpusFixture';

const INI = 'ModOrganizer.ini';
const PROFILE = 'Default';

const pluginOrder = async (dir: string): Promise<string[]> =>
  (await readPluginLines(dir)).map((p) => p.name);
const enabledPlugins = async (dir: string): Promise<string[]> =>
  (await readPluginLines(dir)).filter((p) => p.enabled).map((p) => p.name);

describe('plugins.txt + profile corpus', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await cloneCorpusFixture();
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  it('setPluginEnabled(false) touches only the active profile\'s plugins.txt', async () => {
    const before = await snapshotTree(dir);
    await setPluginEnabled(dir, PROFILE, 'Tracked Patch Mod.esp', false);
    const after = await snapshotTree(dir);
    assertOnlyChanged(before, after, new Set([DEFAULT_PLUGINS]));

    expect(await enabledPlugins(dir)).not.toContain('Tracked Patch Mod.esp');
    // Order is preserved — only the marker changed.
    expect(await pluginOrder(dir)).toContain('Tracked Patch Mod.esp');
  });

  it('syncPlugins converges the fixture on disk, touching only plugins.txt', async () => {
    const before = await snapshotTree(dir);
    const result = await syncPlugins(
      dir, PROFILE, await providedPluginsIn(dir), { kind: 'unresolved' }, () => Promise.resolve([]), () => {});
    const after = await snapshotTree(dir);
    assertOnlyChanged(before, after, new Set([DEFAULT_PLUGINS]));

    // The fixture ships this plugin on disk with no plugins.txt line; an unresolved game
    // directory makes Data-folder presence unknowable, so nothing is pruned.
    expect(result).toEqual({ applied: true, wrote: true, append: ['NonAsciiRetexture - Addon.esl'], prune: [] });
    expect((await pluginOrder(dir)).at(-1)).toBe('NonAsciiRetexture - Addon.esl');
    expect(await enabledPlugins(dir)).not.toContain('NonAsciiRetexture - Addon.esl');
  });

  it('reorderPlugins moves a plugin within load order, touching only plugins.txt', async () => {
    const before = await snapshotTree(dir);
    await reorderPlugins(dir, PROFILE, ['NonAsciiRetexture.esp'], { kind: 'losingEnd' });
    const after = await snapshotTree(dir);
    assertOnlyChanged(before, after, new Set([DEFAULT_PLUGINS]));

    expect((await pluginOrder(dir)).at(-1)).toBe('NonAsciiRetexture.esp');
  });

  // "NonAsciiRetexture - Addon.esl" ships on disk but was never given a plugins.txt
  // line at all (the fixture's "on disk, absent from load order" quirk) — appendPlugin
  // is the real production path that closes that gap.
  it('appendPlugin registers a disk-only plugin at the winning end, touching only plugins.txt', async () => {
    const before = await snapshotTree(dir);
    await appendPlugin(dir, PROFILE, 'NonAsciiRetexture - Addon.esl');
    const after = await snapshotTree(dir);
    assertOnlyChanged(before, after, new Set([DEFAULT_PLUGINS]));

    expect(await pluginOrder(dir)).toContain('NonAsciiRetexture - Addon.esl');
    expect(await enabledPlugins(dir)).toContain('NonAsciiRetexture - Addon.esl');
  });

  // Rival this catches: an implementation that copies or merges profile content
  // instead of repointing selected_profile — both profiles' modlist.txt/plugins.txt
  // must stay byte-identical across a switch.
  it('switchProfile repoints ModOrganizer.ini only, leaving every profile file untouched', async () => {
    const before = await snapshotTree(dir);
    await switchProfile(dir, 'Secondary', ['Default', 'Secondary']);
    const after = await snapshotTree(dir);
    assertOnlyChanged(before, after, new Set([INI]));

    expect(await readActiveProfile(dir)).toBe('Secondary');
    expect((await readModlistEntries(dir, 'Secondary')).map((e) => e.name)).toEqual([
      'Unofficial Fallout 4 Patch',
      'Harder VATS',
    ]);
  });
});
