import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gitFed } from '../git';

let root: string;

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('gitFed', () => {
  it('rejects with git\'s failure, and nothing else, when git exits before it reads what it is handed', async () => {
    root = await mkdtemp(join(tmpdir(), 'modbench-git-fed-'));

    await expect(gitFed(root, 'x\n'.repeat(1 << 22), 'check-ignore', '--stdin')).rejects.toThrow('not a git repository');
  });
});
