import { describe, it, expect, vi, beforeEach } from 'vitest';

const { fsDelete } = vi.hoisted(() => ({ fsDelete: vi.fn() }));
vi.mock('vscode', () => ({
  workspace: { fs: { delete: fsDelete } },
  Uri: { file: (path: string) => ({ fsPath: path }) },
}));

import { moveToTrash } from '../trash';

describe('moveToTrash', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('deletes the file through the host with the trash, never permanently', async () => {
    fsDelete.mockResolvedValue(undefined);

    await moveToTrash('/instance/downloads/foo.7z');

    expect(fsDelete).toHaveBeenCalledWith({ fsPath: '/instance/downloads/foo.7z' }, { useTrash: true });
  });

  it('rejects with the host’s own reason when the trash fails', async () => {
    fsDelete.mockRejectedValue(new Error('EPERM'));

    await expect(moveToTrash('/instance/downloads/foo.7z')).rejects.toThrow('EPERM');
  });
});
