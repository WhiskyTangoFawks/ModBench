import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { trashingReplaced } from '../trashingReplaced';

let folder: string;
let inTrash: Record<string, string>;
const trash = async (path: string): Promise<void> => { inTrash[relative(folder, path)] = await readFile(path, 'utf8'); await rm(path); };
const refusing = (): Promise<void> => Promise.reject(new Error('EBUSY'));

beforeEach(async () => {
  folder = await mkdtemp(join(tmpdir(), 'modbench-trashing-replaced-'));
  inTrash = {};
  await mkdir(join(folder, 'textures'));
  await writeFile(join(folder, 'Mod.esp'), 'mine');
  await writeFile(join(folder, 'textures', 'a.dds'), 'my texture');
});
afterEach(() => rm(folder, { recursive: true, force: true }));

const filesIn = async (): Promise<string[]> =>
  (await readdir(folder, { recursive: true, withFileTypes: true })).filter((entry) => entry.isFile()).map((entry) => relative(folder, join(entry.parentPath, entry.name))).sort();

describe('trashing what a write may replace', () => {
  it('sends each file to the trash from its own path before the write runs, keeps a copy in its place, and answers what the write answered', async () => {
    const write = vi.fn(async () => ({
      trashed: { ...inTrash }, held: await Promise.all(['Mod.esp', join('textures', 'a.dds')].map((path) => readFile(join(folder, path), 'utf8'))),
    }));

    const ran = await trashingReplaced(folder, ['Mod.esp', 'textures/a.dds', 'gone.txt'], trash, write);

    expect(ran).toEqual({ answer: { trashed: { 'Mod.esp': 'mine', [join('textures', 'a.dds')]: 'my texture' }, held: ['mine', 'my texture'] } });
    expect(await filesIn()).toEqual(['Mod.esp', join('textures', 'a.dds')].sort());
  });

  it('runs no write when the trash refuses a file, names it, and leaves it in place with no copy beside it', async () => {
    const write = vi.fn(() => Promise.resolve('written'));

    const ran = await trashingReplaced(folder, ['Mod.esp'], refusing, write);

    expect([ran, write.mock.calls, await filesIn(), await readFile(join(folder, 'Mod.esp'), 'utf8')])
      .toEqual([{ notTrashed: "'Mod.esp' could not be moved to the trash: EBUSY" }, [], ['Mod.esp', join('textures', 'a.dds')].sort(), 'mine']);
  });
});
