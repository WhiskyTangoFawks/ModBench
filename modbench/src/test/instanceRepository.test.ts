import { describe, it, expect, vi, beforeEach } from 'vitest';

const { getExtension, init } = vi.hoisted(() => ({ getExtension: vi.fn(), init: vi.fn() }));

vi.mock('vscode', () => ({
  extensions: { getExtension },
  Uri: { file: (path: string) => ({ fsPath: path }) },
}));

import { initRepositoryIn } from '../instanceRepository';

const gitExtension = (isActive: boolean) => ({
  isActive,
  exports: { getAPI: () => ({ init }) },
  activate: () => Promise.resolve({ getAPI: () => ({ init }) }),
});

beforeEach(() => {
  vi.clearAllMocks();
  init.mockResolvedValue({});
});

describe('initRepositoryIn', () => {
  it.each([true, false])('asks VS Code\'s git, active or not (%s), to make the folder a repository', async (active) => {
    getExtension.mockReturnValue(gitExtension(active));

    await initRepositoryIn('/instance');

    expect(init).toHaveBeenCalledWith({ fsPath: '/instance' });
  });

  it('fails when VS Code has no git extension', async () => {
    getExtension.mockReturnValue(undefined);

    await expect(initRepositoryIn('/instance')).rejects.toThrow("VS Code's git extension is not available.");
  });

  it('fails when git made no repository', async () => {
    getExtension.mockReturnValue(gitExtension(true));
    init.mockResolvedValue(null);

    await expect(initRepositoryIn('/instance')).rejects.toThrow("VS Code's git did not make /instance a repository.");
  });
});
