import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { watch } from 'node:fs';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { heldFolderWatch, type HeldFolderWatch } from '../heldFolders';

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

  const writesHeard = async (file: string): Promise<boolean> => {
    const deadline = Date.now() + 2_000;
    while (!heard.includes(file)) {
      if (Date.now() > deadline) return false;
      await writeFile(file, `${Date.now()}`);
      await new Promise((r) => setTimeout(r, 20));
    }
    return true;
  };

  it('hears a change to a file in a folder, at any depth, that a created folder already held', async () => {
    const deep = join(root, 'Created', 'Held', 'Deeper');
    await mkdir(deep, { recursive: true });
    const file = join(deep, 'Gun.json');
    await writeFile(file, '{}');

    await held.created(join(root, 'Created'));
    await writeFile(file, '{ }');

    expect(await writesHeard(file)).toBe(true);
  });

  it('hears a change in a folder made later inside a held folder', async () => {
    const heldFolder = join(root, 'Created', 'Held');
    await mkdir(heldFolder, { recursive: true });
    await held.created(join(root, 'Created'));

    const later = join(heldFolder, 'Later');
    await mkdir(later);

    expect(await writesHeard(join(later, 'Gun.json'))).toBe(true);
  });

  it('hears nothing once closed', async () => {
    const heldFolder = join(root, 'Created', 'Held');
    await mkdir(heldFolder, { recursive: true });
    await held.created(join(root, 'Created'));
    const file = join(heldFolder, 'Gun.json');
    const control = watch(heldFolder);
    const controlHeard = new Promise((r) => { control.once('change', r); });

    held.close();
    await writeFile(file, '{}');
    await controlHeard;
    await new Promise((r) => setImmediate(r));
    control.close();

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

  it.skipIf(process.platform === 'win32')('(Windows has no POSIX mode bits) notes, with why, each folder whose watch failed, and signals the failure', async () => {
    const created = join(root, 'Created');
    await mkdir(join(created, 'Unreadable'), { recursive: true });
    await mkdir(join(created, 'AlsoUnreadable'));
    await chmod(join(created, 'Unreadable'), 0o000);
    await chmod(join(created, 'AlsoUnreadable'), 0o000);

    await held.created(created);
    await chmod(join(created, 'Unreadable'), 0o755);
    await chmod(join(created, 'AlsoUnreadable'), 0o755);

    expect(held.notes()).toEqual([expect.stringMatching(/^Modbench hears no change inside 2 folder\(s\), the first .*Unreadable, whose watch failed: EACCES/)]);
    expect(failures).toBe(2);
  });
});
