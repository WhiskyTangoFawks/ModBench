import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  mkdtemp, mkdir, writeFile, readFile, readdir, rm, stat, lstat, chmod, symlink, realpath,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { write, putIfChanged, isTracked } from '../files';

// Set by a test, cleared by the mocked `rename` below, which then rejects instead of renaming —
// a temp file written but never landed, the shape a crash between the two leaves.
let sabotageNextRename = false;

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    rename: async (from: string, to: string) => {
      if (sabotageNextRename) {
        sabotageNextRename = false;
        throw Object.assign(new Error(`EPERM: simulated crash, rename '${from}' -> '${to}'`), { code: 'EPERM' });
      }
      return actual.rename(from, to);
    },
  };
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

  // A directory already at the destination makes the platform refuse the rename on both Windows
  // and Linux. Rival: no cleanup on that failure, which leaves the temp file sitting beside it.
  it('leaves the destination alone and its temp file cleaned up when the platform refuses the write', async () => {
    await mkdir(path);

    await expect(write(path, 'new')).rejects.toThrow();

    expect(await readdir(root)).toEqual(['meta.ini']);
    expect((await stat(path)).isDirectory()).toBe(true);
  });

  // The mock only rejects the rename; it never touches the temp file itself. So "no temp left"
  // here can only be the catch's own `rm` running, not an accident of the injection.
  it('leaves the previous content intact, and its own refusal nameable, when the rename is interrupted as by a crash', async () => {
    await writeFile(path, 'original');
    sabotageNextRename = true;

    const failure: unknown = await write(path, 'new').then(() => undefined, (err: unknown) => err);

    if (!(failure instanceof Error)) throw new Error('expected write to reject with an Error');
    expect(failure.message).toContain(path);
    expect(failure.message).not.toContain('.tmp');
    expect(await readFile(path, 'utf8')).toBe('original');
    expect(await readdir(root)).toEqual(['meta.ini']);
  });

  // Rival: no access check before writing, which lets a rename land on a read-only file (rename
  // only needs write permission on the directory, not the target) and silently overwrite it.
  it('refuses a target that is not writable, before any temp is written', async () => {
    await writeFile(path, 'original');
    await chmod(path, 0o444);

    try {
      await expect(write(path, 'new')).rejects.toThrow();
      expect(await readFile(path, 'utf8')).toBe('original');
      expect(await readdir(root)).toEqual(['meta.ini']);
    } finally {
      await chmod(path, 0o644);
    }
  });

  // Rival: create the temp with the default mode and never carry the target's own mode onto it.
  it('carries the target\'s own mode onto the file that lands', async () => {
    await writeFile(path, 'original');
    await chmod(path, 0o640);

    await write(path, 'new');

    expect((await stat(path)).mode & 0o777).toBe(0o640);
  });

  // Rival: rename onto `path` itself, which replaces the symlink with a plain file — the link
  // breaks, and whatever it pointed at keeps its old content forever.
  it('writes through a symlink onto its real target, and leaves the link itself alone', async () => {
    const real = join(root, 'real-meta.ini');
    const link = join(root, 'linked-meta.ini');
    await writeFile(real, 'original');
    await symlink(real, link);

    await write(link, 'new');

    expect(await readFile(real, 'utf8')).toBe('new');
    expect((await lstat(link)).isSymbolicLink()).toBe(true);
    expect(await realpath(link)).toBe(real);
  });

  // Rival: sweep only the current call's own temp on failure, which leaves an earlier crash's
  // temp — a different random suffix — sitting beside the target forever.
  it('removes a stale temp file left by an earlier crash before writing again', async () => {
    await writeFile(path, 'original');
    await writeFile(`${path}.deadbeef0000.tmp`, 'crash leftover');

    await write(path, 'new');

    expect(await readFile(path, 'utf8')).toBe('new');
    expect(await readdir(root)).toEqual(['meta.ini']);
  });

  // Rival: match by prefix and suffix with the middle open, which also matches a sibling
  // target's own temp — any name that happens to start with `path` and end in the temp suffix.
  it('leaves a sibling target\'s own in-flight temp alone, even though its name starts the same way', async () => {
    await writeFile(path, 'original');
    const siblingTemp = `${path}.zip.meta.aaaaaaaaaaaa.tmp`;
    await writeFile(siblingTemp, 'a sibling target\'s own in-flight write');

    await write(path, 'new');

    expect(await readFile(path, 'utf8')).toBe('new');
    expect(await readFile(siblingTemp, 'utf8')).toBe('a sibling target\'s own in-flight write');
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

describe('isTracked', () => {
  let folder: string;

  beforeEach(async () => {
    folder = await mkdtemp(join(tmpdir(), 'files-tracked-'));
  });

  afterEach(async () => {
    await rm(folder, { recursive: true, force: true });
  });

  it('is true for a folder holding a .git', async () => {
    await mkdir(join(folder, '.git'));
    expect(await isTracked(folder)).toBe(true);
  });

  it('is false for a folder with no .git', async () => {
    expect(await isTracked(folder)).toBe(false);
  });
});
