import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scanDownloads } from '../downloadsScan';

describe('scanDownloads', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'medit-downloads-scan-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('reads no downloads/ folder as no downloads, not a failure', async () => {
    expect(await scanDownloads(root)).toBeUndefined();
  });

  it('lists a file directly in downloads/', async () => {
    await mkdir(join(root, 'downloads'), { recursive: true });
    await writeFile(join(root, 'downloads', 'ArmorPack-1-0.zip'), 'bytes');

    const entries = await scanDownloads(root);

    expect(entries?.map((e) => e.name)).toEqual(['ArmorPack-1-0.zip']);
  });

  // Rival this catches: the scan keeps `dirent.name` alone, dropping `isDirectory()`.
  it('never lists a subfolder, even one named like an archive', async () => {
    await mkdir(join(root, 'downloads', 'ArmorPack.zip'), { recursive: true });
    await writeFile(join(root, 'downloads', 'ArmorPack.zip', 'payload.esp'), 'bytes');
    await writeFile(join(root, 'downloads', 'Real-1-0.zip'), 'bytes');

    const entries = await scanDownloads(root);

    expect(entries?.map((e) => e.name)).toEqual(['Real-1-0.zip']);
  });
});
