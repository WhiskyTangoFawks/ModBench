import { describe, it, expect } from 'vitest';
import { initRepositoryIn } from '../initRepositoryIn';
import { hostGitMaking } from './hostGitDouble';

describe('initRepositoryIn', () => {
  it('asks VS Code\'s git to make the folder a repository', async () => {
    const folders: string[] = [];

    await initRepositoryIn(hostGitMaking(folders), '/instance');

    expect(folders).toEqual(['uri:/instance']);
  });

  it('fails when VS Code has no git extension', async () => {
    await expect(initRepositoryIn({ extension: () => undefined, folderOf: (path) => path }, '/instance')).rejects.toThrow("VS Code's git extension is not available.");
  });

  it('fails when git made no repository', async () => {
    await expect(initRepositoryIn(hostGitMaking([], null), '/instance')).rejects.toThrow("VS Code's git did not make /instance a repository.");
  });
});
