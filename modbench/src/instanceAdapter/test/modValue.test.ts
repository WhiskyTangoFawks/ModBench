import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { chmod, mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { InstanceAdapter } from '../instanceAdapter';
import { fakeVscodeModule } from '../../test/mo2/fakeVscodeWatcher';
import { adapterOver } from '../../test/mo2/adapterOver';
import { onPosix, onWindows } from '../../test/platform';
import { gameOnDisk, instanceOnDisk } from './instanceOnDisk';

vi.mock('vscode', () => fakeVscodeModule());

const git = (folder: string, ...args: string[]): string =>
  execFileSync('git', ['-C', folder, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { encoding: 'utf8' });
const hashRead = { kind: 'read', answer: expect.objectContaining({ hash: expect.any(String) as unknown }) as unknown };

let root: string;
let adapter: InstanceAdapter;
const folder = (): string => join(root, 'mods', 'Mod');
const holding = async (base: string, paths: readonly string[]): Promise<void> => {
  await Promise.all(paths.map(async (path) => {
    await mkdir(dirname(join(base, path)), { recursive: true });
    await writeFile(join(base, path), path);
  }));
};

beforeEach(async () => {
  root = await instanceOnDisk({ 'profiles/Default/modlist.txt': '+Mod\n' });
  await mkdir(folder());
  adapter = adapterOver(root);
});
afterEach(() => rm(root, { recursive: true, force: true }));

describe('a folder as a value', () => {
  it('holds every file it lists with its own path, whether the mark excludes it, and its hash', async () => {
    await holding(folder(), ['a.esp', 'meshes.mohidden/b.nif']);

    const { files } = await adapter.folderValue(folder());

    expect(new Map([...files].sort())).toEqual(new Map([
      ['a.esp', { path: 'a.esp', excluded: false, read: hashRead }],
      ['meshes.mohidden/b.nif', { path: 'meshes/b.nif', excluded: true, read: hashRead }],
    ]));
  });

  it('excludes each path the mark excludes, a folder by its own path, once', async () => {
    await holding(folder(), ['a.esp.mohidden', 'docs.mohidden/a.txt', 'docs.mohidden/b.txt', 'c.esp']);

    expect([...(await adapter.folderValue(folder())).exclude].sort()).toEqual(['a.esp', 'docs']);
  });

  onWindows.describe('(Windows\' file system ignores case)', () => {
    it('says its file system ignores case when it finds a file by a name in another case', async () => {
      await holding(folder(), ['a.esp']);

      expect((await adapter.folderValue(folder())).ignoresCase).toBe(true);
    });
  });

  onPosix.describe('(a Linux file system tells case apart)', () => {
    it('says its file system does not ignore case when it finds no file by a name in another case, and when it lists two names that differ only in case', async () => {
      await holding(folder(), ['a.esp']);
      const one = await adapter.folderValue(folder());
      await holding(folder(), ['a.txt', 'A.TXT']);

      expect([one.ignoresCase, (await adapter.folderValue(folder())).ignoresCase]).toEqual([false, false]);
    });
  });

  it('says its file system does not ignore case when no file name has a case to change', async () => {
    await holding(folder(), ['123.456']);

    expect((await adapter.folderValue(folder())).ignoresCase).toBe(false);
  });
});

describe('a folder\'s files git does not hold as a value', () => {
  it('holds only the files git neither holds nor owns, an attributes file git does not hold among them', async () => {
    const source = join(root, 'source', 'Mod');
    await holding(source, ['.gitattributes', 'build.json', 'textures/a.dds']);
    await writeFile(join(source, '.gitignore'), '.gitattributes\ntextures/\n');
    git(source, 'init', '-q');
    git(source, 'add', '.gitignore', 'build.json');

    expect([...(await adapter.unheldFolderValue(source)).files.keys()].sort()).toEqual(['.gitattributes', 'textures/a.dds']);
  });
});

describe('a mod as a value', () => {
  it('holds each downloaded file asked for', async () => {
    const value = await adapter.modValue(folder(), { installationFiles: ['Mod.zip'] }, []);

    expect(value).toMatchObject({ kind: 'read', downloadedFiles: new Map([['Mod.zip', { kind: 'read', answer: undefined }]]) });
  });

  it('reads no game file when the game folder is not found', async () => {
    const value = await adapter.modValue(folder(), { installationFiles: [], gameFiles: ['a.esp'] }, []);

    expect(value).toMatchObject({ kind: 'read', gameFiles: undefined });
  });

  it('says what a clone gets of each repository: a submodule at a pinned commit, a source folder the instance repository tracks, an unpinned submodule, or none', async () => {
    git(root, 'init', '-q');
    await holding(root, ['source/Tracked/build.json']);
    await writeFile(join(root, '.gitmodules'), ['Hosted', 'Unpinned'].map((name) => `[submodule "${name}"]\n\tpath = source/${name}\n\turl = https://example.com/${name}.git\n`).join(''));
    git(root, 'update-index', '--add', '--cacheinfo', `160000,${'a'.repeat(40)},source/Hosted`);
    git(root, 'add', 'source/Tracked/build.json', '.gitmodules');
    const valueOf = (repository: string): Promise<unknown> => adapter.modValue(folder(), { installationFiles: [], repository }, []);

    expect(await Promise.all(['Hosted', 'Tracked', 'Unpinned', 'Local'].map(valueOf))).toMatchObject(['pinned', 'pinned', 'unpinned', 'none'].map((repositoryPin) => ({ kind: 'read', repositoryPin })));
  });

  it('reads and hashes no file of a folder when no manifest is asked for', async () => {
    await rm(folder(), { recursive: true });

    expect(await adapter.modValue(folder(), undefined, [])).toEqual({ kind: 'notAsked' });
  });

  onPosix.describe('(only POSIX modes refuse a read)', () => {
    it('is unreadable, saying why, when the game files cannot be read', async () => {
      const game = await gameOnDisk({ 'Data/a.esp': 'game' });
      await chmod(join(game, 'Data'), 0o000);
      try {
        const value = await adapterOver(root, { gameFolderSettingValue: game }).modValue(folder(), { installationFiles: [], gameFiles: ['a.esp'] }, []);

        expect(value).toEqual({ kind: 'unreadable', reason: expect.stringContaining('EACCES') as unknown });
      } finally {
        await chmod(join(game, 'Data'), 0o755);
        await rm(game, { recursive: true, force: true });
      }
    });
  });

  it('is unreadable, saying why, when a read rejects', async () => {
    await rm(folder(), { recursive: true });
    await writeFile(folder(), 'a file where the folder was');

    expect(await adapter.modValue(folder(), { installationFiles: [] }, [])).toEqual({ kind: 'unreadable', reason: expect.stringContaining('ENOTDIR') as unknown });
  });
});
