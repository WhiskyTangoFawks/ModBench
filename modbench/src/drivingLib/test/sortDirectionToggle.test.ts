import { describe, it, expect, vi, beforeEach } from 'vitest';

const { handlers, executeCommand } = vi.hoisted(() => ({
  handlers: new Map<string, () => void>(),
  executeCommand: vi.fn<(...args: unknown[]) => unknown>(),
}));

vi.mock('vscode', () => ({
  commands: {
    registerCommand: vi.fn((command: string, handler: () => void) => {
      handlers.set(command, handler);
      return { dispose: vi.fn() };
    }),
    executeCommand,
  },
}));

import { registerSortDirectionToggle } from '../sortDirectionToggle';

beforeEach(() => {
  handlers.clear();
  vi.clearAllMocks();
});

describe('registerSortDirectionToggle', () => {
  const directionKeys = () => executeCommand.mock.calls
    .filter((c) => c[0] === 'setContext' && c[1] === 'modbench.thing.winningAtTop')
    .map((c) => c[2]);
  const run = (command: string) => {
    const handler = handlers.get(command);
    if (!handler) throw new Error(`${command} was not registered`);
    handler();
  };

  it('starts losing at the top, and sets the title-bar icon\'s key to agree without waiting for a toggle, as a context key outlives an extension host restart', () => {
    const setViewDirection = vi.fn();
    registerSortDirectionToggle('thing', { setViewDirection });

    expect(setViewDirection).not.toHaveBeenCalled();
    expect(directionKeys()).toEqual([false]);
  });

  it('each title-bar icon sets its own direction, whatever the view last showed', () => {
    const setViewDirection = vi.fn();
    registerSortDirectionToggle('thing', { setViewDirection });

    run('modbench.thing.sortLosingAtTop');
    run('modbench.thing.sortWinningAtTop');
    run('modbench.thing.sortWinningAtTop');

    expect(setViewDirection.mock.calls).toEqual([['losingAtTop'], ['winningAtTop'], ['winningAtTop']]);
    expect(directionKeys()).toEqual([false, false, true, true]);
  });
});
