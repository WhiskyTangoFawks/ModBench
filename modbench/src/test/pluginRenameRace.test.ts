import { GAME_FOLDER_SETTING_ID } from './gameFolderSetting';
import { NO_MOD_STATUSES } from './noModStatuses';
import { unreadStatus } from './unreadStatus';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { watchers, fakeVscodeModule } from './mo2/fakeVscodeWatcher';
import { NO_PUBLISHER } from './fakeInstanceAdapter';
import { TreeItem, TreeItemCollapsibleState, TreeItemCheckboxState, ThemeIcon, ThemeColor, EventEmitter, uriFrom } from './vscodeMock';
import { adapterOver, readPluginLines, sourceOver } from './mo2/adapterOver';
import { pluginCommandsWith } from './pluginCommandsWith';
import { STEADY_WINDOW } from './steadyWindow';
import { readInstance, type ReadingSource } from '../instanceAdapter/instanceReading';
import { cloneCorpusFixture } from './mo2/corpusFixture';

const { handlers, showInputBox } = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  showInputBox: vi.fn(),
}));

vi.mock('vscode', async () => {
  const { recordedWithProgress } = await import('./recordedProgress');
  return {
    ...fakeVscodeModule(), Uri: { ...fakeVscodeModule().Uri, from: uriFrom }, TreeItem, TreeItemCollapsibleState, TreeItemCheckboxState, ThemeIcon, ThemeColor, EventEmitter,
    commands: { registerCommand: (id: string, handler: (...args: unknown[]) => unknown) => { handlers.set(id, handler); return { dispose: () => undefined }; } },
    window: { showInputBox, withProgress: recordedWithProgress },
  };
});

import { Instance } from '../instanceLoader/instance';
import { instanceSyncs } from '../syncWiring';
import { pluginSyncOver } from '../pluginCommands/plugins';
import { modSyncOver } from '../modCommands/modCommands';
import { registerRenamePluginCommand } from '../plugins/pluginRenameCommand';
import { PluginNode } from '../plugins/pluginRows';
import { recordingReporter, scriptedDialog } from './surfacingDoubles';
import { present } from '../ports/present';
import { InMemoryMEditClient } from '../client/test/InMemoryMEditClient';

const PLUGIN = { name: 'Patch Mod.esp', origin: 'Patch Mod' };
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
    const reader = sourceOver(root, { gameFolder });

    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let holding = false;
    let filesRead!: () => void;
    const filesReadBeforeRename = new Promise<void>((resolve) => { filesRead = resolve; });
    const holdingSource: ReadingSource = {
      ...reader,
      originFiles: async (origin: Parameters<typeof reader.originFiles>[0], folders: Parameters<typeof reader.originFiles>[1]) => {
        const files = await reader.originFiles(origin, folders);
        if (holding && origin.kind === 'mod' && origin.name === PLUGIN.origin) filesRead();
        return files;
      },
      pluginOrder: async (profile: string) => {
        if (holding) await held;
        return reader.pluginOrder(profile);
      },
    };
    instance = new Instance({
      gameFolderSettingId: GAME_FOLDER_SETTING_ID, window: STEADY_WINDOW, log: { info: () => {}, warn: () => {}, error: () => {} },
      adapter: { ...writer, reading: async () => ({ ...await readInstance(holdingSource), publisherConfiguration: NO_PUBLISHER }) },
    });
    const { pluginSync } = instanceSyncs({ modStatuses: NO_MOD_STATUSES,
      instance, syncMods: modSyncOver(writer), syncPlugins: pluginSyncOver(writer, unreadStatus, NO_MOD_STATUSES), channel: { error: () => {}, info: () => {} },
    });
    await instance.refresh();
    await pluginSync.settled();
    const before = (await readPluginLines(root)).map((line) => ({ ...line, name: line.name === PLUGIN.name ? RENAMED : line.name }));

    holding = true;
    const overlapping = instance.refresh();
    await filesReadBeforeRename;
    const client = new InMemoryMEditClient();
    client.setCommandResult('getRenameSourceChanges', { treeName: PLUGIN.name, moves: [], deletions: [], documents: [] });
    client.setCommandResult('moveLastWritten', { moved: true });
    client.setQueryAnswer('getCreatablePluginExtensions', ['.esm', '.esl', '.esp']);
    client.setQueryAnswer('getPluginDependants', { dependants: [], unreadable: [] });
    showInputBox.mockResolvedValue(RENAMED);
    registerRenamePluginCommand({
      client, commands: pluginCommandsWith({ ...writer, renamePlugin: async (...args) => { await writer.renamePlugin(...args); release(); } }, client),
      ask: scriptedDialog('Rename'), instance, reporter: recordingReporter(),
      source: { applyWorkspaceChanges: () => Promise.resolve(), oneAtATime: (job) => job(), refreshSourceControlFor: () => undefined },
    }, () => []);
    await present(handlers.get('modbench.plugin.rename'), 'the rename plugin command')(new PluginNode({ name: PLUGIN.name, enabled: true }, PLUGIN.origin));
    await overlapping;
    await pluginSync.settled();

    expect(await readPluginLines(root)).toEqual(before);
  });
});
