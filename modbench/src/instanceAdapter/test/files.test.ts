import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  writeFile, readFile, readdir, rm, stat, lstat, chmod, symlink, realpath,
} from 'node:fs/promises';
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import type { InstanceAdapter, InstallPackage } from '../instanceAdapter';
import { fakeVscodeModule } from '../../test/mo2/fakeVscodeWatcher';
import { adapterOver } from '../../test/mo2/adapterOver';
import { fakeInstallationFileReader } from '../../test/fakeInstallationFileReader';
import { onPosix } from '../../test/platform';
import { instanceOnDisk } from './instanceOnDisk';

const crash = vi.hoisted(() => ({ beforeTheNextRenameLands: false, anotherToolMakes: undefined as string | undefined }));

vi.mock('vscode', () => fakeVscodeModule());
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    rename: async (from: string, to: string) => {
      if (crash.beforeTheNextRenameLands) {
        crash.beforeTheNextRenameLands = false;
        throw Object.assign(new Error(`EIO: simulated crash, rename '${from}' -> '${to}'`), { code: 'EIO' });
      }
      return actual.rename(from, to);
    },
    mkdir: async (...args: Parameters<typeof actual.mkdir>) => {
      if (args[0] === crash.anotherToolMakes) {
        crash.anotherToolMakes = undefined;
        await actual.mkdir(args[0]);
        await actual.writeFile(join(args[0], 'theirs.txt'), 'x');
      }
      return actual.mkdir(...args);
    },
  };
});

let root: string;
let adapter: InstanceAdapter;

beforeEach(async () => {
  root = await instanceOnDisk();
  adapter = adapterOver(root);
});

afterEach(async () => {
  crash.beforeTheNextRenameLands = false;
  crash.anotherToolMakes = undefined;
  await rm(root, { recursive: true, force: true });
});

describe('a file written whole, as a mod\'s newest version is', () => {
  const folder = (): string => join(root, 'mods', 'A');
  const path = (): string => join(folder(), 'meta.ini');
  const NEWEST = '[General]\nnewestVersion=2.0\n';
  const writeNewest = (): Promise<unknown> => adapter.writeNewestVersion('A', '2.0');

  it('replaces the whole file and leaves no temp file behind', async () => {
    await writeFile(path(), '[General]\nnewestVersion=1.0\n');

    await writeNewest();

    expect(await readFile(path(), 'utf8')).toBe(NEWEST);
    expect(await readdir(folder())).toEqual(['meta.ini']);
  });

  it('leaves the previous content intact, and its own refusal nameable, when the rename is interrupted as by a crash, the catch\'s own rm removing the temp since the mock only rejects the rename', async () => {
    await writeFile(path(), 'original');
    crash.beforeTheNextRenameLands = true;

    await expect(writeNewest()).rejects.toThrow(`rename '${path()}' -> '${path()}'`);

    expect(await readFile(path(), 'utf8')).toBe('original');
    expect(await readdir(folder())).toEqual(['meta.ini']);
  });

  it('refuses a target that is not writable, before any temp is written, as rename needs write permission only on the directory and would silently overwrite a read-only file', async () => {
    await writeFile(path(), 'original');
    await chmod(path(), 0o444);

    try {
      await expect(writeNewest()).rejects.toThrow();
      expect(await readFile(path(), 'utf8')).toBe('original');
      expect(await readdir(folder())).toEqual(['meta.ini']);
    } finally {
      await chmod(path(), 0o644);
    }
  });

  onPosix.it('(Windows has no POSIX mode bits) carries the target\'s own mode onto the file that lands, not the default mode of a fresh temp', async () => {
    await writeFile(path(), 'original');
    await chmod(path(), 0o640);

    await writeNewest();

    expect((await stat(path())).mode & 0o777).toBe(0o640);
  });

  it('writes through a symlink onto its real target, and leaves the link itself alone, a rename onto the link itself breaking it and leaving its target with the old content forever', async () => {
    const real = join(root, 'real-meta.ini');
    await writeFile(real, '[General]\nnewestVersion=1.0\n');
    await symlink(real, path());

    await writeNewest();

    expect(await readFile(real, 'utf8')).toBe(NEWEST);
    expect((await lstat(path())).isSymbolicLink()).toBe(true);
    expect(await realpath(path())).toBe(real);
  });

  it('removes a temp file left by a writer that is gone before writing again', async () => {
    await writeFile(path(), 'original');
    await writeFile(join(folder(), '.medit_tmp_2147483646_deadbeef0000.tmp'), 'crash leftover');

    await writeNewest();

    expect(await readdir(folder())).toEqual(['meta.ini']);
  });

  it('leaves alone the in-flight temp of a writer still running', async () => {
    await writeFile(path(), 'original');
    const siblingTemp = join(folder(), `.medit_tmp_${process.pid}_aaaaaaaaaaaa.tmp`);
    await writeFile(siblingTemp, 'a sibling target\'s own in-flight write');

    await writeNewest();

    expect(await readFile(siblingTemp, 'utf8')).toBe('a sibling target\'s own in-flight write');
  });

  it.each(['.medit_tmp__x.tmp', '.medit_tmp_-3_x', '.medit_tmp_abc_x'])('leaves alone %s, which names no process', async (name) => {
    await writeFile(path(), 'original');
    await writeFile(join(folder(), name), 'unowned');

    await writeNewest();

    expect(await readFile(join(folder(), name), 'utf8')).toBe('unowned');
  });
});

