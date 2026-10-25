import { describe, it, expect, vi } from 'vitest';

const { showInputBox } = vi.hoisted(() => ({ showInputBox: vi.fn() }));
vi.mock('vscode', () => ({ window: { showInputBox } }));

import { promptModName } from '../promptModName';

describe('the install prompt', () => {
  it('asks for the mod name, prefilled, with the caller\'s validation', async () => {
    const validate = () => undefined;
    await promptModName('foo', validate);
    expect(showInputBox).toHaveBeenCalledWith({ prompt: 'Mod name', value: 'foo', validateInput: validate });
  });
});
