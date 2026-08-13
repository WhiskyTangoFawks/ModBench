import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detectRoot, DATA_DIRS } from './detectRoot';

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

  it('does not peel any DATA_DIRS entry, not just meshes', async () => {
    for (const name of DATA_DIRS) {
      if (name === 'meshes') continue; // covered above
      // A corrupted (empty-string) entry would collapse join(sub, name) into sub
      // itself, silently passing the fixture below for the wrong reason — guard
      // against that before it can happen.
      expect(name).not.toBe('');
      const sub = await mkdtemp(join(tmpdir(), 'data-dirs-'));
      try {
        await mkdir(join(sub, name), { recursive: true });
        await writeFile(join(sub, name, 'x.dat'), '');
        expect(await detectRoot(sub)).toEqual({ sourceDir: sub, isFomod: false });
      } finally {
        await rm(sub, { recursive: true, force: true });
      }
    }
  });

  it('stops peeling at the depth cap for a pathologically deep single-wrapper chain', async () => {
    let rel = '';
    for (let i = 1; i <= 40; i++) rel += `L${i}/`;
    await scaffold(`${rel}foo.esp`);

    let expected = dir;
    for (let i = 1; i <= 32; i++) expected = join(expected, `L${i}`);
    expect(await detectRoot(dir)).toEqual({ sourceDir: expected, isFomod: false });
  });

  it('resolves the Data root even when a sibling file sits alongside it', async () => {
    await scaffold('Data/foo.esp', 'readme.txt');
    expect(await detectRoot(dir)).toEqual({ sourceDir: join(dir, 'Data'), isFomod: false });
  });

  it('does not peel a wrapper folder when a sibling loose file sits alongside it', async () => {
    await scaffold('ModA/foo.esp', 'readme.txt');
    expect(await detectRoot(dir)).toEqual({ sourceDir: dir, isFomod: false });
  });

  it('does not mistake a folder merely named fomod (no ModuleConfig.xml) for a real FOMOD', async () => {
    await scaffold('fomod/readme.txt', '00 Core/Data/foo.esp');
    expect(await detectRoot(dir)).toEqual({ sourceDir: dir, isFomod: false });
  });

  it('still detects a FOMOD whose fomod/ folder has files besides ModuleConfig.xml', async () => {
    await scaffold(
      'MyMod/fomod/ModuleConfig.xml',
      'MyMod/fomod/info.xml',
      'MyMod/00 Core/foo.esp',
    );
    expect(await detectRoot(dir)).toEqual({ sourceDir: join(dir, 'MyMod'), isFomod: true });
  });
});
