import { afterEach, describe, it, expect, vi } from 'vitest';

type ConfigListener = (change: { affectsConfiguration(section: string): boolean }) => void;
let configListener: ConfigListener | undefined;
let terminalSettings: Record<string, Record<string, string | null> | undefined> = {};

vi.mock('vscode', () => ({
  workspace: {
    getConfiguration: () => ({ get: (key: string) => terminalSettings[key] }),
    onDidChangeConfiguration: (listener: ConfigListener) => {
      configListener = listener;
      return { dispose: () => { configListener = undefined; } };
    },
  },
}));

import { inheritedPythonPath, onGameDirectoryChange, onTerminalEnvChange } from '../workspaceConfig';

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

describe('the terminal environment', () => {
  const platform = process.platform;
  const hostPythonPath = process.env.PYTHONPATH;
  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: platform });
    process.env.PYTHONPATH = hostPythonPath;
    terminalSettings = {};
  });

  it.each([['linux', 'env.linux'], ['darwin', 'env.osx'], ['win32', 'env.windows']])(
    'gives %s terminals the PYTHONPATH the user sets for them, ahead of the extension host\'s own',
    (os, setting) => {
      Object.defineProperty(process, 'platform', { value: os });
      process.env.PYTHONPATH = '/host';
      terminalSettings = { [setting]: { PYTHONPATH: '/user' } };

      expect(inheritedPythonPath()).toBe('/user');
    },
  );

  it('gives terminals the extension host\'s own PYTHONPATH when the setting names none', () => {
    process.env.PYTHONPATH = '/host';
    terminalSettings = { 'env.linux': { OTHER: 'x' } };

    expect(inheritedPythonPath()).toBe('/host');
  });

  it('signals for this platform\'s terminal environment setting and for no other', () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    const listener = vi.fn();
    onTerminalEnvChange(listener);

    changeTo('terminal.integrated.env.linux');
    expect(listener).not.toHaveBeenCalled();

    changeTo('terminal.integrated.env.windows');
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
