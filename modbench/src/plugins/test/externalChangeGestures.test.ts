import { describe, it, expect, vi } from 'vitest';
import { runRebase, rebaseOfferMessage } from '../externalChangeGestures';

describe('rebaseOfferMessage', () => {
  it('names the edit branch and the origin', () => {
    expect(rebaseOfferMessage('ModA')).toBe('main moved ahead of "edit" in ModA.');
  });
});

describe('runRebase', () => {
  it('opens the native merge editor on every conflicted path', async () => {
    const controller = { rebaseOntoMain: vi.fn().mockResolvedValue({ outcome: 'Conflicted', refusalReason: null, conflictedPaths: ['source/A.esp/x.json', 'source/A.esp/y.json'] }) } as any;
    const openMergeEditor = vi.fn().mockResolvedValue(undefined);

    const result = await runRebase({ controller, openMergeEditor }, 'ModA');

    expect(result?.outcome).toBe('Conflicted');
    expect(openMergeEditor).toHaveBeenCalledTimes(2);
    expect(openMergeEditor).toHaveBeenCalledWith('ModA', 'source/A.esp/x.json');
    expect(openMergeEditor).toHaveBeenCalledWith('ModA', 'source/A.esp/y.json');
  });

  it('opens nothing on a clean rebase', async () => {
    const controller = { rebaseOntoMain: vi.fn().mockResolvedValue({ outcome: 'Clean', refusalReason: null, conflictedPaths: [] }) } as any;
    const openMergeEditor = vi.fn();

    await runRebase({ controller, openMergeEditor }, 'ModA');

    expect(openMergeEditor).not.toHaveBeenCalled();
  });
});
