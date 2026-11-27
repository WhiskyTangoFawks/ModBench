import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fakeVscodeModule } from '../../../test/mo2/fakeVscodeWatcher';
import { adapterOver } from '../../../test/mo2/adapterOver';
import { instanceOnDisk } from '../../test/instanceOnDisk';

vi.mock('vscode', () => fakeVscodeModule());

let root: string;
let instance: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'within-'));
  await mkdir(join(root, 'Fallout4', 'Data'), { recursive: true });
  await mkdir(join(root, 'Fallout4 deployed'));
  instance = await instanceOnDisk();
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
  await rm(instance, { recursive: true, force: true });
});

describe('the game folder a folder overlaps', () => {
  const overlapping = (folder: string, gameFolderSettingValue = join(root, 'Fallout4')): Promise<string | undefined> =>
    adapterOver(instance, { gameFolderSettingValue }).gameFolderOverlapping(folder);

  it.each([['is it', 'Fallout4'], ['holds it', '.'], ['sits inside it', 'Fallout4/Data']])('is the game root when the folder %s', async (_case, folder) => {
    expect(await overlapping(join(root, folder))).toBe(join(root, 'Fallout4'));
  });

  it('is the game root for a folder reached through a link into it', async () => {
    await symlink(join(root, 'Fallout4'), join(root, 'link'));

    expect(await overlapping(join(root, 'link', 'Data'))).toBe(join(root, 'Fallout4'));
  });

  it('is none for a folder beside it whose name starts with its name, and for a game folder not found', async () => {
    expect([await overlapping(join(root, 'Fallout4 deployed')), await overlapping(root, join(root, 'nowhere'))]).toEqual([undefined, undefined]);
  });
});
