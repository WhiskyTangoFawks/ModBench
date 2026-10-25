import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ModFolder } from '../../instanceAdapter';
import { renameFolderWithManifest } from '../mo2Context';

const failing = vi.hoisted(() => ({ endings: [] as string[] }));

vi.mock('../../files', async (importOriginal) => {
  const files = await importOriginal<typeof import('../../files')>();
  return {
    ...files,
    rename: (from: string, to: string) =>
      (failing.endings.some((ending) => to.endsWith(ending)) ? Promise.reject(new Error(`EBUSY: ${to}`)) : files.rename(from, to)),
  };
});

describe('a mod folder renamed with its manifest', () => {
  let root: string;
  let from: ModFolder;
  let toPath: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'medit-rename-'));
    from = { kind: 'mod', name: 'Old', path: join(root, 'Old'), modName: 'Old' };
    toPath = join(root, 'New');
    await mkdir(from.path);
    await writeFile(join(from.path, 'Old.manifest.json'), '');
    failing.endings = [];
  });

  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  it.each([
    ['puts the folder back, and rejects with why the manifest could not be renamed', ['New.manifest.json'],
      () => `EBUSY: ${join(toPath, 'New.manifest.json')}`, ['Old']],
    ['names why the manifest could not be renamed and that the folder sits under its new name because putting it back failed', ['New.manifest.json', 'Old'],
      () => `EBUSY: ${join(toPath, 'New.manifest.json')}; the folder now sits at ${toPath} because putting it back failed: EBUSY: ${from.path}`, ['New']],
  ])('%s', async (_case, endings, message, left) => {
    failing.endings = endings;

    await expect(renameFolderWithManifest(from, toPath, 'New')).rejects.toThrow(new Error(message()));

    expect(await readdir(root)).toEqual(left);
  });
});
