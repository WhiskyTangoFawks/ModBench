import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detectRoot } from './detectRoot';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'detect-root-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** Create files/dirs under `dir` from forward-slash relative paths (trailing / = dir). */
async function scaffold(...paths: string[]): Promise<void> {
  for (const p of paths) {
    if (p.endsWith('/')) {
      await mkdir(join(dir, p), { recursive: true });
    } else {
      await mkdir(join(dir, p, '..'), { recursive: true });
      await writeFile(join(dir, p), '');
    }
  }
}

describe('detectRoot', () => {
  it('points at the Data subfolder when the archive has a Data root', async () => {
    await scaffold('Data/foo.esp', 'Data/meshes/x.nif');
    expect(await detectRoot(dir)).toEqual({ sourceDir: join(dir, 'Data'), isFomod: false });
  });

  it('treats the staging root as the source when files sit at root', async () => {
    await scaffold('foo.esp', 'meshes/x.nif');
    expect(await detectRoot(dir)).toEqual({ sourceDir: dir, isFomod: false });
  });

  it('descends through a single wrapper folder before deciding', async () => {
    await scaffold('MyMod-Main/foo.esp', 'MyMod-Main/textures/x.dds');
    expect(await detectRoot(dir)).toEqual({ sourceDir: join(dir, 'MyMod-Main'), isFomod: false });
  });

  it('descends a wrapper folder and still finds the inner Data folder', async () => {
    await scaffold('MyMod-Main/Data/foo.esp');
    expect(await detectRoot(dir)).toEqual({
      sourceDir: join(dir, 'MyMod-Main', 'Data'),
      isFomod: false,
    });
  });

  it('does not peel a lone top-level game data folder (e.g. meshes)', async () => {
    await scaffold('meshes/x.nif');
    expect(await detectRoot(dir)).toEqual({ sourceDir: dir, isFomod: false });
  });

  it('flags a FOMOD but still returns a usable source dir', async () => {
    await scaffold('fomod/ModuleConfig.xml', '00 Core/Data/foo.esp', '01 Textures 2K/textures/x.dds');
    expect(await detectRoot(dir)).toEqual({ sourceDir: dir, isFomod: true });
  });

  it('detects a wrapped FOMOD case-insensitively', async () => {
    await scaffold('MyMod/fomod/moduleconfig.xml', 'MyMod/00 Core/foo.esp');
    expect(await detectRoot(dir)).toEqual({ sourceDir: join(dir, 'MyMod'), isFomod: true });
  });
});
