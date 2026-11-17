import { describe, it, expect, afterEach, vi } from 'vitest';
import { rm } from 'node:fs/promises';
import { fakeVscodeModule } from './mo2/fakeVscodeWatcher';

vi.mock('vscode', async () => {
  const { recordedWithProgress } = await import('./recordedProgress');
  return { ...fakeVscodeModule(), window: { withProgress: recordedWithProgress } };
});

import { Instance } from '../instanceLoader/instance';
import { modSyncOn } from '../mods/modSync';
import { modCommands, modSyncOver } from '../modCommands/modCommands';
import { runWritingGesture, surfaceOneChange } from '../drivingLib/writingGesture';
import { toldAfter, toldOnceSettled, writesToldTo } from '../repositoriesLib/writesTold';
import { InMemoryMEditClient } from '../client/test/InMemoryMEditClient';
import { fakeWorkspace } from './fakeWorkspace';
import { GAME_FOLDER_SETTING_ID } from './gameFolderSetting';
import { cloneCorpusFixture } from './mo2/corpusFixture';
import { adapterOver } from './mo2/adapterOver';

const MOD = 'zz Timing Probe';

let root: string | undefined;
let instance: Instance | undefined;
let oneChange: { dispose(): void } | undefined;

afterEach(async () => {
  instance?.dispose();
  oneChange?.dispose();
  writesToldTo({ told: () => Promise.resolve() });
  if (root !== undefined) await rm(root, { recursive: true, force: true });
});

async function wired() {
  root = cloneCorpusFixture();
  const adapter = adapterOver(root);
  const loader = new Instance({
    adapter, gameFolderSettingId: GAME_FOLDER_SETTING_ID, log: { info: () => undefined, warn: () => undefined, error: () => undefined },
    medit: new InMemoryMEditClient(), workspace: fakeWorkspace(),
  });
  instance = loader;
  writesToldTo(loader);
  oneChange = surfaceOneChange(toldOnceSettled);
  const syncs: { added: string[]; dropped: string[] }[] = [];
  const syncMods = modSyncOver(adapter);
  const { modSync } = modSyncOn({
    instance: loader,
    syncMods: async () => {
      const result = await syncMods();
      if (result.applied) syncs.push(result);
      return result;
    },
    channel: { error: () => undefined, info: () => undefined },
  });
  await loader.refresh();
  await modSync.settled();
  await loader.refresh();
  await modSync.settled();
  syncs.length = 0;
  const landed: { listed: boolean; folder: boolean }[] = [];
  loader.subscribe((value) => {
    landed.push({
      listed: value.mods.some((entry) => entry.name === MOD),
      folder: value.modFolders?.some((folder) => folder.name === MOD) === true,
    });
  });
  const gesture = <T>(write: string, command: () => Promise<T>) => runWritingGesture(write, 'modbench.modList', loader, command);
  const syncsThatWrote = () => syncs.filter(({ added, dropped }) => added.length + dropped.length > 0);
  return { commands: modCommands(adapter), gesture, landed, loader, modSync, syncsThatWrote };
}

const trash = (path: string) => toldAfter([path], () => rm(path, { recursive: true, force: true }));

describe('a writing gesture hands its change as one change', () => {
  it('lands a new empty mod\'s folder and its line as one value, and mod sync writes nothing', async () => {
    const { commands, gesture, landed, modSync, syncsThatWrote } = await wired();

    await gesture('modbench.mod.createEmpty', () => commands.createEmptyMod(MOD));
    await modSync.settled();

    expect(landed).toEqual([{ listed: true, folder: true }]);
    expect(syncsThatWrote()).toEqual([]);
  });

  it('holds the new mod\'s folder and its line in the loader\'s value when the gesture returns', async () => {
    const { commands, gesture, loader } = await wired();

    await gesture('modbench.mod.createEmpty', () => commands.createEmptyMod(MOD));

    expect(loader.value.mods.some((entry) => entry.name === MOD)).toBe(true);
    expect(loader.value.modFolders?.some((folder) => folder.name === MOD)).toBe(true);
  });

  it('lands an uninstalled mod\'s folder removal and its line removal as one value, and mod sync writes nothing', async () => {
    const { commands, gesture, landed, modSync, syncsThatWrote } = await wired();
    await gesture('modbench.mod.createEmpty', () => commands.createEmptyMod(MOD));
    await modSync.settled();
    landed.length = 0;

    await gesture('modbench.mod.uninstall', () => commands.uninstallMods([MOD], trash));
    await modSync.settled();

    expect(landed).toEqual([{ listed: false, folder: false }]);
    expect(syncsThatWrote()).toEqual([]);
  });
});
