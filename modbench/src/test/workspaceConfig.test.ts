import { describe, it, expect, vi } from 'vitest';

type ConfigListener = (change: { affectsConfiguration(section: string): boolean }) => void;
let inspected: { workspaceValue?: string } | undefined;
let configListener: ConfigListener | undefined;

vi.mock('vscode', () => ({
  workspace: {
    getConfiguration: () => ({ inspect: () => inspected }),
    onDidChangeConfiguration: (listener: ConfigListener) => {
      configListener = listener;
      return { dispose: () => { configListener = undefined; } };
    },
  },
}));

import { deploymentFolderSetting, gameFolderSetting, onStringsLanguageChange } from '../workspaceConfig';

const changeTo = (key: string): void => configListener?.({ affectsConfiguration: (section) => section === key });

describe('a setting change signals the listener of that setting', () => {
  it.each([
    ['the game folder', 'modbench.mods.gameFolder', gameFolderSetting.changed],
    ['the strings language', 'modbench.stringsLanguage', onStringsLanguageChange],
  ])('%s, on a change to %s', (_, key, onChange) => {
    const listener = vi.fn();
    onChange(listener);

    changeTo(key);

    expect(listener).toHaveBeenCalledTimes(1);
  });
});

describe('the deployment folder setting', () => {
  it('holds what VS Code holds of it, so a user-level value is not the workspace value', () => {
    inspected = { workspaceValue: undefined };

    expect(deploymentFolderSetting.inspect()).toEqual({ workspaceValue: undefined });
  });
});
