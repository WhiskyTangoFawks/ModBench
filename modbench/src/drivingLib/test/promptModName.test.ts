import { describe, it, expect, vi } from 'vitest';

const { showInputBox } = vi.hoisted(() => ({ showInputBox: vi.fn() }));
vi.mock('vscode', () => ({ window: { showInputBox } }));

import { promptModName } from '../promptModName';

describe('promptModName', () => {
  it('asks for the mod name, prefilled, with the caller\'s validation', async () => {
    showInputBox.mockResolvedValueOnce('Foo');
    const validate = () => undefined;
    expect(await promptModName('foo', validate)).toBe('Foo');
    expect(showInputBox).toHaveBeenCalledWith({ prompt: 'Mod name', value: 'foo', validateInput: validate });
  });
});
