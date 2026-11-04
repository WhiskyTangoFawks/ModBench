import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { link, mkdtemp, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { keptByStamp } from '../stampedReads';

const HOUR_MS = 3_600_000;

let laterEachTimeMs = 0;
const modifiedLater = async (path: string): Promise<void> => {
  laterEachTimeMs += 10_000;
  const later = new Date((await stat(path)).mtimeMs + laterEachTimeMs);
  await utimes(path, later, later);
};

describe('a read kept by the stamp of its file', () => {
  let root: string;
  let path: string;
  let reads: number;
  const read = (): Promise<number> => Promise.resolve(++reads);

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'modbench-kept-by-stamp-'));
    path = join(root, 'file.txt');
    await writeFile(path, 'one');
    reads = 0;
  });

  afterEach(async () => {
    vi.useRealTimers();
    await rm(root, { recursive: true, force: true });
  });

  const settle = (): void => {
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + HOUR_MS });
  };

  it('reads once while the stamp has not changed', async () => {
    settle();
    const kept = keptByStamp(read);
    await kept(path);

    expect(await kept(path)).toBe(1);
  });

  it('reads again once the stamp has changed', async () => {
    settle();
    const kept = keptByStamp(read);
    await kept(path);
    await modifiedLater(path);

    expect(await kept(path)).toBe(2);
  });

  it('reads again a file another tool rewrote keeping its size and date modified, which changes its time of change', async () => {
    settle();
    const kept = keptByStamp(read);
    const { atime, mtime } = await stat(path);
    await kept(path);
    await writeFile(path, 'two');
    await utimes(path, atime, mtime);

    expect(await kept(path)).toBe(2);
  });

  it('reads every time while the stamp is younger than two seconds, as it may not change for a write that follows', async () => {
    const kept = keptByStamp(read);
    await kept(path);

    expect(await kept(path)).toBe(2);
  });

  it('hands what it keeps without looking at the stamp while it trusts', async () => {
    settle();
    let trusting = false;
    const kept = keptByStamp(read, { trusts: () => trusting });
    await kept(path);
    await modifiedLater(path);
    trusting = true;

    expect(await kept(path)).toBe(1);
  });

  it('keeps two paths under one key as one', async () => {
    settle();
    const other = join(root, 'other.txt');
    await link(path, other);
    const kept = keptByStamp(read, { keyOf: () => 'same' });
    await kept(path);

    expect(await kept(other)).toBe(1);
  });

  it('keeps nothing of a read that rejected', async () => {
    settle();
    const kept = keptByStamp(() => (reads++ === 0 ? Promise.reject(new Error('unreadable')) : Promise.resolve(reads)));
    await expect(kept(path)).rejects.toThrow('unreadable');

    expect(await kept(path)).toBe(2);
  });
});
