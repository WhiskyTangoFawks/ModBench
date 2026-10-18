import { describe, it, expect, vi } from 'vitest';
import { registerSyncCommands } from '../syncWiring';

describe('the sync commands', () => {
  it.each([
    ['modbench.mod.sync', { mod: 1, plugin: 0 }],
    ['modbench.plugin.sync', { mod: 0, plugin: 1 }],
  ] as const)('%s runs its own sync', async (command, expected) => {
    const handlers = new Map<string, () => unknown>();
    const modSync = { run: vi.fn(() => Promise.resolve()) };
    const pluginSync = { run: vi.fn(() => Promise.resolve()) };
    const disposables = registerSyncCommands(
      (id, handler) => { handlers.set(id, handler); return { dispose: () => undefined }; },
      { modSync, pluginSync },
    );

    await handlers.get(command)?.();

    expect(disposables).toHaveLength(2);
    expect({ mod: modSync.run.mock.calls.length, plugin: pluginSync.run.mock.calls.length }).toEqual(expected);
  });
});
