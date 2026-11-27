import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FSWatcher } from 'node:fs';
import { chmod, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { present } from '../../ports/present';
import { eventually, writtenAndHeard } from '../../test/eventually';
import { fakeVscodeModule, watchers } from '../../test/mo2/fakeVscodeWatcher';
import { cloneCorpusFixture } from '../../test/mo2/corpusFixture';
import { adapterOver } from '../../test/mo2/adapterOver';
import type { InstanceAdapter, Subscription } from '../instanceAdapter';

// Resolves last of the realpaths in flight beside it, whatever the disk's timing.
let slowRealpath: string | undefined;
let unresolvable: string | undefined;
const opened = vi.hoisted((): { watchers: FSWatcher[] } => ({ watchers: [] }));
const resolving = { count: 0, idle: [] as (() => void)[] };

vi.mock('vscode', () => fakeVscodeModule());
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    realpath: async (path: string) => {
      if (path === unresolvable) throw Object.assign(new Error('EIO: i/o error'), { code: 'EIO' });
      if (path === slowRealpath && resolving.count > 0) await new Promise<void>((resolve) => { resolving.idle.push(resolve); });
      resolving.count++;
      try {
        return await actual.realpath(path);
      } finally {
        if (--resolving.count === 0) for (const resolve of resolving.idle.splice(0)) resolve();
      }
    },
  };
});
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    watch: (...args: Parameters<typeof actual.watch>) => {
      const watcher = actual.watch(...args);
      opened.watchers.push(watcher);
      return watcher;
    },
  };
});

