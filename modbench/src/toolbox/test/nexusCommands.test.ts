import { describe, it, expect, vi, beforeEach } from 'vitest';

interface PromptOptions { password?: boolean; validateInput: (value: string) => Promise<string | undefined> }

const { handlers, registerCommand, executeCommand, showInputBox } = vi.hoisted(() => {
  const handlers = new Map<string, () => Promise<void>>();
  return {
    handlers,
    registerCommand: vi.fn((command: string, handler: () => Promise<void>) => {
      handlers.set(command, handler);
      return { dispose: vi.fn() };
    }),
    executeCommand: vi.fn(),
    showInputBox: vi.fn<(options: PromptOptions) => Promise<string | undefined>>(),
  };
});

vi.mock('vscode', () => ({
  commands: { registerCommand, executeCommand },
  window: { showInputBox },
}));

import { registerNexusCommands } from '../nexusCommands';
import { present } from '../../ports/present';
import type { Nexus } from '../../nexus/nexus';

const LOGGED_IN_KEY = 'modbench.nexus.loggedIn';

function fakeNexus(over: Partial<Nexus> = {}) {
  const nexus = {
    check: vi.fn<Nexus['check']>(() => Promise.resolve({ valid: true })),
    keep: vi.fn<Nexus['keep']>(() => Promise.resolve()),
    forget: vi.fn<Nexus['forget']>(() => Promise.resolve()),
    loggedIn: vi.fn<Nexus['loggedIn']>(() => Promise.resolve(false)),
    ...over,
  };
  registerNexusCommands({ nexus });
  return nexus;
}

const run = (id: string) => present(handlers.get(id), `the registered handler for "${id}"`)();
const promptOptions = () => present(showInputBox.mock.calls[0]?.[0], 'the options the prompt opened with');

beforeEach(() => {
  handlers.clear();
  vi.clearAllMocks();
});

describe('Log in', () => {
  it('prompts for the key as a password, which Esc closes without keeping anything', async () => {
    showInputBox.mockResolvedValue(undefined);
    const nexus = fakeNexus();

    await run('modbench.instance.logIn');

    expect(promptOptions().password).toBe(true);
    expect(nexus.keep).not.toHaveBeenCalled();
    expect(executeCommand).not.toHaveBeenCalledWith('setContext', LOGGED_IN_KEY, true);
  });

  it('refuses in the prompt a key Nexus refuses, with Nexus\'s reason', async () => {
    showInputBox.mockResolvedValue(undefined);
    const nexus = fakeNexus({ check: vi.fn(() => Promise.resolve({ valid: false, reason: 'Nexus refused this key.' })) });

    await run('modbench.instance.logIn');

    expect(await promptOptions().validateInput('bad')).toBe('Nexus refused this key.');
    expect(nexus.check).toHaveBeenCalledWith('bad');
  });

  it('lets the prompt accept a key Nexus accepts', async () => {
    showInputBox.mockResolvedValue(undefined);
    fakeNexus();

    await run('modbench.instance.logIn');

    expect(await promptOptions().validateInput('good')).toBeUndefined();
  });

  it('keeps the accepted key and marks the user logged in', async () => {
    showInputBox.mockResolvedValue('good');
    const nexus = fakeNexus();

    await run('modbench.instance.logIn');

    expect(nexus.keep).toHaveBeenCalledWith('good');
    expect(executeCommand).toHaveBeenCalledWith('setContext', LOGGED_IN_KEY, true);
  });
});

describe('Log out', () => {
  it('forgets the key and marks the user logged out, asking nothing', async () => {
    const nexus = fakeNexus();

    await run('modbench.instance.logOut');

    expect(nexus.forget).toHaveBeenCalled();
    expect(executeCommand).toHaveBeenCalledWith('setContext', LOGGED_IN_KEY, false);
    expect(showInputBox).not.toHaveBeenCalled();
  });
});

describe('Registration', () => {
  it('marks the user logged in when a key is already kept', async () => {
    fakeNexus({ loggedIn: vi.fn(() => Promise.resolve(true)) });

    await vi.waitFor(() => expect(executeCommand).toHaveBeenCalledWith('setContext', LOGGED_IN_KEY, true));
  });
});
