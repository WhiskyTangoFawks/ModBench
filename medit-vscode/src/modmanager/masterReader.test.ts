import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readMasters } from './masterReader';
import { buildTes4Buffer } from './test/buildTes4Buffer';

describe('readMasters', () => {
  let dir: string;

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  async function writeFixture(buf: Buffer): Promise<string> {
    dir = await mkdtemp(join(tmpdir(), 'medit-masterreader-'));
    const path = join(dir, 'Test.esp');
    await writeFile(path, buf);
    return path;
  }

  it('extracts multiple masters in file order', async () => {
    const path = await writeFixture(buildTes4Buffer(['Fallout4.esm', 'DLCRobot.esm']));
    expect(await readMasters(path)).toEqual(['Fallout4.esm', 'DLCRobot.esm']);
  });

  it('returns an empty array for a master-less plugin', async () => {
    const path = await writeFixture(buildTes4Buffer([]));
    expect(await readMasters(path)).toEqual([]);
  });

  it('tolerates a DATA subrecord following a MAST without misreading it as a master', async () => {
    const path = await writeFixture(
      buildTes4Buffer(['Fallout4.esm', 'DLCRobot.esm'], { dataAfterFirstMaster: true }),
    );
    expect(await readMasters(path)).toEqual(['Fallout4.esm', 'DLCRobot.esm']);
  });

  it('throws when the file does not start with a TES4 signature', async () => {
    dir = await mkdtemp(join(tmpdir(), 'medit-masterreader-'));
    const path = join(dir, 'NotAPlugin.esp');
    await writeFile(path, Buffer.alloc(24));
    await expect(readMasters(path)).rejects.toThrow(/TES4/);
  });
});