describe('a file rewritten only where it changes, as plugins.txt is', () => {
  const CRLF = String.fromCharCode(13, 10);
  const BOM = String.fromCharCode(0xfeff);
  const path = (): string => join(root, 'profiles', 'Default', 'plugins.txt');
  const disableA = (): Promise<unknown> => adapter.changePluginOrder('Default', () => [{ kind: 'enable', plugin: 'A.esp', enabled: false }]);

  it('leaves the previous content intact when the rename is interrupted, as by a crash', async () => {
    await writeFile(path(), '*A.esp\n');
    crash.beforeTheNextRenameLands = true;

    await expect(disableA()).rejects.toThrow();

    expect(await readFile(path(), 'utf8')).toBe('*A.esp\n');
    expect(await readdir(join(root, 'profiles', 'Default'))).toEqual(['modlist.txt', 'plugins.txt']);
  });

  it('refuses a file holding a byte that is not UTF-8, naming the file and the line, and writes nothing over it', async () => {
    const cp1252 = Buffer.concat([Buffer.from(`*A.esp${CRLF}*Caf`), Buffer.from([0xe9]), Buffer.from(`.esp${CRLF}`)]);
    await writeFile(path(), cp1252);

    await expect(disableA()).rejects.toThrow(`${path()} line 2`);

    expect(await readFile(path())).toEqual(cp1252);
  });

  it('edits again the text another program wrote while an awaiting edit ran, so that write is not lost', async () => {
    await writeFile(path(), '*A.esp\n');
    const disable = [{ kind: 'enable', plugin: 'A.esp', enabled: false }] as const;
    const decide = vi.fn(() => disable);
    decide.mockImplementationOnce(() => { appendFileSync(path(), '*Outside.esp\n'); return disable; });

    await adapter.changePluginOrderOverProvided('Default', decide);

    expect(await readFile(path(), 'utf8')).toBe('A.esp\n*Outside.esp\n');
  });

  it('writes back every line it does not change byte for byte, a BOM and a name outside ASCII among them', async () => {
    await writeFile(path(), `${BOM}*Café.esp${CRLF}*A.esp${CRLF}`);

    await disableA();

    expect(await readFile(path(), 'utf8')).toBe(`${BOM}*Café.esp${CRLF}A.esp${CRLF}`);
  });
});

describe('a mod folder an install makes new', () => {
  const MOD = 'New Mod';
  const ARCHIVE: InstallPackage = { kind: 'archive', path: '/elsewhere/Release.7z' };

  it('refuses a folder another tool made first, leaving what it holds, a recursive mkdir accepting it so the caller would own and may delete a folder it did not make', async () => {
    const folder = join(root, 'mods', MOD);
    crash.anotherToolMakes = folder;

    await expect(adapterOver(root, { installationFileReader: fakeInstallationFileReader(['a.esp']) }).install(ARCHIVE, { kind: 'new', name: MOD }, (p) => rm(p)))
      .rejects.toThrow(`The folder "${folder}" is in the way`);

    expect(await readFile(join(folder, 'theirs.txt'), 'utf8')).toBe('x');
    expect(await readdir(folder)).toEqual(['theirs.txt']);
  });
});
