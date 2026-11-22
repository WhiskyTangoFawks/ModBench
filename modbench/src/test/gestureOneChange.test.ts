import { describe, it, expect, afterEach, vi } from 'vitest';
import { rm } from 'node:fs/promises';
import { fakeVscodeModule } from './mo2/fakeVscodeWatcher';

vi.mock('vscode', async () => {
  const { recordedWithProgress } = await import('./recordedProgress');
  return { ...fakeVscodeModule(), window: { withProgress: recordedWithProgress } };
});

import { Instance } from '../instanceLoader/instance';
import { ambientWrites } from '../instanceLoader/ambientWrites';
import { modSyncOn } from '../mods/modSync';
import { modCommands, modSyncOver } from '../modCommands/modCommands';
import { entryRenameCommands } from '../modCommands/renameEntry';
import { heldTexts } from '../symbolNames/symbolNames';
import { runWritingGesture } from '../drivingLib/writingGesture';
import { toldAfter, writesToldTo } from '../repositoriesLib/writesTold';
import { InMemoryMEditClient } from '../client/test/InMemoryMEditClient';
import { fakeWorkspace } from './fakeWorkspace';
import { GAME_FOLDER_SETTING_ID } from './gameFolderSetting';
import { cloneCorpusFixture } from './mo2/corpusFixture';
import { adapterOver } from './mo2/adapterOver';
import { recordedSyncs } from './recordedSyncs';

const MOD = 'zz Timing Probe';
const RENAMED = 'zz Renamed Probe';

let root: string | undefined;
let instance: Instance | undefined;

afterEach(async () => {
  instance?.dispose();
  writesToldTo({ told: () => Promise.resolve({ subscribed: Promise.resolve() }) });
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
  const { syncMods, wrote } = recordedSyncs(modSyncOver(adapter));
  const { modSync } = modSyncOn({ instance: loader, syncMods, channel: { error: () => undefined, info: () => undefined } });
  await loader.refresh();
  await modSync.settled();
  await loader.refresh();
  await modSync.settled();
  wrote.length = 0;
  const landed: { listed: boolean; folder: boolean; renamed: boolean }[] = [];
  loader.subscribe((value) => {
    landed.push({
      listed: value.mods.some((entry) => entry.name === MOD),
      folder: value.modFolders?.some((folder) => folder.name === MOD) === true,
      renamed: value.mods.some((entry) => entry.name === RENAMED) && value.modFolders?.some((folder) => folder.name === RENAMED) === true,
    });
  });
  const gesture = <T>(write: string, command: () => Promise<T>) => runWritingGesture(write, 'modbench.modList', loader, command);
  return { adapter, commands: modCommands(adapter), gesture, landed, loader, modSync, syncWrote: wrote };
}

const trash = (path: string) => toldAfter([path], () => rm(path, { recursive: true, force: true }));

describe('a mod gesture\'s writes land, and mod sync, waiting for its end, writes nothing', () => {
  it('lands a new empty mod\'s folder and its line', async () => {
    const { commands, gesture, landed, modSync, syncWrote } = await wired();

    await gesture('modbench.mod.createEmpty', () => commands.createEmptyMod(MOD));
    await modSync.settled();

    expect(landed.at(-1)).toEqual({ listed: true, folder: true, renamed: false });
    expect(syncWrote).toEqual([]);
  });

  it('lands an uninstalled mod\'s folder removal and its line removal', async () => {
    const { commands, gesture, landed, modSync, syncWrote } = await wired();
    await gesture('modbench.mod.createEmpty', () => commands.createEmptyMod(MOD));
    await modSync.settled();
    landed.length = 0;

    await gesture('modbench.mod.uninstall', () => commands.uninstallMods([MOD], trash));
    await modSync.settled();

    expect(landed.at(-1)).toEqual({ listed: false, folder: false, renamed: false });
    expect(syncWrote).toEqual([]);
  });

  it('lands a rename whose git follow wrote unnamed files', async () => {
    const { adapter, commands, gesture, landed, modSync, syncWrote } = await wired();
    await gesture('modbench.mod.createEmpty', () => commands.createEmptyMod(MOD));
    await modSync.settled();
    landed.length = 0;
    const following = { ...adapter, followFoldersInRepository: () => { ambientWrites.leaveUnnamed(); return Promise.resolve(); } };
    const renames = entryRenameCommands({ adapter: following, client: new InMemoryMEditClient() });
    const editing = { held: heldTexts([]), apply: () => Promise.resolve(undefined) };

    await gesture('modbench.mod.rename', () => renames.renameMod(editing, MOD, RENAMED));
    await modSync.settled();

    expect(landed.at(-1)).toEqual({ listed: false, folder: false, renamed: true });
    expect(syncWrote).toEqual([]);
  });
});

describe('when a mod gesture returns, the loader\'s value holds every file it wrote', () => {
  it.each([
    ['createEmpty', async ({ commands, gesture }: Awaited<ReturnType<typeof wired>>) => { await gesture('modbench.mod.createEmpty', () => commands.createEmptyMod(MOD)); }, { listed: true, folder: true, renamed: false }],
    ['uninstall', async ({ commands, gesture }: Awaited<ReturnType<typeof wired>>) => {
      await gesture('modbench.mod.createEmpty', () => commands.createEmptyMod(MOD));
      await gesture('modbench.mod.uninstall', () => commands.uninstallMods([MOD], trash));
    }, { listed: false, folder: false, renamed: false }],
    ['rename', async ({ adapter, commands, gesture }: Awaited<ReturnType<typeof wired>>) => {
      await gesture('modbench.mod.createEmpty', () => commands.createEmptyMod(MOD));
      const renames = entryRenameCommands({ adapter, client: new InMemoryMEditClient() });
      await gesture('modbench.mod.rename', () => renames.renameMod({ held: heldTexts([]), apply: () => Promise.resolve(undefined) }, MOD, RENAMED));
    }, { listed: false, folder: false, renamed: true }],
  ])('%s', async (_gesture, run, held) => {
    const wiredOver = await wired();

    await run(wiredOver);

    const { value } = wiredOver.loader;
    expect({
      listed: value.mods.some((entry) => entry.name === MOD),
      folder: value.modFolders?.some((folder) => folder.name === MOD) === true,
      renamed: value.mods.some((entry) => entry.name === RENAMED) && value.modFolders?.some((folder) => folder.name === RENAMED) === true,
    }).toEqual(held);
  });
});
