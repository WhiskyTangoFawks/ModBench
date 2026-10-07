import { describe, it, expect, vi } from 'vitest';

type ConfigListener = (change: { affectsConfiguration(section: string): boolean }) => void;
let configListener: ConfigListener | undefined;

vi.mock('vscode', () => ({
  workspace: {
    onDidChangeConfiguration: (listener: ConfigListener) => {
      configListener = listener;
      return { dispose: () => { configListener = undefined; } };
    },
  },
}));

import { onGameDirectoryChange } from '../workspaceConfig';

const changeTo = (key: string): void => configListener?.({ affectsConfiguration: (section) => section === key });

describe('onGameDirectoryChange', () => {
  it('signals for the game-folder setting and for no other key', () => {
    const listener = vi.fn();
    onGameDirectoryChange(listener);

    changeTo('modbench.mods.somethingElse');
    expect(listener).not.toHaveBeenCalled();

    changeTo('modbench.mods.gameDirectory');
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
