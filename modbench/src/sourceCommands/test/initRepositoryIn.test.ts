import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { HostGit } from '../../ports/repository';
import { initRepositoryIn } from '../initRepositoryIn';

const init = vi.fn();

const hostWith = (extension: ReturnType<HostGit['extension']>): HostGit => ({ extension: () => extension, folderUri: (folder) => ({ fsPath: folder }) });

const gitExtension = (isActive: boolean) => {
  const exports = { getAPI: () => ({ init }) };
  return { isActive, exports, activate: () => Promise.resolve(exports) };
};

beforeEach(() => {
  vi.clearAllMocks();
  init.mockResolvedValue({});
});

describe('initRepositoryIn', () => {
  it.each([true, false])('asks VS Code\'s git, active or not (%s), to make the folder a repository', async (active) => {
    await initRepositoryIn(hostWith(gitExtension(active)), '/instance');

    expect(init).toHaveBeenCalledWith({ fsPath: '/instance' });
  });

  it('fails when VS Code has no git extension', async () => {
    await expect(initRepositoryIn(hostWith(undefined), '/instance')).rejects.toThrow("VS Code's git extension is not available.");
  });

  it('fails when git made no repository', async () => {
    init.mockResolvedValue(null);

    await expect(initRepositoryIn(hostWith(gitExtension(true)), '/instance')).rejects.toThrow("VS Code's git did not make /instance a repository.");
  });
});
