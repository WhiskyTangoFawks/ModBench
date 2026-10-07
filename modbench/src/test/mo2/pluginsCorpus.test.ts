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

const NOT_INDEXED = { getPlugins: () => Promise.reject(new Error('mEdit is indexing')) };
const PROFILE = 'Default';
const GAME_DATA_FOLDER: DataFolderPlugins = { kind: 'listed', names: new Set(['ccsbjfo4003-grenade.esl']) };

const pluginOrder = async (dir: string): Promise<string[]> =>
  (await readPluginLines(dir)).map((p) => p.name);
const enabledPlugins = async (dir: string): Promise<string[]> =>
  (await readPluginLines(dir)).filter((p) => p.enabled).map((p) => p.name);

describe('plugins.txt corpus', () => {
  let dir: string;

  beforeEach(() => {
    dir = cloneCorpusFixture();
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  it('setPluginsEnabled(false) flips several lines in one write, touching only the active profile\'s plugins.txt', async () => {
    const before = await snapshotTree(dir);
    const orderBefore = await pluginOrder(dir);
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
    expect(await pluginOrder(dir)).toEqual(orderBefore);
  });

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
    const result = await syncPlugins(accessTo(dir), {
      profile: PROFILE, pluginOrder: await readPluginLines(dir), provided: await providedPluginsIn(dir), inData: GAME_DATA_FOLDER, loadedWithNoLine: [],
    });
    const after = await snapshotTree(dir);
    assertOnlyChanged(before, after, new Set([DEFAULT_PLUGINS]));

    expect(result).toEqual({
      applied: true, wrote: true, added: ['NonAsciiRetexture - Addon.esl'], dropped: ['Unofficial Fallout 4 Patch.esp'],
    });
    expect((await pluginOrder(dir)).at(-1)).toBe('NonAsciiRetexture - Addon.esl');
    expect(await enabledPlugins(dir)).not.toContain('NonAsciiRetexture - Addon.esl');
  });

  it('reorderPlugins moves a plugin within load order, touching only plugins.txt', async () => {
    const before = await snapshotTree(dir);
    await reorderPlugins(accessTo(dir), NOT_INDEXED, PROFILE, ['NonAsciiRetexture.esp'], { kind: 'winningEnd' });
    const after = await snapshotTree(dir);
    assertOnlyChanged(before, after, new Set([DEFAULT_PLUGINS]));

    expect((await pluginOrder(dir)).at(-1)).toBe('NonAsciiRetexture.esp');
  });
});
