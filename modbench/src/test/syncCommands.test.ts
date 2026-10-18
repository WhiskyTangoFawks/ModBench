import { describe, it, expect, vi } from 'vitest';
import { present } from '../ports/present';
import { registerSyncCommands } from '../syncWiring';

const syncDouble = () => ({
  run: vi.fn(() => Promise.resolve()),
  message: () => undefined,
  onMessageChanged: () => ({ dispose: () => undefined }),
  settled: () => Promise.resolve(),
});

describe('the sync commands', () => {
  it.each([
    ['modbench.mod.sync', { mod: 1, plugin: 0 }],
    ['modbench.plugin.sync', { mod: 0, plugin: 1 }],
  ] as const)('%s runs its own sync', async (command, expected) => {
    const handlers = new Map<string, () => unknown>();
    const modSync = syncDouble();
    const pluginSync = syncDouble();
    registerSyncCommands(
      (id, handler) => { handlers.set(id, handler); return { dispose: () => undefined }; },
      { modSync, pluginSync },
    );

    await present(handlers.get(command), `the ${command} handler`)();

    expect({ mod: modSync.run.mock.calls.length, plugin: pluginSync.run.mock.calls.length }).toEqual(expected);
  });
});
