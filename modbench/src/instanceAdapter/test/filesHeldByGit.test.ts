import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { filesHeldByGit } from '../filesHeldByGit';

let root: string;
const made: string[] = [];

afterEach(async () => {
  await Promise.all([root, ...made.splice(0)].map((folder) => rm(folder, { recursive: true, force: true })));
});

async function folder(name: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), `modbench-files-held-${name}-`));
  made.push(path);
  return path;
}

async function put(at: string, files: Readonly<Record<string, string>>): Promise<void> {
  for (const [file, text] of Object.entries(files)) {
    await mkdir(dirname(join(at, file)), { recursive: true });
    await writeFile(join(at, file), text);
  }
}

const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8' });

async function instance(files: Readonly<Record<string, string>>, repository = true): Promise<void> {
  root = await mkdtemp(join(tmpdir(), 'modbench-files-held-'));
  await put(root, files);
  if (repository) git(root, 'init', '--quiet');
}

const heldIn = async (...folders: string[]): Promise<string[][]> => {
  const held = await filesHeldByGit(root, folders);
  return folders.map((one) => [...held.get(one) ?? ['not answered']].sort());
};

describe('the files git holds in a folder', () => {
  it('is each file a mod folder\'s ignore list lets in, tracked or new, by its path in the folder', async () => {
    await instance({
      '.gitignore': '/mods/*\n!/mods/ModA/\n/mods/ModA/*\n!/mods/ModA/config.ini\n!/mods/ModA/new.ini\n',
      'mods/ModA/config.ini': 'c', 'mods/ModA/new.ini': 'n', 'mods/ModA/a.nif': 'a', 'mods/ModB/b.nif': 'b',
    });
    git(root, 'add', '--', 'mods/ModA/config.ini');

    expect(await heldIn(join(root, 'mods', 'ModA'), join(root, 'mods', 'ModB'))).toEqual([['config.ini', 'new.ini'], []]);
  });

  it('is each file a source folder\'s own repository tracks or does not ignore', async () => {
    await instance({ 'source/Mod A/plugin.json': 'one', 'source/Mod A/.gitignore': 'tool.dll\n', 'source/Mod A/tool.dll': 'dll', 'source/Mod A/extra.nif': 'nif' }, false);
    const source = join(root, 'source', 'Mod A');
    git(source, 'init', '--quiet');
    git(source, 'add', '--', 'plugin.json', '.gitignore');

    expect(await heldIn(source)).toEqual([['.gitignore', 'extra.nif', 'plugin.json']]);
  });

  it('is none in an instance that holds no repository', async () => {
    await instance({ 'mods/ModA/a.nif': 'a' }, false);

    expect(await heldIn(join(root, 'mods', 'ModA'))).toEqual([[]]);
  });

  it('is none in a mod folder reached through a symlink to a folder outside any repository', async () => {
    await instance({ '.gitignore': '' });
    const outside = await folder('outside');
    await put(outside, { 'a.nif': 'a' });
    await mkdir(join(root, 'mods'));
    await symlink(outside, join(root, 'mods', 'Linked'));

    expect(await heldIn(join(root, 'mods', 'Linked'))).toEqual([[]]);
  });

  it('is none in a folder outside the instance, though another repository tracks its files', async () => {
    await instance({ '.gitignore': '' });
    const other = await folder('other');
    await put(other, { 'mods/ModA/a.nif': 'a' });
    git(other, 'init', '--quiet');
    git(other, 'add', '--', '.');

    expect(await heldIn(join(other, 'mods', 'ModA'))).toEqual([[]]);
  });

  it('rejects when git cannot list the instance', async () => {
    await instance({ 'mods/ModA/a.nif': 'a' }, false);
    await mkdir(join(root, '.git'));

    await expect(filesHeldByGit(root, [join(root, 'mods', 'ModA')])).rejects.toThrow();
  });
});
