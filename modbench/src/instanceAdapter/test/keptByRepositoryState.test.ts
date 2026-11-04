import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, utimes, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { keptByRepositoryState } from '../keptByRepositoryState';

const HOUR_MS = 3_600_000;
const git = (folder: string, ...args: string[]): string =>
  execFileSync('git', ['-C', folder, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { encoding: 'utf8' });

let laterEachTimeMs = 0;
const modifiedLater = async (path: string): Promise<void> => {
  laterEachTimeMs += 10_000;
  const later = new Date((await stat(path)).mtimeMs + laterEachTimeMs);
  await utimes(path, later, later);
};

describe('a git answer kept while the repository\'s state files are unchanged', () => {
  let root: string;
  let reads: number;
  const read = (): Promise<number> => Promise.resolve(++reads);

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'medit-kept-'));
    reads = 0;
    git(root, 'init', '-q', '-b', 'main');
    await writeFile(join(root, 'a.txt'), 'a');
    git(root, 'add', '.');
    git(root, 'commit', '-q', '-m', 'one');
  });

  afterEach(async () => {
    vi.useRealTimers();
    await rm(root, { recursive: true, force: true });
  });

  const settle = (): void => {
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + HOUR_MS });
  };

  it('reads once while nothing changed', async () => {
    settle();
    const keptAnswer = keptByRepositoryState<number>();
    const kept = (key: string, read: () => Promise<number>, args?: readonly string[]): Promise<number> => keptAnswer(root, key, read, args);
    await kept('answer', read);

    expect(await kept('answer', read)).toBe(1);
  });

  it.each([
    ['the index', '.git/index'],
    ['HEAD', '.git/HEAD'],
    ['the ref HEAD names', '.git/refs/heads/main'],
    ['the packed refs', '.git/packed-refs'],
    ['info/exclude', '.git/info/exclude'],
    ['the root .gitignore', '.gitignore'],
  ])('reads again once %s has changed', async (_, file) => {
    await writeFile(join(root, file), 'x', { flag: 'a' });
    settle();
    const keptAnswer = keptByRepositoryState<number>();
    const kept = (key: string, read: () => Promise<number>, args?: readonly string[]): Promise<number> => keptAnswer(root, key, read, args);
    await kept('answer', read);
    await modifiedLater(join(root, file));

    expect(await kept('answer', read)).toBe(2);
  });

  it('reads again when a state file appears', async () => {
    settle();
    const keptAnswer = keptByRepositoryState<number>();
    const kept = (key: string, read: () => Promise<number>, args?: readonly string[]): Promise<number> => keptAnswer(root, key, read, args);
    await kept('answer', read);
    await writeFile(join(root, '.gitignore'), '*.log');

    expect(await kept('answer', read)).toBe(2);
  });

  it('reads the file a linked worktree\'s HEAD names, and the packed refs, in the common directory', async () => {
    const linked = join(root, 'linked');
    git(root, 'worktree', 'add', '-q', '-b', 'side', linked);
    const common = join(root, '.git');
    await writeFile(join(common, 'packed-refs'), '');
    settle();
    const keptAnswer = keptByRepositoryState<number>();
    const kept = (key: string, read: () => Promise<number>, args?: readonly string[]): Promise<number> => keptAnswer(linked, key, read, args);
    await kept('answer', read);

    await modifiedLater(join(common, 'refs', 'heads', 'side'));
    expect(await kept('answer', read)).toBe(2);

    await modifiedLater(join(common, 'packed-refs'));
    expect(await kept('answer', read)).toBe(3);
  });

  it('does not trust a stamp younger than two seconds', async () => {
    const keptAnswer = keptByRepositoryState<number>();
    const kept = (key: string, read: () => Promise<number>, args?: readonly string[]): Promise<number> => keptAnswer(root, key, read, args);
    await kept('answer', read);

    expect(await kept('answer', read)).toBe(2);
  });

  it('keeps each key\'s answer apart', async () => {
    settle();
    const keptAnswer = keptByRepositoryState<number>();
    const kept = (key: string, read: () => Promise<number>, args?: readonly string[]): Promise<number> => keptAnswer(root, key, read, args);
    await kept('one', read);

    expect(await kept('two', read)).toBe(2);
  });

  it('reads again for the same key handed other arguments', async () => {
    settle();
    const keptAnswer = keptByRepositoryState<number>();
    const kept = (key: string, read: () => Promise<number>, args?: readonly string[]): Promise<number> => keptAnswer(root, key, read, args);
    await kept('answer', read, ['a']);

    expect(await kept('answer', read, ['b'])).toBe(2);
  });

  it('keeps no answer that rejected', async () => {
    settle();
    const keptAnswer = keptByRepositoryState<number>();
    const kept = (key: string, read: () => Promise<number>, args?: readonly string[]): Promise<number> => keptAnswer(root, key, read, args);
    await expect(kept('answer', () => Promise.reject(new Error('git failed')))).rejects.toThrow('git failed');

    expect(await kept('answer', read)).toBe(1);
  });
});
