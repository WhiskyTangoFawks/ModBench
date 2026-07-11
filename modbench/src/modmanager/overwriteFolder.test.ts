import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { countOverwriteFiles } from './overwriteFolder';

describe('countOverwriteFiles', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'medit-overwrite-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('returns 0 for an absent folder', async () => {
    expect(await countOverwriteFiles(join(dir, 'does-not-exist'))).toBe(0);
  });

  it('returns 0 for an empty folder', async () => {
    expect(await countOverwriteFiles(dir)).toBe(0);
  });

  it('counts files recursively', async () => {
    await writeFile(join(dir, 'f4se.log'), 'x');
    await mkdir(join(dir, 'F4SE'), { recursive: true });
    await writeFile(join(dir, 'F4SE', 'plugin.log'), 'y');
    await mkdir(join(dir, 'MCM', 'Settings'), { recursive: true });
    await writeFile(join(dir, 'MCM', 'Settings', 'mod.ini'), 'z');
    expect(await countOverwriteFiles(dir)).toBe(3);
  });

  it('ignores empty subdirectories', async () => {
    await mkdir(join(dir, 'empty-sub'), { recursive: true });
    expect(await countOverwriteFiles(dir)).toBe(0);
  });
});
