import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { keptByIndex } from '../keptByIndex';

const HOUR_MS = 3_600_000;
const git = (folder: string, ...args: string[]): void => {
  execFileSync('git', ['-C', folder, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args]);
};

let laterEachTimeMs = 0;
const modifiedLater = async (path: string): Promise<void> => {
  laterEachTimeMs += 10_000;
  const later = new Date((await stat(path)).mtimeMs + laterEachTimeMs);
  await utimes(path, later, later);
};

describe('what git answers from the index and .gitmodules, kept while both keep their stamps', () => {
  let root: string;
  let reads: number;
  const read = (): Promise<number> => Promise.resolve(++reads);

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'modbench-kept-by-index-'));
    reads = 0;
    git(root, 'init', '-q', '-b', 'main');
    await writeFile(join(root, 'a.txt'), 'a');
    git(root, 'add', '.');
    git(root, 'commit', '-q', '-m', 'one');
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + HOUR_MS });
  });

  afterEach(async () => {
    vi.useRealTimers();
    await rm(root, { recursive: true, force: true });
  });

  it('reads once while neither file has changed', async () => {
    const kept = keptByIndex<number>();
    await kept(root, 'answer', read);

    expect(await kept(root, 'answer', read)).toBe(1);
  });

  it('keeps each key\'s answer apart', async () => {
    const kept = keptByIndex<number>();
    await kept(root, 'one', read);

    expect(await kept(root, 'two', read)).toBe(2);
  });

  it('reads again once the index has changed', async () => {
    const kept = keptByIndex<number>();
    await kept(root, 'answer', read);
    await modifiedLater(join(root, '.git', 'index'));

    expect(await kept(root, 'answer', read)).toBe(2);
  });

  it('reads again once .gitmodules appears, and once it changes', async () => {
    const kept = keptByIndex<number>();
    await kept(root, 'answer', read);
    await writeFile(join(root, '.gitmodules'), '');
    const appeared = await kept(root, 'answer', read);
    await modifiedLater(join(root, '.gitmodules'));

    expect([appeared, await kept(root, 'answer', read)]).toEqual([2, 3]);
  });

  it('follows the index of a linked worktree, which is in the git directory its .git file names', async () => {
    const linked = join(root, 'linked');
    git(root, 'worktree', 'add', '-q', '-b', 'side', linked);
    const kept = keptByIndex<number>();
    await kept(linked, 'answer', read);
    const [gitDir] = execFileSync('git', ['-C', linked, 'rev-parse', '--absolute-git-dir'], { encoding: 'utf8' }).split('\n');
    await modifiedLater(join(gitDir ?? '', 'index'));

    expect(await kept(linked, 'answer', read)).toBe(2);
  });

  it('keeps no answer whose read rejected', async () => {
    const kept = keptByIndex<number>();
    await expect(kept(root, 'answer', () => Promise.reject(new Error('git failed')))).rejects.toThrow('git failed');

    expect(await kept(root, 'answer', read)).toBe(1);
  });
});
