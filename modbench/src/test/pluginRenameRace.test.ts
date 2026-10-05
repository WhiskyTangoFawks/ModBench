import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { watchers, fakeVscodeModule } from './mo2/fakeVscodeWatcher';
import { TreeItem, TreeItemCollapsibleState, ThemeIcon, EventEmitter } from './vscodeMock';
import { adapterOver, readPluginLines, STEADY_WINDOW } from './mo2/adapterOver';
import { cloneCorpusFixture } from './mo2/corpusFixture';

vi.mock('vscode', () => ({ ...fakeVscodeModule(), TreeItem, TreeItemCollapsibleState, ThemeIcon, EventEmitter }));

import { Instance } from '../instanceLoader/instance';
import { wirePluginSync } from './syncWiring';
import { pluginSyncOver } from '../pluginsCommands/plugins';
import { renamePlugin } from '../pluginsCommands/renamePlugin';
import { InMemoryMEditClient } from '../client/test/InMemoryMEditClient';

const PLUGIN = { name: 'Tracked Patch Mod.esp', origin: 'Tracked Patch Mod' };
const RENAMED = 'Renamed Patch.esp';

let root: string | undefined;
let instance: Instance | undefined;

afterEach(async () => {
  instance?.dispose();
  if (root !== undefined) await rm(root, { recursive: true, force: true });
  watchers.length = 0;
});

describe('a rename while a recompute is reading', () => {
  it('keeps the renamed plugin\'s line, its place and its enabled state, and adds no line for the old name', async () => {
    root = cloneCorpusFixture();
    await mkdir(join(root, 'Game', 'Data'), { recursive: true });
    const gameFolder = { kind: 'found', root: join(root, 'Game'), dataFolder: join(root, 'Game', 'Data') } as const;
    const writer = adapterOver(root, { gameFolder });
    const reader = adapterOver(root, { gameFolder });

    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let holding = false;
    let filesRead!: () => void;
    const filesReadBeforeRename = new Promise<void>((resolve) => { filesRead = resolve; });
    instance = new Instance({
      window: STEADY_WINDOW, log: () => {}, logReadFailure: () => {},
      adapter: {
        ...reader,
        originFiles: async (origin) => {
          const files = await reader.originFiles(origin);
          if (holding && origin.kind === 'mod' && origin.name === PLUGIN.origin) filesRead();
          return files;
        },
        pluginOrder: async (profile) => {
          if (holding) await held;
          return reader.pluginOrder(profile);
        },
      },
    });
    const pluginSync = wirePluginSync(instance, pluginSyncOver({ instanceRoot: root, adapter: writer }), { error: () => {}, info: () => {} });
    await instance.refresh();
    await pluginSync.settled();
    const before = (await readPluginLines(root)).map((line) => ({ ...line, name: line.name === PLUGIN.name ? RENAMED : line.name }));

    holding = true;
    const overlapping = instance.refresh();
    await filesReadBeforeRename;
    const client = new InMemoryMEditClient();
    client.setCommandResult('renameSource', { renamed: true });
    await instance.quiet(async () => {
      await renamePlugin({ instanceRoot: root, adapter: writer, client }, PLUGIN, RENAMED, 'Fallout4');
      release();
    });
    await overlapping;
    await pluginSync.settled();

    expect(await readPluginLines(root)).toEqual(before);
  });
});
