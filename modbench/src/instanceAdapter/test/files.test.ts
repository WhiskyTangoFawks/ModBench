import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  mkdtemp, mkdir, writeFile, readFile, readdir, rm, stat, lstat, chmod, symlink, realpath,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { write, putIfChanged, isTracked, makeDir } from '../files';

let crashBeforeTheNextRenameLands = false;

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    rename: async (from: string, to: string) => {
      if (crashBeforeTheNextRenameLands) {
        crashBeforeTheNextRenameLands = false;
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
    crashBeforeTheNextRenameLands = false;
    await rm(root, { recursive: true, force: true });
  });

  it('replaces the whole file and leaves no temp file behind', async () => {
    await writeFile(path, 'old');

    await write(path, 'new');

    expect(await readFile(path, 'utf8')).toBe('new');
    expect(await readdir(root)).toEqual(['meta.ini']);
  });

  it('leaves the destination alone and its temp file cleaned up when the platform refuses the write, a directory already at the destination making Windows and Linux alike refuse the rename', async () => {
    await mkdir(path);

    await expect(write(path, 'new')).rejects.toThrow();

    expect(await readdir(root)).toEqual(['meta.ini']);
    expect((await stat(path)).isDirectory()).toBe(true);
  });

  it('leaves the previous content intact, and its own refusal nameable, when the rename is interrupted as by a crash, the catch\'s own rm removing the temp since the mock only rejects the rename', async () => {
    await writeFile(path, 'original');
    crashBeforeTheNextRenameLands = true;

    const failure: unknown = await write(path, 'new').then(() => undefined, (err: unknown) => err);

    if (!(failure instanceof Error)) throw new Error('expected write to reject with an Error');
    expect(failure.message).toContain(path);
    expect(failure.message).not.toContain('.tmp');
    expect(await readFile(path, 'utf8')).toBe('original');
    expect(await readdir(root)).toEqual(['meta.ini']);
  });

  it('refuses a target that is not writable, before any temp is written, as rename needs write permission only on the directory and would silently overwrite a read-only file', async () => {
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

  it('carries the target\'s own mode onto the file that lands, not the default mode of a fresh temp', async () => {
    await writeFile(path, 'original');
    await chmod(path, 0o640);

    await write(path, 'new');

    expect((await stat(path)).mode & 0o777).toBe(0o640);
  });

  it('writes through a symlink onto its real target, and leaves the link itself alone, a rename onto the link itself breaking it and leaving its target with the old content forever', async () => {
    const real = join(root, 'real-meta.ini');
    const link = join(root, 'linked-meta.ini');
    await writeFile(real, 'original');
    await symlink(real, link);

    await write(link, 'new');

    expect(await readFile(real, 'utf8')).toBe('new');
    expect((await lstat(link)).isSymbolicLink()).toBe(true);
    expect(await realpath(link)).toBe(real);
  });

  it('removes a stale temp file left by an earlier crash before writing again, its random suffix differing from the current call\'s own temp', async () => {
    await writeFile(path, 'original');
    await writeFile(`${path}.deadbeef0000.tmp`, 'crash leftover');

    await write(path, 'new');

    expect(await readFile(path, 'utf8')).toBe('new');
    expect(await readdir(root)).toEqual(['meta.ini']);
  });

  it('leaves a sibling target\'s own in-flight temp alone, even though its name starts with the path and ends in the temp suffix', async () => {
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
    crashBeforeTheNextRenameLands = false;
    await rm(root, { recursive: true, force: true });
  });

  it('leaves the previous content intact when the rename is interrupted, as by a crash', async () => {
    await writeFile(path, 'original');
    crashBeforeTheNextRenameLands = true;

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

describe('makeDir', () => {
  let parent: string;

  beforeEach(async () => {
    parent = await mkdtemp(join(tmpdir(), 'files-makedir-'));
  });

  afterEach(async () => {
    await rm(parent, { recursive: true, force: true });
  });

  it('refuses a folder another tool made first, leaving what it holds, a recursive mkdir accepting it so the caller would own and may delete a folder it did not make', async () => {
    await mkdir(join(parent, 'taken'));
    await writeFile(join(parent, 'taken', 'theirs.txt'), 'x');

    await expect(makeDir(join(parent, 'taken'))).rejects.toMatchObject({ code: 'EEXIST' });

    expect(await readFile(join(parent, 'taken', 'theirs.txt'), 'utf8')).toBe('x');
  });

  it('makes the folder, and not a missing parent', async () => {
    await makeDir(join(parent, 'made'));

    expect((await stat(join(parent, 'made'))).isDirectory()).toBe(true);
    await expect(makeDir(join(parent, 'no', 'parent'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
