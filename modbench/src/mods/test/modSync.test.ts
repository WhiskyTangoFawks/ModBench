import { describe, it, expect, vi } from 'vitest';
vi.mock('vscode', () => ({ commands: { registerCommand: vi.fn() } }));

import { present } from '../../ports/present';
import { registerModSyncCommand } from '../modSync';

describe('the mod sync command', () => {
  it('is modbench.mod.sync, and runs the mod sync', async () => {
    const handlers = new Map<string, () => unknown>();
    const modSync = { run: vi.fn(() => Promise.resolve()) };
    registerModSyncCommand(modSync, (id, handler) => { handlers.set(id, handler); return { dispose: () => undefined }; });

    await present(handlers.get('modbench.mod.sync'), 'the modbench.mod.sync handler')();

    expect([[...handlers.keys()], modSync.run.mock.calls.length]).toEqual([['modbench.mod.sync'], 1]);
  });
});
