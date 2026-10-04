import { describe, it, expect } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { digestOf } from '../contentDigest';

describe('digestOf', () => {
  it('answers the SHA-256 of the file\'s bytes as lower-case hex, so two files with one digest hold the same bytes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'medit-digest-'));
    try {
      const path = join(root, 'a.esp');
      await writeFile(path, 'abc');
      expect(await digestOf(path)).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects with the reason when the file cannot be read, so the caller answers the reason', async () => {
    await expect(digestOf(join(tmpdir(), 'medit-digest-missing', 'none.dds'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
