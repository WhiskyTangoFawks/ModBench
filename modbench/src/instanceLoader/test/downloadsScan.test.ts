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

  it('reads an absent folder as no downloads, not a failure', async () => {
    expect(await scanDownloads(join(root, 'downloads'))).toBeUndefined();
  });

  it('lists a file directly in the given folder', async () => {
    const downloadsDir = join(root, 'downloads');
    await mkdir(downloadsDir, { recursive: true });
    await writeFile(join(downloadsDir, 'ArmorPack-1-0.zip'), 'bytes');

    const entries = await scanDownloads(downloadsDir);

    expect(entries?.map((e) => e.name)).toEqual(['ArmorPack-1-0.zip']);
  });

  // Rival this catches: the scan keeps `dirent.name` alone, dropping `isDirectory()`.
  it('never lists a subfolder, even one named like an archive', async () => {
    const downloadsDir = join(root, 'downloads');
    await mkdir(join(downloadsDir, 'ArmorPack.zip'), { recursive: true });
    await writeFile(join(downloadsDir, 'ArmorPack.zip', 'payload.esp'), 'bytes');
    await writeFile(join(downloadsDir, 'Real-1-0.zip'), 'bytes');

    const entries = await scanDownloads(downloadsDir);

    expect(entries?.map((e) => e.name)).toEqual(['Real-1-0.zip']);
  });

  // downloads.md, Which files are rows, story 1: a folder MO2's configuration points at, even
  // when it lies entirely outside the instance the caller happens to be scanning.
  it('lists a folder outside any instance root, since the scan takes it as given', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'medit-downloads-outside-'));
    try {
      await writeFile(join(outside, 'External.7z'), 'bytes');

      const entries = await scanDownloads(outside);

      expect(entries?.map((e) => e.name)).toEqual(['External.7z']);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});
