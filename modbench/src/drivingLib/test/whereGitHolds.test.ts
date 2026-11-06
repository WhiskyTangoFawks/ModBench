import { describe, it, expect, vi, beforeEach } from 'vitest';

const showQuickPick = vi.hoisted(() => vi.fn<(items: readonly { label: string; where: string }[], options?: { placeHolder?: string }) => Promise<unknown>>());

vi.mock('vscode', () => ({ window: { showQuickPick } }));

import { pickWhereGitHolds } from '../whereGitHolds';

beforeEach(() => { vi.clearAllMocks(); });

describe('pickWhereGitHolds', () => {
  it('offers a new repository or the instance repository, naming the gesture, while the instance holds a repository', async () => {
    showQuickPick.mockResolvedValue({ label: 'A source mod in the instance repository', where: 'InstanceRepository' });

    const picked = await pickWhereGitHolds(true, 'Decompile and repair');

    expect(picked).toBe('InstanceRepository');
    expect(showQuickPick.mock.calls[0]?.[0].map(({ where }) => where)).toEqual(['NewRepository', 'InstanceRepository']);
    expect(showQuickPick.mock.calls[0]?.[1]).toEqual({ placeHolder: 'Decompile and repair: where git holds the mod' });
  });

  it('offers the mod\'s whole folder last when the gesture can hold it', async () => {
    showQuickPick.mockResolvedValue({ label: 'The mod\'s whole folder in the instance repository', where: 'WholeFolder' });

    const picked = await pickWhereGitHolds(true, 'Version in git', true);

    expect(picked).toBe('WholeFolder');
    expect(showQuickPick.mock.calls[0]?.[0].map(({ where }) => where)).toEqual(['NewRepository', 'InstanceRepository', 'WholeFolder']);
  });

  it('shows nothing, and answers a new repository, while the instance holds none', async () => {
    expect(await pickWhereGitHolds(false, 'Decompile and repair')).toBe('NewRepository');
    expect(showQuickPick).not.toHaveBeenCalled();
  });

  it('answers nothing when the pick is dismissed', async () => {
    showQuickPick.mockResolvedValue(undefined);

    expect(await pickWhereGitHolds(true, 'Decompile and repair')).toBeUndefined();
  });
});
