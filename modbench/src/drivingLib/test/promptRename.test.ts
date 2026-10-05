import { describe, it, expect, vi, beforeEach } from 'vitest';

const { showInputBox } = vi.hoisted(() => ({ showInputBox: vi.fn() }));
vi.mock('vscode', () => ({ window: { showInputBox } }));

import { promptRename } from '../promptRename';

describe('promptRename', () => {
  beforeEach(() => showInputBox.mockReset());

  it('asks with the prompt, prefilled with the current name', async () => {
    showInputBox.mockResolvedValueOnce('New');
    const validate = () => undefined;
    expect(await promptRename('Rename it', 'Old', validate)).toBe('New');
    expect(showInputBox).toHaveBeenCalledWith({ prompt: 'Rename it', value: 'Old', validateInput: validate });
  });

  it.each([['Esc', undefined], ['an empty name', ''], ['the same name', 'Old']])('yields nothing on %s', async (_, answer) => {
    showInputBox.mockResolvedValueOnce(answer);
    expect(await promptRename('Rename it', 'Old', () => undefined)).toBeUndefined();
  });
});
