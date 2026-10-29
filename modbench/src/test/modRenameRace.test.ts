import { GAME_FOLDER_SETTING_ID } from './gameFolderSetting';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { watchers, fakeVscodeModule } from './mo2/fakeVscodeWatcher';
import { NO_PUBLISHER } from './fakeInstanceAdapter';
import { TreeItem, TreeItemCollapsibleState, TreeItemCheckboxState, ThemeIcon, ThemeColor, EventEmitter, Uri } from './vscodeMock';
import { adapterOver, readModlistEntries, sourceOver } from './mo2/adapterOver';
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
    ...fakeVscodeModule(), Uri, TreeItem, TreeItemCollapsibleState, TreeItemCheckboxState, ThemeIcon, ThemeColor, EventEmitter,
    commands: { registerCommand: (id: string, handler: (...args: unknown[]) => unknown) => { handlers.set(id, handler); return { dispose: () => undefined }; } },
    window: { showInputBox, withProgress: recordedWithProgress },
  };
});

import { Instance } from '../instanceLoader/instance';
import { instanceSyncs } from '../syncWiring';
import { modCommands, modSyncOver } from '../modCommands/modCommands';
import { registerModContextCommands } from '../mods/modManagementCommands';
import { ModNode } from '../mods/ModListProvider';
import { recordingReporter, scriptedDialog } from './surfacingDoubles';
import { present } from '../ports/present';

const MOD = 'Patch Mod';
const RENAMED = 'Renamed Patch';

let root: string | undefined;
let instance: Instance | undefined;

afterEach(async () => {
  instance?.dispose();
  if (root !== undefined) await rm(root, { recursive: true, force: true });
  watchers.length = 0;
});

describe('a rename while a recompute is reading', () => {
  it('keeps the renamed mod\'s line, its place and its enabled state, whichever files the recompute read after the folder moved', async () => {
    root = cloneCorpusFixture();
    const gameFolder = { kind: 'found', root: join(root, 'Game'), dataFolder: join(root, 'Game', 'Data') } as const;
    const writer = adapterOver(root, { gameFolder });
    const reader = sourceOver(root, { gameFolder });

    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let holding = false;
    let readingBegun!: () => void;
    const readBegun = new Promise<void>((resolve) => { readingBegun = resolve; });
    const holdingSource: ReadingSource = {
      ...reader,
      modOrder: async (profile) => {
        if (holding) { readingBegun(); await held; }
        return reader.modOrder(profile);
      },
      modFolders: async (skippedLink) => {
        if (holding) await held;
        return reader.modFolders(skippedLink);
      },
    };
    instance = new Instance({
      gameFolderSettingId: GAME_FOLDER_SETTING_ID, window: STEADY_WINDOW, log: { info: () => {}, warn: () => {}, error: () => {} },
      adapter: { ...writer, reading: async () => ({ ...await readInstance(holdingSource), publisherConfiguration: NO_PUBLISHER }) },
    });
    const { modSync } = instanceSyncs({
      instance, syncMods: modSyncOver(writer),
      syncPlugins: () => Promise.resolve({ applied: true, wrote: false, added: [], dropped: [] }), channel: { error: () => {}, info: () => {} },
    });
    await instance.refresh();
    await modSync.settled();
    const before = (await readModlistEntries(root)).map((line) => ({ ...line, name: line.name === MOD ? RENAMED : line.name }));

    holding = true;
    const overlapping = instance.refresh();
    await readBegun;
    const folderRenamed = async (from: string, to: string) => {
      await writer.renameModFolder(from, to);
      release();
      await overlapping;
      await modSync.settled();
    };
    showInputBox.mockResolvedValue(RENAMED);
    registerModContextCommands({
      commands: modCommands({ ...writer, renameModFolder: folderRenamed }, { changeSourceManifest: () => Promise.reject(new Error('unscripted')) }),
      instance, viewSelection: () => [], reporter: recordingReporter(), ask: scriptedDialog(), trash: vi.fn(), log: vi.fn(),
    });
    await present(handlers.get('modbench.mod.rename'), 'the rename mod command')(new ModNode({ kind: 'mod', name: MOD, enabled: true }));
    await modSync.settled();

    expect(await readModlistEntries(root)).toEqual(before);
  });
});
