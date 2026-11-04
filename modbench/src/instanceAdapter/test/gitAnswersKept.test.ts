import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { filesHeldByGit } from '../filesHeldByGit';
import { foldersHeldWhole } from '../foldersHeldWhole';
import { git as spawnedGit, gitFed as spawnedGitFed } from '../git';

vi.mock('../git', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../git')>();
  return { ...actual, git: vi.fn(actual.git), gitFed: vi.fn(actual.gitFed) };
});

const HOUR_MS = 3_600_000;
const run = (cwd: string, ...args: string[]): void => {
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd });
};
const spawns = (): number => vi.mocked(spawnedGit).mock.calls.length + vi.mocked(spawnedGitFed).mock.calls.length;

let laterEachTimeMs = 0;
const modifiedLater = async (path: string): Promise<void> => {
  laterEachTimeMs += 10_000;
  const later = new Date((await stat(path)).mtimeMs + laterEachTimeMs);
  await utimes(path, later, later);
};

describe('the answers git gives about the mod folders, kept while nothing they depend on has changed', () => {
  let root: string;
  let mod: string;
  let other: string;
  const heldIn = async (folder: string): Promise<string[]> => [...(await filesHeldByGit(root, [folder])).get(folder) ?? []].sort();

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'modbench-git-kept-'));
    mod = join(root, 'mods', 'ModA');
    other = join(root, 'mods', 'ModB');
    await mkdir(join(mod, 'sub'), { recursive: true });
    await mkdir(other, { recursive: true });
    await writeFile(join(root, '.gitignore'), '/mods/*\n!/mods/ModA/\n!/mods/ModB/\n');
    await writeFile(join(mod, 'a.esp'), 'a');
    await writeFile(join(mod, 'sub', 'b.nif'), 'b');
    await writeFile(join(other, 'c.esp'), 'c');
    run(root, 'init', '-q');
    run(root, 'add', '-A');
    run(root, 'commit', '-q', '-m', 'one');
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + HOUR_MS });
    vi.mocked(spawnedGit).mockClear();
    vi.mocked(spawnedGitFed).mockClear();
  });

  afterEach(async () => {
    vi.useRealTimers();
    await rm(root, { recursive: true, force: true });
  });

  it('lists the files git holds once while nothing changed', async () => {
    await filesHeldByGit(root, [mod, other]);
    const spawnedBefore = spawns();

    expect([...(await filesHeldByGit(root, [mod, other])).get(mod) ?? []].sort()).toEqual(['a.esp', 'sub/b.nif']);
    expect(spawns()).toBe(spawnedBefore);
  });

  it('tells the folders git holds whole once while nothing changed', async () => {
    await foldersHeldWhole(root, [mod, other]);
    const spawnedBefore = spawns();

    expect((await foldersHeldWhole(root, [mod, other])).has(mod)).toBe(true);
    expect(spawns()).toBe(spawnedBefore);
  });

  it('shows a new file in a folder below once that folder\'s stamp changes', async () => {
    await heldIn(mod);
    await writeFile(join(mod, 'sub', 'new.nif'), 'n');
    await modifiedLater(join(mod, 'sub'));

    expect(await heldIn(mod)).toEqual(['a.esp', 'sub/b.nif', 'sub/new.nif']);
  });

  it('follows an ignore file inside the mod, whether it is added or edited', async () => {
    await writeFile(join(mod, 'new.txt'), 'n');
    await modifiedLater(mod);
    const listedNew = await heldIn(mod);
    await writeFile(join(mod, '.gitignore'), 'new.txt\n');
    await modifiedLater(mod);
    const listedIgnoring = await heldIn(mod);
    await writeFile(join(mod, '.gitignore'), '');
    await modifiedLater(join(mod, '.gitignore'));

    expect({ listedNew, listedIgnoring, listedEdited: await heldIn(mod) }).toEqual({
      listedNew: ['a.esp', 'new.txt', 'sub/b.nif'],
      listedIgnoring: ['.gitignore', 'a.esp', 'sub/b.nif'],
      listedEdited: ['.gitignore', 'a.esp', 'new.txt', 'sub/b.nif'],
    });
  });

  it('leaves a folder out of those held whole once an ignore file above it leaves it out', async () => {
    await foldersHeldWhole(root, [mod]);
    await writeFile(join(root, 'mods', '.gitignore'), 'ModA/\n');
    await modifiedLater(join(root, 'mods'));

    expect((await foldersHeldWhole(root, [mod])).has(mod)).toBe(false);
  });

  it('lists again for other folders asked', async () => {
    await heldIn(mod);

    expect(await heldIn(other)).toEqual(['c.esp']);
  });
});
