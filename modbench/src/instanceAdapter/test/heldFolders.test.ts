import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { heldFolderWatch, type HeldFolderWatch } from '../heldFolders';
import { eventually, writtenAndHeard } from '../../test/eventually';

describe('heldFolderWatch', () => {
  let root: string;
  let heard: string[];
  let failures: number;
  let held: HeldFolderWatch;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'held-folders-'));
    heard = [];
    failures = 0;
    held = heldFolderWatch({ onChange: (path) => { heard.push(path); }, holds: () => true, onFailure: () => { failures++; } });
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

  it('hears a folder deleted inside a held folder, and no change inside a held folder deleted itself', async () => {
    const created = join(root, 'Created');
    const heldFolder = join(created, 'Held');
    await mkdir(join(heldFolder, 'Deeper'), { recursive: true });
    await held.created(created);

    await rm(heldFolder, { recursive: true });
    const deletionHeard = await eventually(() => heard.includes(join(heldFolder, 'Deeper')));
    await writtenAndHeard(created);

    expect(deletionHeard).toBe(true);
    expect(heard.filter((path) => path.startsWith(`${heldFolder}/`))).toEqual([join(heldFolder, 'Deeper')]);
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
