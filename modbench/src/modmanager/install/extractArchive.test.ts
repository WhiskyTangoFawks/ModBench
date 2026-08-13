import { describe, it, expect, vi } from 'vitest';
import { extractArchive, defaultRunner } from './extractArchive';

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
    await expect(extractArchive('/tmp/bad.7z', '/tmp/stage', run)).rejects.toMatchObject({
      message: expect.stringMatching(/Failed to extract/),
      cause: underlying,
    });
    expect(run).toHaveBeenCalledTimes(1);
  });
});

describe('defaultRunner', () => {
  it('resolves when the spawned process exits 0', async () => {
    await expect(defaultRunner(process.execPath, ['-e', 'process.exit(0)'])).resolves.toBeUndefined();
  });

  it('rejects with the exit code in the message when the process exits non-zero', async () => {
    await expect(defaultRunner(process.execPath, ['-e', 'process.exit(3)'])).rejects.toThrow(
      /exited with code 3/,
    );
  });

  it('rejects with ENOENT when the binary is absent', async () => {
    await expect(defaultRunner('/definitely-not-a-real-binary-xyz123', [])).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });
});
