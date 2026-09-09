import { describe, it, expect, vi, beforeEach } from 'vitest';

// Captures every registerCommand(id, handler) so the row's handler can be invoked directly.
const {
  handlers, registerCommand, showInputBox, showQuickPick, showInformationMessage, showErrorMessage,
} = vi.hoisted(() => {
  const handlers = new Map<string, (ctx?: unknown) => Promise<void> | void>();
  return {
    handlers,
    registerCommand: vi.fn((command: string, handler: (ctx?: unknown) => Promise<void> | void) => {
      handlers.set(command, handler);
      return { dispose: vi.fn() };
    }),
    showInputBox: vi.fn(),
    showQuickPick: vi.fn(),
    showInformationMessage: vi.fn(),
    showErrorMessage: vi.fn(),
  };
});

vi.mock('vscode', () => ({
  commands: { registerCommand },
  window: { showInputBox, showQuickPick, showInformationMessage, showErrorMessage },
}));

vi.mock('../../modmanager/commands/plugins', () => ({ appendPlugin: vi.fn() }));

import { registerCreatePluginCommand } from '../pluginListCommands';
import { appendPlugin } from '../../modmanager/commands/plugins';

beforeEach(() => {
  handlers.clear();
  vi.clearAllMocks();
});

function fakeOutputChannel() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as any;
}

function makeMo2() {
  return {
    instance: { value: { mods: [] } },
    instanceRoot: '/instance',
    pluginsTree: { invalidate: vi.fn() },
  } as any;
}

describe('registerCreatePluginCommand', () => {
  function invoke(controller: any, mo2: any) {
    registerCreatePluginCommand(controller, mo2, fakeOutputChannel());
    return handlers.get('modbench.newPlugin')!;
  }

  it('appends the created plugin to the load order and shows the created toast', async () => {
    const controller = { createPlugin: vi.fn().mockResolvedValue({ name: 'MyPatch.esp', path: '/mods/MyMod/MyPatch.esp', origin: 'MyMod', slot: null }) };
    const mo2 = makeMo2();
    showInputBox.mockResolvedValue('MyPatch.esp');
    showQuickPick.mockResolvedValue({ choice: 'overwrite' });
    vi.mocked(appendPlugin).mockResolvedValue({ applied: true } as any);

    await invoke(controller, mo2)();

    expect(appendPlugin).toHaveBeenCalledWith('/instance', undefined, 'MyPatch.esp');
    expect(showInformationMessage).toHaveBeenCalledWith('Modbench: Created "MyPatch.esp".');
  });

  // The rival: showing the created toast (or appending to the load order) on a refusal too would
  // add a plugins.txt line for a file the backend never actually wrote.
  it('shows the ready-to-show message and never appends to the load order when the backend refuses', async () => {
    const controller = { createPlugin: vi.fn().mockResolvedValue({ refused: true, message: 'mEdit: Failed to create plugin — Bad Request' }) };
    const mo2 = makeMo2();
    showInputBox.mockResolvedValue('MyPatch.esp');
    showQuickPick.mockResolvedValue({ choice: 'overwrite' });

    await invoke(controller, mo2)();

    expect(showErrorMessage).toHaveBeenCalledWith('mEdit: Failed to create plugin — Bad Request');
    expect(appendPlugin).not.toHaveBeenCalled();
    expect(showInformationMessage).not.toHaveBeenCalled();
  });
});
