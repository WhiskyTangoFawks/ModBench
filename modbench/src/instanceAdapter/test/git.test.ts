import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { git, gitFed, gitStagingInto } from '../git';
import { diskCheckedBy } from '../../repositoriesLib/writesTold';

let root: string;
let unnamed: number;

beforeEach(() => {
  unnamed = 0;
  diskCheckedBy({ name: () => undefined, leaveUnnamed: () => { unnamed++; } });
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

describe('git, which can write any file of a working tree', () => {
  it.each([
    ['init', ['init']],
    ['a checkout', ['-c', 'advice.detachedHead=false', 'checkout', '--detach']],
    ['a config set', ['config', 'user.name', 'x']],
  ])('leaves the files it writes unnamed for %s', async (_, args) => {
    root = await mkdtemp(join(tmpdir(), 'modbench-git-writes-'));

    await git(root, ...args).catch(() => undefined);

    expect(unnamed).toBe(1);
  });

  it.each([
    ['rev-parse', ['rev-parse', '--git-dir']],
    ['a config get', ['config', '--get', 'user.name']],
    ['a config get after an option', ['-c', 'x.y=z', 'config', '--get', 'x.y']],
  ])('leaves nothing unnamed for %s', async (_, args) => {
    root = await mkdtemp(join(tmpdir(), 'modbench-git-reads-'));

    await git(root, ...args).catch(() => undefined);

    expect(unnamed).toBe(0);
  });

  it('leaves nothing unnamed when it stages into an index of its own', async () => {
    root = await mkdtemp(join(tmpdir(), 'modbench-git-staging-'));

    await gitStagingInto(join(root, 'index')).git(root, 'add', '-A').catch(() => undefined);

    expect(unnamed).toBe(0);
  });
});
