import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { heldFolderWatchFor, type HeldFolderWatch } from '../heldFolders';
import { present } from '../../ports/present';
import { eventually, writtenAndHeard } from '../../test/eventually';

let slowRealpath: string | undefined;

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    realpath: async (path: string) => {
      if (path === slowRealpath) await new Promise((r) => setTimeout(r, 100));
      return actual.realpath(path);
    },
  };
});

describe.runIf(process.platform === 'linux')('(VS Code\'s recursive watcher misses them only on Linux) the watch of the folders a folder created already held', () => {
  let root: string;
  let heard: string[];
  let failures: number;
  let held: HeldFolderWatch;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'held-folders-'));
    heard = [];
    failures = 0;
    slowRealpath = undefined;
    held =present(heldFolderWatchFor('**', { onChange: (path) => { heard.push(path); }, holds: () => true, onFailure: () => { failures++; } }), 'a held-folder watch on Linux');
    await held.open();
  });

  afterEach(async () => {
    held.close();
    await rm(root, { recursive: true, force: true });
  });

  const writesHeard = (file: string, heardAs = file): Promise<boolean> =>
    eventually(() => heard.includes(heardAs), () => writeFile(file, `${Date.now()}`));

  it('hears a change to a file in a folder, at any depth, that a created folder already held', async () => {
    const deep = join(root, 'Created', 'Held', 'Deeper');
    await mkdir(deep, { recursive: true });

    await held.created(join(root, 'Created'));

    expect(await writesHeard(join(deep, 'Gun.json'))).toBe(true);
  });

  it('hears a change in a folder made later inside a held folder', async () => {
    const heldFolder = join(root, 'Created', 'Held');
    await mkdir(heldFolder, { recursive: true });
    await held.created(join(root, 'Created'));

    const later = join(heldFolder, 'Later');
    await mkdir(later);

    expect(await writesHeard(join(later, 'Gun.json'))).toBe(true);
  });

  it('follows a link to a folder, as MO2 follows it, and watches a loop of links once', async () => {
    const outside = join(root, 'Outside');
    await mkdir(outside);
    const created = join(root, 'Created');
    await mkdir(join(created, 'Held'), { recursive: true });
    await symlink(outside, join(created, 'Linked'));
    await symlink(created, join(created, 'Held', 'Back'));
    slowRealpath = join(created, 'Linked');

    await held.created(created);
    const inHeld = join(created, 'Held', 'Gun.json');
    const heldHeard = await writesHeard(inHeld);

    expect(heldHeard).toBe(true);
    expect(new Set(heard)).toEqual(new Set([inHeld]));
    expect(await writesHeard(join(outside, 'Gun.json'), join(created, 'Linked', 'Gun.json'))).toBe(true);
  });

  it('keeps a folder heard removed that is there again, made again at its path', async () => {
    const created = join(root, 'Created');
    const heldFolder = join(created, 'Held');
    await mkdir(heldFolder, { recursive: true });
    await held.created(created);

    held.removed(created);

    expect(await writesHeard(join(heldFolder, 'Gun.json'))).toBe(true);
  });

  it('hears a held folder deleted at its own path, and at no path inside it but its own folders\'', async () => {
    const created = join(root, 'Created');
    const outer = join(created, 'Outer');
    const heldFolder = join(outer, 'Held');
    await mkdir(join(heldFolder, 'Deeper'), { recursive: true });
    await held.created(created);

    await rm(heldFolder, { recursive: true });
    const deletionHeard = await eventually(() => heard.includes(heldFolder));
    await writtenAndHeard(outer);

    expect(deletionHeard).toBe(true);
    expect(heard.filter((path) => path.startsWith(`${heldFolder}/`) && path !== join(heldFolder, 'Deeper'))).toEqual([]);
  });

  it('hears nothing once closed', async () => {
    const heldFolder = join(root, 'Created', 'Held');
    await mkdir(heldFolder, { recursive: true });
    await held.created(join(root, 'Created'));

    held.close();

    await writtenAndHeard(heldFolder);

    expect(heard).toEqual([]);
  });

  it('hears again, once opened after a close, in each folder held by a folder heard created before', async () => {
    const heldFolder = join(root, 'Created', 'Held');
    await mkdir(heldFolder, { recursive: true });
    await held.created(join(root, 'Created'));

    held.close();
    await held.open();

    expect(await writesHeard(join(heldFolder, 'Gun.json'))).toBe(true);
  });

  it('forgets a folder removed, so opened again it watches nothing that folder held, made again at its path', async () => {
    const created = join(root, 'Created');
    const heldFolder = join(created, 'Held');
    await mkdir(heldFolder, { recursive: true });
    await held.created(created);

    await rm(created, { recursive: true });
    held.removed(created);
    await mkdir(heldFolder, { recursive: true });
    held.close();
    await held.open();

    await writtenAndHeard(heldFolder);

    expect(heard).toEqual([]);
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('(Windows has no POSIX mode bits, and root reads every folder) answers once each reason a folder\'s watch failed, signalling each failure, and forgets one removed', async () => {
    const created = join(root, 'Created');
    const unreadable = [join(created, 'Unreadable'), join(created, 'AlsoUnreadable')];
    for (const folder of unreadable) {
      await mkdir(folder, { recursive: true });
      await chmod(folder, 0o000);
    }

    await held.created(created);
    for (const folder of unreadable) await chmod(folder, 0o755);
    const answered = held.failures();
    await rm(created, { recursive: true });
    held.removed(created);

    expect(answered).toEqual(['EACCES: permission denied']);
    expect(failures).toBe(2);
    expect(held.failures()).toEqual([]);
  });
});
