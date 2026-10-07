import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extractArchive } from '../extractArchive';

const enoent = () => Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' });

describe('extractArchive', () => {
  it('runs the first available binary with 7z extract args', async () => {
    const run = vi.fn().mockResolvedValue(undefined);
    await extractArchive('/tmp/mod.7z', '/tmp/stage', run);
    expect(run).toHaveBeenCalledWith('7z', ['x', '/tmp/mod.7z', '-o/tmp/stage', '-y']);
  });

  it('falls through to the next binary name when one is absent', async () => {
    const run = vi.fn().mockRejectedValueOnce(enoent()).mockResolvedValueOnce(undefined);
    await extractArchive('/tmp/mod.7z', '/tmp/stage', run);
    expect(run).toHaveBeenNthCalledWith(2, '7za', expect.any(Array));
  });

  it('throws an actionable error naming every candidate when no 7z binary exists', async () => {
    const run = vi.fn().mockRejectedValue(enoent());
    await expect(extractArchive('/tmp/mod.7z', '/tmp/stage', run)).rejects.toThrow(
      /No 7z binary found \(tried 7z, 7za, 7zz\)\..*p7zip-full/,
    );
  });

  it('throws (does not try other binaries) when a spawned extraction fails, preserving the cause', async () => {
    const underlying = new Error('7z exited with code 2');
    const run = vi.fn().mockRejectedValue(underlying);
    const rejection: unknown = await extractArchive('/tmp/bad.7z', '/tmp/stage', run).catch((e: unknown) => e);
    if (!(rejection instanceof Error)) throw new Error('expected extractArchive to reject with an Error');
    expect(rejection.message).toMatch(/Failed to extract/);
    expect(rejection.cause).toBe(underlying);
    expect(run).toHaveBeenCalledTimes(1);
  });
});

describe('extractArchive, spawning the binary itself', () => {
  let bin: string;
  let originalPath: string | undefined;
  beforeEach(async () => {
    bin = await mkdtemp(join(tmpdir(), 'fake-7z-'));
    originalPath = process.env.PATH;
    process.env.PATH = bin;
  });
  afterEach(async () => {
    process.env.PATH = originalPath;
    await rm(bin, { recursive: true, force: true });
  });
  const installFake7z = (exitCode: number) => writeFile(join(bin, '7z'), `#!/bin/sh\nexit ${exitCode}\n`, { mode: 0o755 });

  it.skipIf(process.platform === 'win32')('resolves when the binary exits 0', async () => {
    await installFake7z(0);

    await expect(extractArchive('/tmp/mod.7z', '/tmp/stage')).resolves.toBeUndefined();
  });

  it.skipIf(process.platform === 'win32')('rejects with the exit code in the message when the binary exits non-zero', async () => {
    await installFake7z(3);

    await expect(extractArchive('/tmp/mod.7z', '/tmp/stage')).rejects.toThrow(/exited with code 3/);
  });

  it('names every candidate when no binary is on the path', async () => {
    await expect(extractArchive('/tmp/mod.7z', '/tmp/stage')).rejects.toThrow(/No 7z binary found/);
  });
});
