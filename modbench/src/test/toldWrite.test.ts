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
import { diskCheckedBy, writesToldTo } from '../repositoriesLib/writesTold';
import { ambientWrites } from '../instanceLoader/ambientWrites';
import { handingOneChange } from '../drivingLib/writingGesture';
import { TOUCHING_READ, type FilesChanged } from '../instanceLoader/filesChanged';
import { InMemoryMEditClient } from '../client/test/InMemoryMEditClient';
import { fakeWorkspace } from './fakeWorkspace';
import { GAME_FOLDER_SETTING_ID } from './gameFolderSetting';
import { cloneCorpusFixture } from './mo2/corpusFixture';
import { adapterOver } from './mo2/adapterOver';

let root: string | undefined;
let instance: Instance | undefined;

afterEach(async () => {
  instance?.dispose();
  writesToldTo({ told: () => Promise.resolve({ subscribed: Promise.resolve() }) });
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
  diskCheckedBy(ambientWrites);
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

  it('is held by the loader as it returns inside a gesture, and the gesture\'s end and the watch\'s echo of it are no change (ADR-0029, Consequences, bullets 1 and 2)', async () => {
    const { adapter, instance: loader, modlist } = await wiredInstance();
    const heard: (readonly string[])[] = [];
    loader.subscribe((_value, _sequence, { named }) => { heard.push(named); });
    let heardAsItReturned: (readonly string[])[] = [];

    await handingOneChange(loader, async () => {
      await adapter.changeModOrder('Default', () => [{ kind: 'enable', mod: 'Harder VATS', enabled: true }]);
      heardAsItReturned = [...heard];
    });
    await loader.refresh([modlist]);

    expect([heardAsItReturned, heard]).toEqual([[[modlist]], [[modlist]]]);
  });

  it('returns from a gesture once the subscribers of the values its told writes landed have settled (ADR-0029, Consequences, bullet 1)', async () => {
    const { adapter, instance: loader } = await wiredInstance();
    let release = (): void => undefined;
    let entered = (): void => undefined;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const deriving = new Promise<void>((resolve) => { entered = resolve; });
    loader.subscribe(async () => {
      entered();
      await held;
    });
    let returned = false;

    const gesture = handingOneChange(loader, () => adapter.changeModOrder('Default', () => [{ kind: 'enable', mod: 'Harder VATS', enabled: true }]))
      .then(() => { returned = true; });
    await deriving;
    await loader.refresh([]);
    const returnedWhileDeriving = returned;
    release();
    await gesture;

    expect([returnedWhileDeriving, returned]).toEqual([false, true]);
  });

  it('tells a subscriber the value it was told last and what changed of the origins\' files since, once for every subscriber (ADR-0029, Consequences, bullet 4)', async () => {
    const { instance: loader } = await wiredInstance();
    const folder = join(root ?? '', 'mods', 'Patch Mod');
    const heard: { before: unknown; changed: FilesChanged }[] = [];
    const landed: unknown[] = [];
    loader.subscribe((value, _sequence, told) => {
      landed.push(value);
      heard.push({ before: told.before, changed: told.changed() });
    }, TOUCHING_READ);

    await writeFile(join(folder, 'first.dds'), 'first');
    await loader.refresh([join(folder, 'first.dds')]);
    await writeFile(join(folder, 'second.dds'), 'second');
    await loader.refresh([join(folder, 'second.dds')]);

    const [, second] = heard;
    expect([second?.before === landed[0], second?.changed]).toMatchObject([true, [{ origin: { kind: 'mod', name: 'Patch Mod' }, gained: [{ relativePath: 'second.dds' }] }]]);
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
