import { describe, it, expect } from 'vitest';
import type { HostGit } from '../../ports/repository';
import { initRepositoryIn } from '../initRepositoryIn';

const hostWith = (init: () => Promise<unknown>, folders: string[] = []): HostGit<string> => ({
  extension: () => ({ activate: () => Promise.resolve({ getAPI: () => ({ init: (folder) => { folders.push(folder); return init(); } }) }) }),
  folderOf: (path) => `uri:${path}`,
});

describe('initRepositoryIn', () => {
  it('asks VS Code\'s git to make the folder a repository', async () => {
    const folders: string[] = [];

    await initRepositoryIn(hostWith(() => Promise.resolve({}), folders), '/instance');

    expect(folders).toEqual(['uri:/instance']);
  });

  it('fails when VS Code has no git extension', async () => {
    await expect(initRepositoryIn({ extension: () => undefined, folderOf: (path) => path }, '/instance')).rejects.toThrow("VS Code's git extension is not available.");
  });

  it('fails when git made no repository', async () => {
    await expect(initRepositoryIn(hostWith(() => Promise.resolve(null)), '/instance')).rejects.toThrow("VS Code's git did not make /instance a repository.");
  });
});
