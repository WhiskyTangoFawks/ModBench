import { describe, it, expect, vi } from 'vitest';
vi.mock('vscode', () => ({ commands: { registerCommand: vi.fn() } }));

import { present } from '../../ports/present';
import { registerPluginSyncCommand } from '../pluginSync';

describe('the plugin sync command', () => {
  it('is modbench.plugin.sync, and runs the plugin sync', async () => {
    const handlers = new Map<string, () => unknown>();
    const pluginSync = { run: vi.fn(() => Promise.resolve()) };
    registerPluginSyncCommand(pluginSync, (id, handler) => { handlers.set(id, handler); return { dispose: () => undefined }; });

    await present(handlers.get('modbench.plugin.sync'), 'the modbench.plugin.sync handler')();

    expect([[...handlers.keys()], pluginSync.run.mock.calls.length]).toEqual([['modbench.plugin.sync'], 1]);
  });
});
