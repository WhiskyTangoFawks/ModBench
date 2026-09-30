import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  mkdtemp, mkdir, writeFile, readFile, readdir, rm, stat,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isMo2Instance, write, putIfChanged } from '../files';

// Set by a test, cleared by the mocked `rename` below, which then deletes its own source first —
// a real, cross-platform rename failure, the shape a crash mid-write leaves.
let sabotageNextRename = false;

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    rename: async (from: string, to: string) => {
      if (sabotageNextRename) {
        sabotageNextRename = false;
        await actual.rm(from, { force: true });
      }
      return actual.rename(from, to);
    },
  };
});

describe('isMo2Instance', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'medit-detect-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const layInstance = async () => {
    await writeFile(join(root, 'ModOrganizer.ini'), '[General]\ngameName=Fallout4\n');
    await mkdir(join(root, 'mods'));
    await mkdir(join(root, 'profiles'));
  };

  it('is true when ModOrganizer.ini, mods/, and profiles/ are all present', async () => {
    await layInstance();
    expect(isMo2Instance(root)).toBe(true);
  });

  it('is false when ModOrganizer.ini is missing', async () => {
    await mkdir(join(root, 'mods'));
    await mkdir(join(root, 'profiles'));
    expect(isMo2Instance(root)).toBe(false);
  });

  it('is false when mods/ is missing', async () => {
    await writeFile(join(root, 'ModOrganizer.ini'), '[General]\n');
    await mkdir(join(root, 'profiles'));
    expect(isMo2Instance(root)).toBe(false);
  });

  it('is false when profiles/ is missing', async () => {
    await writeFile(join(root, 'ModOrganizer.ini'), '[General]\n');
    await mkdir(join(root, 'mods'));
    expect(isMo2Instance(root)).toBe(false);
  });

  it('is false for a completely empty folder', () => {
    expect(isMo2Instance(root)).toBe(false);
  });

  it('is false for a nonexistent path, without throwing', () => {
    expect(isMo2Instance(join(root, 'does-not-exist'))).toBe(false);
  });

  it('does not read modlist.txt content — a corrupt-but-present instance still reads true (ADR-0019 boundary)', async () => {
    await layInstance();
    await mkdir(join(root, 'profiles', 'Default'));
    await writeFile(join(root, 'profiles', 'Default', 'modlist.txt'), '\x00not valid text\xff');
    expect(isMo2Instance(root)).toBe(true);
  });
});

describe('write', () => {
  let root: string;
  let path: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'medit-write-'));
    path = join(root, 'meta.ini');
  });

  afterEach(async () => {
    sabotageNextRename = false;
    await rm(root, { recursive: true, force: true });
  });

  it('replaces the whole file and leaves no temp file behind', async () => {
    await writeFile(path, 'old');

    await write(path, 'new');

    expect(await readFile(path, 'utf8')).toBe('new');
    expect(await readdir(root)).toEqual(['meta.ini']);
  });

  // Rival: rename a file onto an existing directory. Windows and Linux both refuse it, so it
  // stands in for any write the platform refuses.
  it('leaves the destination alone and its temp file cleaned up when the platform refuses the write', async () => {
    await mkdir(path);

    await expect(write(path, 'new')).rejects.toThrow();

    expect(await readdir(root)).toEqual(['meta.ini']);
    expect((await stat(path)).isDirectory()).toBe(true);
  });

  // Rival: write straight to `path`, no temp file and no rename. That rival leaves the mocked
  // `rename` uncalled, `sabotageNextRename` set, and the write lands as 'new' — this test catches
  // it on the final content, not on whether the mock fired.
  it('leaves the previous content intact when the rename is interrupted, as by a crash', async () => {
    await writeFile(path, 'original');
    sabotageNextRename = true;

    await expect(write(path, 'new')).rejects.toThrow();

    expect(await readFile(path, 'utf8')).toBe('original');
    expect(await readdir(root)).toEqual(['meta.ini']);
  });
});

describe('putIfChanged', () => {
  let root: string;
  let path: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'medit-putifchanged-'));
    path = join(root, 'plugins.txt');
  });

  afterEach(async () => {
    sabotageNextRename = false;
    await rm(root, { recursive: true, force: true });
  });

  it('leaves the previous content intact when the rename is interrupted, as by a crash', async () => {
    await writeFile(path, 'original');
    sabotageNextRename = true;

    await expect(putIfChanged(path, () => 'new')).rejects.toThrow();

    expect(await readFile(path, 'utf8')).toBe('original');
    expect(await readdir(root)).toEqual(['plugins.txt']);
  });
});