describe('(VS Code\'s recursive watcher misses them only on Linux) the watch of the folders a folder created in the mods already held', () => {
  let root: string;
  let mods: string;
  let adapter: InstanceAdapter;
  let heard: (string | undefined)[];
  let listening: Subscription;

  const listen = (): void => {
    listening = adapter.subscribe((path) => { heard.push(path); });
  };
  const modsWatch = () => present(watchers.findLast((watcher) => watcher.base === mods && watcher.pattern.endsWith('**')), 'the watch of the mods');
  const created = (folder: string): void => { modsWatch().fireCreate(folder); };
  const removed = (folder: string): void => { modsWatch().fireDelete(folder); };
  const failures = async (): Promise<{ folder: string; reason: string }[]> => [...(await adapter.reading()).unwatchedFolders]
    .sort((a, b) => a.folder.localeCompare(b.folder));
  const signals = (): number => heard.filter((path) => path === undefined).length;

  beforeEach(async () => {
    root = cloneCorpusFixture();
    mods = join(root, 'mods');
    heard = [];
    slowRealpath = undefined;
    unresolvable = undefined;
    watchers.length = 0;
    opened.watchers.length = 0;
    adapter = adapterOver(root);
    listen();
    await adapter.reading();
  });

  afterEach(async () => {
    listening.dispose();
    await rm(root, { recursive: true, force: true });
  });

  const writesHeard = (file: string, heardAs = file): Promise<boolean> =>
    eventually(() => heard.includes(heardAs), () => writeFile(file, `${Date.now()}`));

  const settledBeforeALaterCreatedFolderIsHeard = async (): Promise<void> => {
    const later = join(mods, 'Later', 'Held');
    await mkdir(later, { recursive: true });
    created(join(mods, 'Later'));
    await writesHeard(join(later, 'Gun.json'));
  };

  it('hears a change to a file in a folder, at any depth, that a created folder already held', async () => {
    const deep = join(mods, 'Created', 'Held', 'Deeper');
    await mkdir(deep, { recursive: true });

    created(join(mods, 'Created'));

    expect(await writesHeard(join(deep, 'Gun.json'))).toBe(true);
  });

  it('hears a change in a folder made later inside a held folder', async () => {
    const heldFolder = join(mods, 'Created', 'Held');
    await mkdir(heldFolder, { recursive: true });
    created(join(mods, 'Created'));
    await writesHeard(join(heldFolder, 'Gun.json'));

    const later = join(heldFolder, 'Later');
    await mkdir(later);

    expect(await writesHeard(join(later, 'Gun.json'))).toBe(true);
  });

  it('follows a link to a folder, as MO2 follows it, and watches a loop of links once', async () => {
    const outside = join(root, 'Outside');
    await mkdir(outside);
    const folder = join(mods, 'Created');
    await mkdir(join(folder, 'Held'), { recursive: true });
    await symlink(outside, join(folder, 'Linked'));
    await symlink(folder, join(folder, 'Held', 'Back'));
    slowRealpath = join(folder, 'Linked');

    created(folder);
    const inHeld = join(folder, 'Held', 'Gun.json');
    const heldHeard = await writesHeard(inHeld);

    expect(heldHeard).toBe(true);
    expect(new Set(heard.filter((path) => path !== folder && path !== undefined))).toEqual(new Set([inHeld]));
    expect(await writesHeard(join(outside, 'Gun.json'), join(folder, 'Linked', 'Gun.json'))).toBe(true);
  });

  it('watches a folder that two links reach under the link nearer the created folder', async () => {
    const target = join(root, 'Target');
    const folder = join(mods, 'Created');
    await mkdir(target);
    await mkdir(join(folder, 'A', 'a1'), { recursive: true });
    await mkdir(join(folder, 'B'));
    await symlink(target, join(folder, 'A', 'a1', 'Deep'));
    await symlink(target, join(folder, 'B', 'Near'));

    created(folder);

    expect(await writesHeard(join(target, 'Gun.json'), join(folder, 'B', 'Near', 'Gun.json'))).toBe(true);
    expect(heard.filter((path) => path?.includes('Deep'))).toEqual([]);
  });

  it('keeps a folder heard removed that is there again, made again at its path', async () => {
    const folder = join(mods, 'Created');
    const heldFolder = join(folder, 'Held');
    await mkdir(heldFolder, { recursive: true });
    created(folder);
    await writesHeard(join(heldFolder, 'Gun.json'));

    removed(folder);

    expect(await writesHeard(join(heldFolder, 'Again.json'))).toBe(true);
  });

  it('hears a held folder deleted at its own path, and at no path inside it but its own folders\'', async () => {
    const folder = join(mods, 'Created');
    const outer = join(folder, 'Outer');
    const heldFolder = join(outer, 'Held');
    await mkdir(join(heldFolder, 'Deeper'), { recursive: true });
    created(folder);
    await writesHeard(join(heldFolder, 'Deeper', 'Gun.json'));
    await rm(join(heldFolder, 'Deeper', 'Gun.json'));
    await writtenAndHeard(outer);
    heard.length = 0;

    await rm(heldFolder, { recursive: true });
    const deletionHeard = await eventually(() => heard.includes(heldFolder));
    await writtenAndHeard(outer);

    expect(deletionHeard).toBe(true);
    expect(heard.filter((path) => path?.startsWith(`${heldFolder}/`) && path !== join(heldFolder, 'Deeper'))).toEqual([]);
  });

  it('closes every watch it opened once the listener leaves', async () => {
    const heldFolder = join(mods, 'Created', 'Held');
    await mkdir(heldFolder, { recursive: true });
    created(join(mods, 'Created'));
    await writesHeard(join(heldFolder, 'Gun.json'));
    const closed = new Set<FSWatcher>();
    for (const watcher of opened.watchers) watcher.on('close', () => { closed.add(watcher); });

    listening.dispose();
    await new Promise((r) => setImmediate(r));

    expect([opened.watchers.length > 0, closed.size]).toEqual([true, opened.watchers.length]);
  });

  it('hears again, once a listener comes back, in each folder held by a folder heard created before', async () => {
    const heldFolder = join(mods, 'Created', 'Held');
    await mkdir(heldFolder, { recursive: true });
    created(join(mods, 'Created'));
    await writesHeard(join(heldFolder, 'Gun.json'));

    listening.dispose();
    listen();

    expect(await writesHeard(join(heldFolder, 'Again.json'))).toBe(true);
  });

  it('forgets a folder removed, so a listener come back hears nothing that folder held, made again at its path', async () => {
    const folder = join(mods, 'Created');
    const heldFolder = join(folder, 'Held');
    await mkdir(heldFolder, { recursive: true });
    created(folder);
    await writesHeard(join(heldFolder, 'Gun.json'));

    await rm(folder, { recursive: true });
    removed(folder);
    await mkdir(heldFolder, { recursive: true });
    listening.dispose();
    listen();
    heard.length = 0;

    await writtenAndHeard(heldFolder);

    expect(heard.filter((path) => path?.startsWith(heldFolder))).toEqual([]);
  });

  it.skipIf(process.getuid?.() === 0)('(root reads every folder) answers each folder whose watch failed and why, signalling each failure, and forgets one removed', async () => {
    const folder = join(mods, 'Created');
    const unreadable = join(folder, 'Unreadable');
    const alsoUnreadable = join(folder, 'AlsoUnreadable');
    await mkdir(unreadable, { recursive: true });
    await mkdir(alsoUnreadable);
    await chmod(unreadable, 0o000);
    await chmod(alsoUnreadable, 0o000);
    const before = signals();

    created(folder);
    await eventually(() => signals() - before === 2);
    await chmod(unreadable, 0o755);
    await chmod(alsoUnreadable, 0o755);
    const answered = await failures();
    await rm(folder, { recursive: true });
    removed(folder);

    expect(answered).toEqual([
      { folder: alsoUnreadable, reason: 'EACCES: permission denied' },
      { folder: unreadable, reason: 'EACCES: permission denied' },
    ]);
    expect(signals() - before).toBe(2);
    expect(await failures()).toEqual([]);
  });

  it.skipIf(process.getuid?.() === 0)('(root reads every folder) answers a created folder that cannot be listed and why, signalling the failure', async () => {
    const folder = join(mods, 'Created');
    await mkdir(folder, { recursive: true });
    await chmod(folder, 0o000);
    const before = signals();

    created(folder);
    await eventually(() => signals() > before);
    await chmod(folder, 0o755);

    expect([await failures(), signals() - before]).toEqual([[{ folder, reason: 'EACCES: permission denied' }], 1]);
  });

  it('answers nothing for a created folder already gone', async () => {
    const before = signals();

    created(join(mods, 'Gone'));
    await settledBeforeALaterCreatedFolderIsHeard();

    expect([await failures(), signals() - before]).toEqual([[], 0]);
  });

  it('answers a listed folder that cannot be resolved and why, signalling the failure', async () => {
    const folder = join(mods, 'Created');
    unresolvable = join(folder, 'Held');
    await mkdir(unresolvable, { recursive: true });
    const before = signals();

    created(folder);
    await eventually(() => signals() > before);

    expect([await failures(), signals() - before]).toEqual([[{ folder: unresolvable, reason: 'EIO: i/o error' }], 1]);
  });

  it('answers nothing for a created path that is a file', async () => {
    const file = join(mods, 'Created');
    await writeFile(file, '');
    const before = signals();

    created(file);
    await settledBeforeALaterCreatedFolderIsHeard();

    expect([await failures(), signals() - before]).toEqual([[], 0]);
  });

  it.skipIf(process.getuid?.() === 0)('(root reads every folder) forgets a reason a created folder could not be listed once it lists', async () => {
    const folder = join(mods, 'Created');
    await mkdir(folder, { recursive: true });
    await chmod(folder, 0o000);
    const before = signals();
    created(folder);
    await eventually(() => signals() > before);

    await chmod(folder, 0o755);
    created(folder);
    await settledBeforeALaterCreatedFolderIsHeard();

    expect(await failures()).toEqual([]);
  });

  it.skipIf(process.getuid?.() === 0)('(root reads every folder) forgets a reason a created folder could not be listed once a file replaces it', async () => {
    const folder = join(mods, 'Created');
    await mkdir(folder, { recursive: true });
    await chmod(folder, 0o000);
    const before = signals();
    created(folder);
    await eventually(() => signals() > before);

    await chmod(folder, 0o755);
    await rm(folder, { recursive: true });
    await writeFile(folder, '');
    created(folder);
    await settledBeforeALaterCreatedFolderIsHeard();

    expect(await failures()).toEqual([]);
  });
});
