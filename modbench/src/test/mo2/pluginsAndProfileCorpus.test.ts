// Composition, against the committed mo2-instance-corpus fixture: proving these writers touch
// only their own file and nothing else.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { rm } from 'node:fs/promises';
import { appendPlugin, syncPlugins, reorderPlugins, setPluginsEnabled, setPluginsParticipation } from '../../pluginsCommands/plugins';
import { switchProfile } from '../../instanceCommands/profile';
import type { DataFolderPlugins } from '../../instanceLoader/loadOrderSnapshot';
import {
  assertOnlyChanged, cloneCorpusFixture, DEFAULT_PLUGINS, providedPluginsIn, readActiveProfile,
  readModlistEntries, readPluginLines, snapshotTree,
} from './corpusFixture';

const INI = 'ModOrganizer.ini';
const PROFILE = 'Default';
// The fixture has no game folder, so its Creation Club plugin stands in the game's Data folder,
// case-folded as the Instance lists it.
const GAME_DATA: DataFolderPlugins = { kind: 'listed', names: new Set(['ccsbjfo4003-grenade.esl']) };

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

  // commands.md, "A selection is one gesture": several plugins flip in the one splice this
  // touches, not one write per plugin.
  it('setPluginsEnabled(false) flips several lines in one write, touching only the active profile\'s plugins.txt', async () => {
    const before = await snapshotTree(dir);
    const result = await setPluginsEnabled(dir, PROFILE, ['Tracked Patch Mod.esp', 'Unofficial Fallout 4 Patch.esp'], false);
    const after = await snapshotTree(dir);
    assertOnlyChanged(before, after, new Set([DEFAULT_PLUGINS]));

    expect(result).toEqual({
      applied: true,
      outcome: { landed: ['Tracked Patch Mod.esp', 'Unofficial Fallout 4 Patch.esp'], refused: [] },
    });
    const enabled = await enabledPlugins(dir);
    expect(enabled).not.toContain('Tracked Patch Mod.esp');
    expect(enabled).not.toContain('Unofficial Fallout 4 Patch.esp');
    // Order is preserved — only the markers changed.
    const order = await pluginOrder(dir);
    expect(order).toContain('Tracked Patch Mod.esp');
    expect(order).toContain('Unofficial Fallout 4 Patch.esp');
  });

  // The check box's own shape: several rows, each its own target state, still one splice.
  it('setPluginsParticipation flips a mixed selection in one write, touching only plugins.txt', async () => {
    const before = await snapshotTree(dir);
    const result = await setPluginsParticipation(dir, PROFILE, [
      { name: 'Tracked Patch Mod.esp', enabled: false },
      { name: 'NonAsciiRetexture.esp', enabled: true },
    ]);
    const after = await snapshotTree(dir);
    assertOnlyChanged(before, after, new Set([DEFAULT_PLUGINS]));

    expect(result).toEqual({
      applied: true,
      outcome: { landed: ['Tracked Patch Mod.esp', 'NonAsciiRetexture.esp'], refused: [] },
    });
    const enabled = await enabledPlugins(dir);
    expect(enabled).not.toContain('Tracked Patch Mod.esp');
    expect(enabled).toContain('NonAsciiRetexture.esp');
  });

  it('syncPlugins converges the fixture on disk, touching only plugins.txt', async () => {
    const before = await snapshotTree(dir);
    const result = await syncPlugins(
      dir, PROFILE, await providedPluginsIn(dir), GAME_DATA, () => Promise.resolve([]));
    const after = await snapshotTree(dir);
    assertOnlyChanged(before, after, new Set([DEFAULT_PLUGINS]));

    // The fixture ships the add-on on disk with no plugins.txt line, and lists the patch that no
    // enabled mod provides. The Creation Club line is the game's own, so it stays.
    expect(result).toEqual({
      applied: true, wrote: true, added: ['NonAsciiRetexture - Addon.esl'], dropped: ['Unofficial Fallout 4 Patch.esp'],
    });
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
