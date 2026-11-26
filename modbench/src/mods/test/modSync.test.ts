import { describe, it, expect, vi } from 'vitest';

const { registerCommand } = vi.hoisted(() => ({ registerCommand: vi.fn((_id: string, _handler: () => unknown) => ({ dispose: () => undefined })) }));
vi.mock('vscode', () => ({ commands: { registerCommand } }));

import { present } from '../../ports/present';
import { registerModSyncCommand } from '../modSync';

describe('the mod sync command', () => {
  it('is modbench.mod.sync, and runs the mod sync', async () => {
    const modSync = { run: vi.fn(() => Promise.resolve(undefined)) };
    registerModSyncCommand(modSync);

    const [id, handler] = present(registerCommand.mock.calls[0], 'the command registered');
    await handler();

    expect([id, modSync.run.mock.calls.length]).toEqual(['modbench.mod.sync', 1]);
  });
});
