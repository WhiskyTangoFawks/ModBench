import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { copyFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
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
  const FAKE_7Z = process.platform === 'win32' ? '7z.exe' : '7z';
  let bin: string;
  let originalPath: string | undefined;
  let originalNodeOptions: string | undefined;

  beforeAll(async () => {
    bin = await mkdtemp(join(tmpdir(), 'fake-7z-'));
    await copyFile(process.execPath, join(bin, FAKE_7Z));
    await writeFile(join(bin, 'exit-as-asked.cjs'), 'process.exit(Number(process.env.FAKE_7Z_EXIT));');
  });
  afterAll(() => rm(bin, { recursive: true, force: true }));
  beforeEach(() => {
    originalPath = process.env.PATH;
    originalNodeOptions = process.env.NODE_OPTIONS;
    process.env.PATH = bin;
  });
  afterEach(() => {
    process.env.PATH = originalPath;
    if (originalNodeOptions === undefined) delete process.env.NODE_OPTIONS;
    else process.env.NODE_OPTIONS = originalNodeOptions;
    delete process.env.FAKE_7Z_EXIT;
  });

  const fakeNodeAs7zPreloadedToExit = (code: number) => {
    process.env.FAKE_7Z_EXIT = String(code);
    process.env.NODE_OPTIONS = `--require=${JSON.stringify(join(bin, 'exit-as-asked.cjs'))}`;
  };

  it('resolves when the binary exits 0', async () => {
    fakeNodeAs7zPreloadedToExit(0);

    await expect(extractArchive('/tmp/mod.7z', '/tmp/stage')).resolves.toBeUndefined();
  });

  it('rejects with the exit code in the message when the binary exits non-zero', async () => {
    fakeNodeAs7zPreloadedToExit(3);

    await expect(extractArchive('/tmp/mod.7z', '/tmp/stage')).rejects.toThrow(/exited with code 3/);
  });

  it('names every candidate when no binary is on the path', async () => {
    process.env.PATH = '';

    await expect(extractArchive('/tmp/mod.7z', '/tmp/stage')).rejects.toThrow(/No 7z binary found/);
  });
});
