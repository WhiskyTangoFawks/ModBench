import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { git, gitFed, gitStagingInto } from '../git';
import { diskCheckedBy } from '../../repositoriesLib/writesTold';

let root: string;
let unnamed: number;
let named: string[];

beforeEach(() => {
  unnamed = 0;
  named = [];
  diskCheckedBy({ name: (paths) => { named.push(...paths); }, leaveUnnamed: () => { unnamed++; } });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('gitFed', () => {
  it('rejects with git\'s failure, and nothing else, when git exits before it reads what it is handed', async () => {
    root = await mkdtemp(join(tmpdir(), 'modbench-git-fed-'));

    await expect(gitFed(root, 'x\n'.repeat(1 << 22), 'check-ignore', '--stdin')).rejects.toThrow('not a git repository');
  });
});

describe('git, which names the files it writes', () => {
  it.each([
    ['init', ['init']],
    ['a checkout', ['-c', 'advice.detachedHead=false', 'checkout', '--detach']],
    ['a reset of the working tree', ['reset', '--hard']],
  ])('leaves the files it writes unnamed for %s', async (_, args) => {
    root = await mkdtemp(join(tmpdir(), 'modbench-git-writes-'));

    await git(root, ...args).catch(() => undefined);

    expect(unnamed).toBe(1);
  });

  it.each([
    ['a config set', ['config', 'user.name', 'x']],
    ['a config unset', ['config', '--unset-all', 'user.name']],
    ['an index update', ['update-index', '-z', '--index-info']],
    ['a reset of the index', ['reset', '-q', '--', 'mods']],
    ['a remote added', ['remote', 'add', 'origin', 'x']],
    ['a symbolic ref set', ['symbolic-ref', 'HEAD', 'refs/heads/x']],
    ['a symbolic ref deleted', ['symbolic-ref', '--delete', 'HEAD']],
  ])('names the repository\'s .git for %s', async (_, args) => {
    root = await mkdtemp(join(tmpdir(), 'modbench-git-writes-'));

    await git(root, ...args).catch(() => undefined);

    expect({ named, unnamed }).toEqual({ named: [join(root, '.git')], unnamed: 0 });
  });

  it.each([['-f'], ['--file']])('names the file a config set given %s writes', async (option) => {
    root = await mkdtemp(join(tmpdir(), 'modbench-git-writes-'));

    await git(root, 'config', option, '.gitmodules', 'submodule.a.path', 'a').catch(() => undefined);

    expect({ named, unnamed }).toEqual({ named: [join(root, '.gitmodules')], unnamed: 0 });
  });

  it.each([
    ['rev-parse', ['rev-parse', '--git-dir']],
    ['a config get', ['config', '--get', 'user.name']],
    ['a config get after an option', ['-c', 'x.y=z', 'config', '--get', 'x.y']],
    ['a config list of a file', ['config', '-f', '.gitmodules', '--list']],
    ['the remotes listed', ['remote']],
    ['a remote\'s url', ['remote', 'get-url', 'origin']],
    ['a symbolic ref read', ['symbolic-ref', '--short', 'HEAD']],
  ])('names nothing for %s', async (_, args) => {
    root = await mkdtemp(join(tmpdir(), 'modbench-git-reads-'));

    await git(root, ...args).catch(() => undefined);

    expect({ named, unnamed }).toEqual({ named: [], unnamed: 0 });
  });

  it('leaves nothing unnamed when it stages into an index of its own', async () => {
    root = await mkdtemp(join(tmpdir(), 'modbench-git-staging-'));

    await gitStagingInto(join(root, 'index')).git(root, 'add', '-A').catch(() => undefined);

    expect({ named, unnamed }).toEqual({ named: [], unnamed: 0 });
  });
});
