import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { watch } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { heldFolderWatch, type HeldFolderWatch } from '../heldFolders';

describe('heldFolderWatch', () => {
  let root: string;
  let heard: string[];
  let held: HeldFolderWatch;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'held-folders-'));
    heard = [];
    held = heldFolderWatch((path) => { heard.push(path); });
  });

  afterEach(async () => {
    held.dispose();
    await rm(root, { recursive: true, force: true });
  });

  const hearsWrites = async (file: string): Promise<void> => {
    const deadline = Date.now() + 2_000;
    while (!heard.includes(file)) {
      if (Date.now() > deadline) throw new Error(`timed out hearing ${file}; heard ${JSON.stringify(heard)}`);
      await writeFile(file, `${Date.now()}`);
      await new Promise((r) => setTimeout(r, 20));
    }
  };

  it('hears a change to a file in a folder, at any depth, that a created folder already held', async () => {
    const deep = join(root, 'Created', 'Held', 'Deeper');
    await mkdir(deep, { recursive: true });
    const file = join(deep, 'Gun.json');
    await writeFile(file, '{}');

    await held.created(join(root, 'Created'));
    await writeFile(file, '{ }');

    await hearsWrites(file);
  });

  it('hears a change in a folder made later inside a held folder', async () => {
    const heldFolder = join(root, 'Created', 'Held');
    await mkdir(heldFolder, { recursive: true });
    await held.created(join(root, 'Created'));

    const later = join(heldFolder, 'Later');
    await mkdir(later);

    await hearsWrites(join(later, 'Gun.json'));
  });

  it('hears nothing once disposed', async () => {
    const heldFolder = join(root, 'Created', 'Held');
    await mkdir(heldFolder, { recursive: true });
    await held.created(join(root, 'Created'));
    const file = join(heldFolder, 'Gun.json');
    const control = watch(heldFolder);
    const controlHeard = new Promise((r) => { control.once('change', r); });

    held.dispose();
    await writeFile(file, '{}');
    await controlHeard;
    await new Promise((r) => setImmediate(r));
    control.close();

    expect(heard).toEqual([]);
  });
});
