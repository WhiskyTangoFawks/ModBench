import { describe, it, expect } from 'vitest';
import { initRepositoryIn } from '../initRepositoryIn';
import { hostGitRecordingInits, hostWithoutGit } from './hostGitDouble';

describe('initRepositoryIn', () => {
  it('asks VS Code\'s git to make the folder a repository', async () => {
    const inited: string[] = [];

    await initRepositoryIn(hostGitRecordingInits(inited), '/instance');

    expect(inited).toEqual(['uri:/instance']);
  });

  it('fails when VS Code has no git extension', async () => {
    await expect(initRepositoryIn(hostWithoutGit, '/instance')).rejects.toThrow("VS Code's git extension is not available.");
  });

  it('fails when git made no repository', async () => {
    await expect(initRepositoryIn(hostGitRecordingInits([], null), '/instance')).rejects.toThrow("VS Code's git did not make /instance a repository.");
  });
});
