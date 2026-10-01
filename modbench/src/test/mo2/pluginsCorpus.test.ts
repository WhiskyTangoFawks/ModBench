// Composition, against the committed mo2-instance-corpus fixture: proving these writers touch
// only their own file and nothing else.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { fakeVscodeModule } from './fakeVscodeWatcher';

vi.mock('vscode', () => fakeVscodeModule());

import { rm } from 'node:fs/promises';
import { syncPlugins, reorderPlugins, setPluginsEnabled, setPluginsParticipation } from '../../pluginsCommands/plugins';
import type { DataFolderPlugins } from '../../instanceLoader/loadOrderSnapshot';
import {
  assertOnlyChanged, cloneCorpusFixture, DEFAULT_PLUGINS, snapshotTree,
} from './corpusFixture';
import { accessTo, providedPluginsIn, readPluginLines } from './adapterOver';

const PROFILE = 'Default';
// The fixture has no game folder, so its Creation Club plugin stands in the game's Data folder,
// case-folded as the Instance lists it.
const GAME_DATA: DataFolderPlugins = { kind: 'listed', names: new Set(['ccsbjfo4003-grenade.esl']) };

const pluginOrder = async (dir: string): Promise<string[]> =>
  (await readPluginLines(dir)).map((p) => p.name);
const enabledPlugins = async (dir: string): Promise<string[]> =>
  (await readPluginLines(dir)).filter((p) => p.enabled).map((p) => p.name);

describe('plugins.txt corpus', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await cloneCorpusFixture();
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  // commands.md, "A selection is one gesture": several plugins flip in the one splice this
  // touches, not one write per plugin.
  it('setPluginsEnabled(false) flips several lines in one write, touching only the active profile\'s plugins.txt', async () => {
    const before = await snapshotTree(dir);
    const result = await setPluginsEnabled(accessTo(dir), PROFILE, ['Tracked Patch Mod.esp', 'Unofficial Fallout 4 Patch.esp'], false);
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
    const result = await setPluginsParticipation(accessTo(dir), PROFILE, [
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
      accessTo(dir), PROFILE, await providedPluginsIn(dir), GAME_DATA, []);
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
    await reorderPlugins(accessTo(dir), PROFILE, ['NonAsciiRetexture.esp'], { kind: 'winningEnd' });
    const after = await snapshotTree(dir);
    assertOnlyChanged(before, after, new Set([DEFAULT_PLUGINS]));

    expect((await pluginOrder(dir)).at(-1)).toBe('NonAsciiRetexture.esp');
  });
});
