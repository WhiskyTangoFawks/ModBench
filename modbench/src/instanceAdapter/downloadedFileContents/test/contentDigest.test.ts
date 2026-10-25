import { describe, it, expect } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { digestOf, md5Of } from '../contentDigest';

describe('a file\'s hash, as mEdit\'s manifest carries it', () => {
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

describe('a file\'s MD5', () => {
  it.each([
    ['', 'd41d8cd98f00b204e9800998ecf8427e'],
    ['hello', '5d41402abc4b2a76b9719d911017c592'],
  ])('answers the hex MD5 of %j', async (body, md5) => {
    const root = await mkdtemp(join(tmpdir(), 'medit-md5-'));
    try {
      const path = join(root, 'a.7z');
      await writeFile(path, body);
      expect(await md5Of(path)).toBe(md5);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
