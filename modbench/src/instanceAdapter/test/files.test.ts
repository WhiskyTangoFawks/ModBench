import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  mkdtemp, mkdir, writeFile, readFile, readdir, rm, stat, lstat, chmod, symlink, realpath,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { write, putIfChanged, makeDir } from '../files';

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

describe('a file written whole', () => {
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

    await expect(write(path, 'new')).rejects.toThrow(`rename '${path}' -> '${path}'`);

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

  it.skipIf(process.platform === 'win32')('(Windows has no POSIX mode bits) carries the target\'s own mode onto the file that lands, not the default mode of a fresh temp', async () => {
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

  it('removes a temp file left by a writer that is gone before writing again', async () => {
    await writeFile(path, 'original');
    await writeFile(join(root, '.medit_tmp_2147483646_deadbeef0000.tmp'), 'crash leftover');

    await write(path, 'new');

    expect(await readFile(path, 'utf8')).toBe('new');
    expect(await readdir(root)).toEqual(['meta.ini']);
  });

  it('leaves alone the in-flight temp of a writer still running', async () => {
    await writeFile(path, 'original');
    const siblingTemp = join(root, `.medit_tmp_${process.pid}_aaaaaaaaaaaa.tmp`);
    await writeFile(siblingTemp, 'a sibling target\'s own in-flight write');

    await write(path, 'new');

    expect(await readFile(path, 'utf8')).toBe('new');
    expect(await readFile(siblingTemp, 'utf8')).toBe('a sibling target\'s own in-flight write');
  });

  it.each(['.medit_tmp__x.tmp', '.medit_tmp_-3_x', '.medit_tmp_abc_x'])('leaves alone %s, which names no process', async (name) => {
    await writeFile(path, 'original');
    await writeFile(join(root, name), 'unowned');

    await write(path, 'new');

    expect(await readFile(join(root, name), 'utf8')).toBe('unowned');
  });
});

describe('a file rewritten only where it changes', () => {
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

  const CRLF = String.fromCharCode(13, 10);
  const BOM = String.fromCharCode(0xfeff);

  it('refuses a file holding a byte that is not UTF-8, naming the file and the line, and writes nothing over it', async () => {
    const cp1252 = Buffer.concat([Buffer.from(`*A.esp${CRLF}*Caf`), Buffer.from([0xe9]), Buffer.from(`.esp${CRLF}`)]);
    await writeFile(path, cp1252);

    await expect(putIfChanged(path, (text) => `${text}B.esp${CRLF}`)).rejects.toThrow(`${path} line 2`);

    expect(await readFile(path)).toEqual(cp1252);
  });

  it('writes back every line it does not change byte for byte, a BOM and a name outside ASCII among them', async () => {
    await writeFile(path, `${BOM}*Café.esp${CRLF}*A.esp${CRLF}`);

    await putIfChanged(path, (text) => text.replace('*A.esp', 'A.esp'));

    expect(await readFile(path, 'utf8')).toBe(`${BOM}*Café.esp${CRLF}A.esp${CRLF}`);
  });
});

describe('a folder made new', () => {
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
