import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { fakeVscodeModule } from './fakeVscodeWatcher';

vi.mock('vscode', () => fakeVscodeModule());

import { appendFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pluginSyncOver, type PluginSyncRun } from '../../pluginCommands/plugins';
import {
  assertOnlyChanged, cloneCorpusFixture, DEFAULT_LOAD_ORDER, DEFAULT_PLUGINS, snapshotTree,
} from './corpusFixture';
import { adapterOver, pluginCommandsOver, readPluginLines } from './adapterOver';

const NOT_INDEXED = { getPlugins: () => Promise.reject(new Error('mEdit is indexing')) };
const moving = (...names: string[]) => names.map((name) => ({ name, origin: 'SomeMod' }));

async function syncWithGameFolderHolding(dir: string, plugin: string): Promise<PluginSyncRun> {
  const game = join(dir, 'Game');
  await mkdir(join(game, 'Data'), { recursive: true });
  await writeFile(join(game, 'Data', plugin), '');
  return pluginSyncOver(adapterOver(dir, { gameFolderSettingValue: game }), NOT_INDEXED);
}

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
    const result = await pluginCommandsOver(dir).setPluginsEnabled(['Patch Mod.esp', 'Unofficial Fallout 4 Patch.esp'], false);
    const after = await snapshotTree(dir);
    assertOnlyChanged(before, after, new Set([DEFAULT_PLUGINS, DEFAULT_LOAD_ORDER]));

    expect(result).toEqual({
      applied: true,
      outcome: { landed: ['Patch Mod.esp', 'Unofficial Fallout 4 Patch.esp'], refused: [] },
    });
    const enabled = await enabledPlugins(dir);
    expect(enabled).not.toContain('Patch Mod.esp');
    expect(enabled).not.toContain('Unofficial Fallout 4 Patch.esp');
    expect(await pluginOrder(dir)).toEqual(orderBefore);
  });

  it('setPluginsParticipation flips a mixed selection in one write, touching only plugins.txt and loadorder.txt', async () => {
    const before = await snapshotTree(dir);
    const result = await pluginCommandsOver(dir).setPluginsParticipation([
      { name: 'Patch Mod.esp', enabled: false },
      { name: 'NonAsciiRetexture.esp', enabled: true },
    ]);
    const after = await snapshotTree(dir);
    assertOnlyChanged(before, after, new Set([DEFAULT_PLUGINS, DEFAULT_LOAD_ORDER]));

    expect(result).toEqual({
      applied: true,
      outcome: { landed: ['Patch Mod.esp', 'NonAsciiRetexture.esp'], refused: [] },
    });
    const enabled = await enabledPlugins(dir);
    expect(enabled).not.toContain('Patch Mod.esp');
    expect(enabled).toContain('NonAsciiRetexture.esp');
  });

  it('loadAfter makes the userlist, touching no other file', async () => {
    const before = await snapshotTree(dir);
    const userlist = join(dir, 'userlist.yaml');

    const result = await pluginCommandsOver(dir).loadAfter(['Patch Mod.esp'], ['NonAsciiRetexture.esp']);

    assertOnlyChanged(before, await snapshotTree(dir), new Set(['userlist.yaml']));
    expect(result).toEqual({ applied: true, wrote: true });
    expect(await readFile(userlist, 'utf8')).toBe('plugins:\n  - name: Patch Mod.esp\n    after:\n      - NonAsciiRetexture.esp\n');
  });

  it('syncPlugins converges the fixture on disk, touching only plugins.txt and loadorder.txt', async () => {
    const sync = await syncWithGameFolderHolding(dir, 'ccsbjfo4003-grenade.esl');
    const before = await snapshotTree(dir);
    const result = await sync();
    const after = await snapshotTree(dir);
    assertOnlyChanged(before, after, new Set([DEFAULT_PLUGINS, DEFAULT_LOAD_ORDER]));

    expect(result).toEqual({
      applied: true, wrote: true, added: ['NonAsciiRetexture - Addon.esl'], dropped: ['Unofficial Fallout 4 Patch.esp'],
    });
    expect((await pluginOrder(dir)).at(0)).toBe('NonAsciiRetexture - Addon.esl');
    expect(await enabledPlugins(dir)).not.toContain('NonAsciiRetexture - Addon.esl');
  });

  it('syncPlugins over a plugin the file repeats syncs on the first line and drops it', async () => {
    await appendFile(join(dir, DEFAULT_PLUGINS), 'Unofficial Fallout 4 Patch.esp\r\n');
    const result = await (await syncWithGameFolderHolding(dir, 'ccsbjfo4003-grenade.esl'))();

    expect(result).toMatchObject({ applied: true, wrote: true, dropped: ['Unofficial Fallout 4 Patch.esp'] });
  });

  it('reorderPlugins moves a plugin within load order, touching only plugins.txt and loadorder.txt', async () => {
    const before = await snapshotTree(dir);
    await pluginCommandsOver(dir, NOT_INDEXED).reorderPlugins(moving('NonAsciiRetexture.esp'), { kind: 'winningEnd' });
    const after = await snapshotTree(dir);
    assertOnlyChanged(before, after, new Set([DEFAULT_PLUGINS, DEFAULT_LOAD_ORDER]));

    expect((await pluginOrder(dir)).at(-1)).toBe('NonAsciiRetexture.esp');
  });
});
