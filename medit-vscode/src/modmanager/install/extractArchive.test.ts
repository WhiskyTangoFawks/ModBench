import { describe, it, expect, vi } from 'vitest';
import { extractArchive } from './extractArchive';

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

  it('throws an actionable error when no 7z binary exists', async () => {
    const run = vi.fn().mockRejectedValue(enoent());
    await expect(extractArchive('/tmp/mod.7z', '/tmp/stage', run)).rejects.toThrow(/p7zip-full/);
  });

  it('throws (does not try other binaries) when a spawned extraction fails', async () => {
    const run = vi.fn().mockRejectedValue(new Error('7z exited with code 2'));
    await expect(extractArchive('/tmp/bad.7z', '/tmp/stage', run)).rejects.toThrow(/Failed to extract/);
    expect(run).toHaveBeenCalledTimes(1);
  });
});
