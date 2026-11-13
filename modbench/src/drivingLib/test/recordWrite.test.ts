import { describe, it, expect, vi } from 'vitest';

vi.mock('vscode', async () => {
  const { recordedWithProgress } = await import('../../test/recordedProgress');
  return { window: { withProgress: recordedWithProgress } };
});

import { recordWriteOver } from '../recordWrite';
import { ambientWrites } from '../../instanceLoader/ambientWrites';

describe('a record write', () => {
  it('refreshes at the files the write named', async () => {
    const refresh = vi.fn(() => Promise.resolve(undefined));

    await recordWriteOver('a.view', { refresh })(() => { ambientWrites.name(['/Data/A.esp']); return Promise.resolve(); });

    expect(refresh).toHaveBeenCalledWith(['/Data/A.esp']);
  });
});
