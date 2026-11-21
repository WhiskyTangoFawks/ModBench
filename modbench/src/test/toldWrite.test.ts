import { describe, it, expect, afterEach, vi } from 'vitest';
import { fakeVscodeModule } from './mo2/fakeVscodeWatcher';

vi.mock('vscode', () => fakeVscodeModule());
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, readFile: vi.fn(actual.readFile) };
});

import { cp, mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Instance } from '../instanceLoader/instance';
import { writesToldTo } from '../repositoriesLib/writesTold';
import { InMemoryMEditClient } from '../client/test/InMemoryMEditClient';
import { fakeWorkspace } from './fakeWorkspace';
import { GAME_FOLDER_SETTING_ID } from './gameFolderSetting';
import { cloneCorpusFixture } from './mo2/corpusFixture';
import { adapterOver } from './mo2/adapterOver';

let root: string | undefined;
let instance: Instance | undefined;

afterEach(async () => {
  instance?.dispose();
  writesToldTo({ told: () => Promise.resolve() });
  if (root !== undefined) await rm(root, { recursive: true, force: true });
});

async function wiredInstance() {
  root = cloneCorpusFixture();
  const anHourAgo = new Date(Date.now() - 3_600_000);
  for (const entry of await readdir(root, { recursive: true })) await utimes(join(root, entry), anHourAgo, anHourAgo);
  const adapter = adapterOver(root);
  instance = new Instance({
    adapter, gameFolderSettingId: GAME_FOLDER_SETTING_ID, log: { info: () => undefined, warn: () => undefined, error: () => undefined },
    medit: new InMemoryMEditClient(), workspace: fakeWorkspace(),
  });
  writesToldTo(instance);
  await instance.refresh();
  const modlist = join(root, 'profiles', 'Default', 'modlist.txt');
  return { adapter, instance, modlist };
}

describe('a write over the real adapter', () => {
  it('hands its text to the loader, so the file is read once, by the write itself', async () => {
    const { adapter, modlist } = await wiredInstance();
    const readsBefore = vi.mocked(readFile).mock.calls.filter(([path]) => path === modlist).length;

    await adapter.changeModOrder('Default', () => [{ kind: 'enable', mod: 'Harder VATS', enabled: true }]);

    expect(vi.mocked(readFile).mock.calls.filter(([path]) => path === modlist).length - readsBefore).toBe(1);
  });

  it('is named to the subscribers once, and the watch\'s echo of it, read again by the guard against a stamp too fresh to trust, is no change', async () => {
    const { adapter, instance: loader, modlist } = await wiredInstance();
    const heard: (readonly string[])[] = [];
    loader.subscribe((_value, _sequence, { named }) => { heard.push(named); });

    await adapter.changeModOrder('Default', () => [{ kind: 'enable', mod: 'Harder VATS', enabled: true }]);
    await loader.refresh([modlist]);

    expect(heard).toEqual([[modlist]]);
  });

  it('names the folder of a copy over an existing mod folder, whose own stamp holds while a plugin below it is replaced', async () => {
    const { instance: loader } = await wiredInstance();
    const folder = join(root ?? '', 'mods', 'Patch Mod');
    const replacement = await mkdtemp(join(tmpdir(), 'modbench-reinstall-'));
    await writeFile(join(replacement, 'Patch Mod.esp'), 'a reinstalled plugin');
    const heard: (readonly string[])[] = [];
    loader.subscribe((_value, _sequence, { named }) => { heard.push(named); });

    const stamp = await stat(folder);
    await cp(replacement, folder, { recursive: true });
    await utimes(folder, stamp.atime, stamp.mtime);
    await rm(replacement, { recursive: true, force: true });
    await loader.refresh([folder]);

    expect(heard).toEqual([[folder]]);
  });

  it('names a plugin the watch heard changed, though no fact of the value holds its stamp, so mEdit is told', async () => {
    const { instance: loader } = await wiredInstance();
    const plugin = join(root ?? '', 'mods', 'Patch Mod', 'Patch Mod.esp');
    const heard: (readonly string[])[] = [];
    loader.subscribe((_value, _sequence, { named }) => { heard.push(named); });

    await writeFile(plugin, 'bytes an xEdit save wrote');
    await loader.refresh([plugin]);

    expect(heard).toEqual([[plugin]]);
  });
});
