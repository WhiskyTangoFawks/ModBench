import { describe, it, expect, vi } from 'vitest';

type ConfigListener = (change: { affectsConfiguration(section: string): boolean }) => void;
let configListener: ConfigListener | undefined;

vi.mock('vscode', () => ({
  workspace: {
    getConfiguration: () => ({ get: () => undefined }),
    onDidChangeConfiguration: (listener: ConfigListener) => {
      configListener = listener;
      return { dispose: () => { configListener = undefined; } };
    },
  },
}));

import { gameFolderSetting, onStringsLanguageChange, stringsLanguage } from '../workspaceConfig';

const changeTo = (key: string): void => configListener?.({ affectsConfiguration: (section) => section === key });

describe('the game folder setting', () => {
  it('signals for the game-folder setting and for no other key', () => {
    const listener = vi.fn();
    gameFolderSetting.changed(listener);

    changeTo('modbench.mods.somethingElse');
    expect(listener).not.toHaveBeenCalled();

    changeTo('modbench.mods.gameFolder');
    expect(listener).toHaveBeenCalledTimes(1);
  });
});

describe('onStringsLanguageChange', () => {
  it('signals for the strings language setting and for no other key', () => {
    const listener = vi.fn();
    onStringsLanguageChange(listener);

    changeTo('modbench.agent.port');
    expect(listener).not.toHaveBeenCalled();

    changeTo('modbench.stringsLanguage');
    expect(listener).toHaveBeenCalledTimes(1);
  });
});

describe('stringsLanguage', () => {
  it('fails loudly when the setting has no value, rather than inventing a default the manifest owns', () => {
    expect(() => stringsLanguage()).toThrow('modbench.stringsLanguage has no value');
  });
});
