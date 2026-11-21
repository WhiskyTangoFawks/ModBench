import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { keptTrusted, readTrustingKept, stampFrom, trustingKept } from '../stampedReads';

const keptByStamp = <T>(read: (path: string) => Promise<T>): ((path: string) => Promise<T>) =>
  keptTrusted(async (path) => stampFrom(await stat(path, { bigint: true })), read);

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

  it('reads every time while the stamp is younger than two seconds, as it may not change for a write that follows', async () => {
    const kept = keptByStamp(read);
    await kept(path);

    expect(await kept(path)).toBe(2);
  });

  it('reads every time while the stamp is younger than two seconds, though it trusts', async () => {
    const kept = keptByStamp(read);
    await kept(path);

    expect(await trustingKept(() => kept(path))).toBe(2);
  });

  it('hands what it keeps without looking at the stamp while it trusts', async () => {
    settle();
    const kept = keptByStamp(read);
    await kept(path);
    await modifiedLater(path);

    expect(await trustingKept(() => kept(path))).toBe(1);
  });

  it.each([['win32', 'holds'], ['linux', 'does not hold']] as const)('on %s %s a path spelled in another case as the one it kept', async (platform, holds) => {
    settle();
    const kept = keptByStamp(read);
    const real = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { value: platform });
    try {
      await kept(path);
      const answer = await trustingKept(() => kept(path.toUpperCase())).then((value) => value, () => 'not kept');

      expect(answer === 1).toBe(holds === 'holds');
    } finally {
      if (real !== undefined) Object.defineProperty(process, 'platform', real);
    }
  });

  it('keeps nothing of a read that rejected', async () => {
    settle();
    const kept = keptByStamp(() => (reads++ === 0 ? Promise.reject(new Error('unreadable')) : Promise.resolve(reads)));
    await expect(kept(path)).rejects.toThrow('unreadable');

    expect(await kept(path)).toBe(2);
  });

  describe('of a file that is not there', () => {
    const absent = (): string => join(root, 'absent.txt');

    it('hands its absence without looking again while it trusts', async () => {
      const kept = keptByStamp(read);
      await expect(kept(absent())).rejects.toMatchObject({ code: 'ENOENT' });
      await writeFile(absent(), 'made');

      await expect(trustingKept(() => kept(absent()))).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await kept(absent())).toBe(1);
    });

    it('reads it once a re-read is named it', async () => {
      const kept = keptByStamp(read);
      await expect(kept(absent())).rejects.toMatchObject({ code: 'ENOENT' });
      await writeFile(absent(), 'made');

      expect((await readTrustingKept([absent()], false, () => kept(absent()))).answer).toBe(1);
    });

    it('answers it as unheard at a check of the disk that finds it made, and not while it is still not there', async () => {
      await readTrustingKept([], true, () => Promise.resolve());
      const kept = keptByStamp(read);
      await expect(kept(absent())).rejects.toMatchObject({ code: 'ENOENT' });

      const stillAbsent = await readTrustingKept([], true, () => Promise.resolve());
      await writeFile(absent(), 'made');
      const made = await readTrustingKept([], true, () => kept(absent()));

      expect([stillAbsent.unheard, made]).toEqual([[], { answer: 1, unheard: [absent()], found: new Map(), unchanged: new Set() }]);
    });
  });
});
