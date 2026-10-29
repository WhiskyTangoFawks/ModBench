import { NO_MOD_STATUSES } from '../noModStatuses';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { fakeVscodeModule } from './fakeVscodeWatcher';

vi.mock('vscode', () => fakeVscodeModule());

import { appendFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pluginSyncOver, type PluginSyncRun } from '../../pluginCommands/plugins';
import { withLock } from '../../instanceAdapter/files';
import { pluginsFile } from '../../instanceAdapter/mo2/layout';
import {
  assertOnlyChanged, cloneCorpusFixture, DEFAULT_MODLIST, DEFAULT_LOAD_ORDER, DEFAULT_PLUGINS, snapshotTree,
} from './corpusFixture';
import { adapterOver, pluginCommandsOver, readPluginLines } from './adapterOver';

const NOT_INDEXED = { getPlugins: () => Promise.reject(new Error('mEdit is indexing')) };
const moving = (...names: string[]) => names.map((name) => ({ name, origin: 'SomeMod' }));
const PROFILE = 'Default';
const WAITING_ON_THE_LOCK_MS = 200;

async function syncWithGameFolderHolding(dir: string, plugin: string): Promise<PluginSyncRun> {
  const game = join(dir, 'Game');
  await mkdir(join(game, 'Data'), { recursive: true });
  await writeFile(join(game, 'Data', plugin), '');
  return pluginSyncOver(adapterOver(dir, { gameFolder: { kind: 'found', root: game, dataFolder: join(game, 'Data') } }), NO_MOD_STATUSES);
}

function pluginsFileHeld(dir: string): { release: () => void; done: Promise<void> } {
  let release!: () => void;
  const done = withLock(pluginsFile(dir, PROFILE), () => new Promise<void>((resolve) => { release = resolve; }));
  return { release: () => { release(); }, done };
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

  it('syncPlugins converges the fixture on disk, touching only plugins.txt and loadorder.txt', async () => {
    const sync = await syncWithGameFolderHolding(dir, 'ccsbjfo4003-grenade.esl');
    const before = await snapshotTree(dir);
    const result = await sync();
    const after = await snapshotTree(dir);
    assertOnlyChanged(before, after, new Set([DEFAULT_PLUGINS, DEFAULT_LOAD_ORDER]));

    expect(result).toEqual({
      applied: true, wrote: true, added: ['NonAsciiRetexture - Addon.esl'], dropped: ['Unofficial Fallout 4 Patch.esp'],
    });
    expect((await pluginOrder(dir)).at(-1)).toBe('NonAsciiRetexture - Addon.esl');
    expect(await enabledPlugins(dir)).not.toContain('NonAsciiRetexture - Addon.esl');
  });

  it('syncPlugins over a plugin the file repeats syncs on the first line and drops it', async () => {
    await appendFile(join(dir, DEFAULT_PLUGINS), 'Unofficial Fallout 4 Patch.esp\r\n');
    const result = await (await syncWithGameFolderHolding(dir, 'ccsbjfo4003-grenade.esl'))();

    expect(result).toMatchObject({ applied: true, wrote: true, dropped: ['Unofficial Fallout 4 Patch.esp'] });
  });

  it('syncPlugins keeps, in its place and state, the line of a plugin the mod manager provides and lists while the sync waits on plugins.txt', async () => {
    const sync = await syncWithGameFolderHolding(dir, 'ccsbjfo4003-grenade.esl');
    await writeFile(join(dir, 'mods', 'Harder VATS', 'Harder VATS.esp'), '');
    const held = pluginsFileHeld(dir);

    const syncing = sync();
    await new Promise((resolve) => setTimeout(resolve, WAITING_ON_THE_LOCK_MS));
    const modlist = join(dir, DEFAULT_MODLIST);
    await writeFile(modlist, (await readFile(modlist, 'utf8')).replace('-Harder VATS', '+Harder VATS'));
    await writeFile(join(dir, DEFAULT_PLUGINS), (await readFile(join(dir, DEFAULT_PLUGINS), 'utf8')).replace('*Patch Mod.esp', '*Harder VATS.esp\r\n*Patch Mod.esp'));
    held.release();
    await held.done;

    expect(await syncing).toMatchObject({ applied: true, dropped: ['Unofficial Fallout 4 Patch.esp'] });
    expect(await readPluginLines(dir)).toContainEqual({ name: 'Harder VATS.esp', enabled: true });
    expect((await pluginOrder(dir)).indexOf('Harder VATS.esp')).toBe(1);
  });

  it('reorderPlugins moves a plugin within load order, touching only plugins.txt and loadorder.txt', async () => {
    const before = await snapshotTree(dir);
    await pluginCommandsOver(dir, NOT_INDEXED).reorderPlugins(moving('NonAsciiRetexture.esp'), { kind: 'winningEnd' });
    const after = await snapshotTree(dir);
    assertOnlyChanged(before, after, new Set([DEFAULT_PLUGINS, DEFAULT_LOAD_ORDER]));

    expect((await pluginOrder(dir)).at(-1)).toBe('NonAsciiRetexture.esp');
  });
});
