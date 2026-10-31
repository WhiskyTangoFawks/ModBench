import { describe, it, expect, vi } from 'vitest';

type ConfigListener = (change: { affectsConfiguration(section: string): boolean }) => void;
let inspected: { workspaceValue?: string } | undefined;
let configListener: ConfigListener | undefined;

vi.mock('vscode', () => ({
  Uri: { file: (path: string) => ({ path }) },
  workspace: {
    getConfiguration: () => ({ inspect: () => inspected }),
    onDidChangeConfiguration: (listener: ConfigListener) => {
      configListener = listener;
      return { dispose: () => { configListener = undefined; } };
    },
  },
}));

import { deploymentFolderSetting, gameFolderSetting } from '../workspaceSettings';

const changeTo = (key: string): void => configListener?.({ affectsConfiguration: (section) => section === key });

describe('a setting change signals the listener of that setting', () => {
  it('the game folder, on a change to modbench.mods.gameFolder', () => {
    const listener = vi.fn();
    gameFolderSetting.changed(listener);

    changeTo('modbench.mods.gameFolder');

    expect(listener).toHaveBeenCalledTimes(1);
  });
});

describe('the deployment folder setting', () => {
  it('holds what VS Code holds of it, so a user-level value is not the workspace value', () => {
    inspected = { workspaceValue: undefined };

    expect(deploymentFolderSetting.inspect()).toEqual({ workspaceValue: undefined });
  });

  it('names a folder by its last part, whatever follows it', () => {
    expect(deploymentFolderSetting.nameOf('/games/deploy/')).toBe('deploy');
  });
});
