import { describe, it, expect } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { digestOf } from '../contentDigest';

describe('digestOf', () => {
  it.each([
    ['hello', 'o22fiH2CxyY='],
    ['kept', 'gO3vE0ddOto='],
    ['vanilla', '/Qk9lLVYbZs='],
  ])('answers the hash of %s that mEdit\'s manifest carries: xxHash64, its eight little-endian bytes in base64', async (body, hash) => {
    const root = await mkdtemp(join(tmpdir(), 'medit-digest-'));
    try {
      const path = join(root, 'a.esp');
      await writeFile(path, body);
      expect(await digestOf(path)).toBe(hash);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects with the reason when the file cannot be read, so the caller answers the reason', async () => {
    await expect(digestOf(join(tmpdir(), 'medit-digest-missing', 'none.dds'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
