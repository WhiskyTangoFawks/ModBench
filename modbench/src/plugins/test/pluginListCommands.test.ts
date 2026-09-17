import { describe, it, expect, vi, beforeEach } from 'vitest';

// Captures every registerCommand(id, handler) so the row's handler can be invoked directly.
const {
  handlers, registerCommand, executeCommand, showInputBox, showQuickPick,
} = vi.hoisted(() => {
  const handlers = new Map<string, (ctx?: unknown) => Promise<void> | void>();
  return {
    handlers,
    registerCommand: vi.fn((command: string, handler: (ctx?: unknown) => Promise<void> | void) => {
      handlers.set(command, handler);
      return { dispose: vi.fn() };
    }),
    executeCommand: vi.fn(),
    showInputBox: vi.fn(),
    showQuickPick: vi.fn(),
  };
});

vi.mock('vscode', () => ({
  commands: { registerCommand, executeCommand },
  window: { showInputBox, showQuickPick },
  Uri: { file: (p: string) => ({ fsPath: p }) },
}));

vi.mock('../../modmanager/commands/plugins', () => ({ appendPlugin: vi.fn() }));

import { registerCreatePluginCommand, registerRevealInExplorerCommand } from '../pluginListCommands';
import { appendPlugin } from '../../modmanager/commands/plugins';
import { InMemoryMEditClient } from '../../medit/client';
import { recordingReporter } from '../../test/surfacingDoubles';
import { instanceValueFixture } from '../../modmanager/test/instanceValueFixture';
import { present } from '../../ports/present';

beforeEach(() => {
  handlers.clear();
  vi.clearAllMocks();
});

function makeMo2() {
  return {
    instance: { value: instanceValueFixture() },
    instanceRoot: '/instance',
    pluginsTree: { invalidate: vi.fn() },
  };
}

describe('registerCreatePluginCommand', () => {
  function invoke(client: InMemoryMEditClient, mo2: ReturnType<typeof makeMo2> | undefined) {
    const reporter = recordingReporter();
    registerCreatePluginCommand(client, mo2, reporter);
    return { run: present(handlers.get('modbench.newPlugin'), "the newPlugin command's registered handler"), reporter };
  }

  it('appends the created plugin to the load order and lands the created toast', async () => {
    const client = new InMemoryMEditClient();
    client.setCommandResult('createPlugin', { name: 'MyPatch.esp', path: '/mods/MyMod/MyPatch.esp', origin: 'MyMod', slot: null, version: 1 });
    const mo2 = makeMo2();
    showInputBox.mockResolvedValue('MyPatch.esp');
    showQuickPick.mockResolvedValue({ choice: 'overwrite' });
    vi.mocked(appendPlugin).mockResolvedValue({ applied: true, wrote: true });

    const { run, reporter } = invoke(client, mo2);
    await run();

    expect(client.calls).toContainEqual({ method: 'createPlugin', args: ['MyPatch.esp', '/instance/overwrite', 'overwrite'] });
    expect(appendPlugin).toHaveBeenCalledWith('/instance', 'Default', 'MyPatch.esp');
    expect(reporter.landings).toEqual(['Created "MyPatch.esp".']);
    expect(reporter.reports).toEqual([]);
  });

  // The rival: landing the created toast (or appending to the load order) on a refusal too would
  // add a plugins.txt line for a file the backend never actually wrote.
  it('reports the ready-to-show message at error and never appends to the load order when the backend refuses', async () => {
    const client = new InMemoryMEditClient();
    client.setCommandResult('createPlugin', { refused: true, message: 'mEdit: Failed to create plugin — Bad Request' });
    const mo2 = makeMo2();
    showInputBox.mockResolvedValue('MyPatch.esp');
    showQuickPick.mockResolvedValue({ choice: 'overwrite' });

    const { run, reporter } = invoke(client, mo2);
    await run();

    expect(reporter.reports).toEqual([
      { severity: 'error', message: 'mEdit: Failed to create plugin — Bad Request', detail: undefined },
    ]);
    expect(appendPlugin).not.toHaveBeenCalled();
    expect(reporter.landings).toEqual([]);
  });

  // ADR-0007: the create landed, so the file exists — only its load-order line is missing, and
  // the user is told that much rather than a bare "created".
  it('reports a failed load-order append at error with the refusal as its detail, never the created toast', async () => {
    const client = new InMemoryMEditClient();
    client.setCommandResult('createPlugin', { name: 'MyPatch.esp', path: '/mods/MyMod/MyPatch.esp', origin: 'MyMod', slot: null, version: 1 });
    const mo2 = makeMo2();
    showInputBox.mockResolvedValue('MyPatch.esp');
    showQuickPick.mockResolvedValue({ choice: 'overwrite' });
    vi.mocked(appendPlugin).mockResolvedValue({ applied: false, refusal: 'plugins.txt is read-only' });

    const { run, reporter } = invoke(client, mo2);
    await run();

    expect(reporter.reports).toEqual([{
      severity: 'error',
      message: 'Created "MyPatch.esp", but could not add it to the load order — add it manually in the Plugins tree.',
      detail: 'plugins.txt is read-only',
    }]);
    expect(reporter.landings).toEqual([]);
  });

  it('reports the missing-workspace refusal at error and prompts for nothing', async () => {
    const { run, reporter } = invoke(new InMemoryMEditClient(), undefined);

    await run();

    expect(reporter.reports).toEqual([
      { severity: 'error', message: 'New Plugin needs an open MO2 instance workspace.', detail: undefined },
    ]);
    expect(showInputBox).not.toHaveBeenCalled();
  });
});

describe('registerRevealInExplorerCommand', () => {
  function invoke(resolvePluginPath: () => Promise<string | undefined>) {
    const reporter = recordingReporter();
    registerRevealInExplorerCommand({ resolvePluginPath }, reporter);
    return { run: present(handlers.get('modbench.pluginListTree.revealInExplorer'), "the revealInExplorer command's registered handler"), reporter };
  }

  it('reveals the resolved file in the OS explorer and says nothing', async () => {
    const { run, reporter } = invoke(() => Promise.resolve('/instance/mods/MyMod/MyMod.esp'));

    await run({ kind: 'plugin', plugin: { name: 'MyMod.esp' } });

    expect(executeCommand).toHaveBeenCalledWith('revealFileInOS', { fsPath: '/instance/mods/MyMod/MyMod.esp' });
    expect(reporter.reports).toEqual([]);
    expect(reporter.landings).toEqual([]);
  });

  it('reports an unresolved file location at error rather than doing nothing', async () => {
    const { run, reporter } = invoke(() => Promise.resolve(undefined));

    await run({ kind: 'plugin', plugin: { name: 'MyMod.esp' } });

    expect(reporter.reports).toEqual([
      { severity: 'error', message: 'Could not resolve a file location for "MyMod.esp".', detail: undefined },
    ]);
    expect(executeCommand).not.toHaveBeenCalled();
  });

  it('reports a rejected reveal at error with the thrown message as its detail', async () => {
    executeCommand.mockRejectedValue(new Error('no file manager'));
    const { run, reporter } = invoke(() => Promise.resolve('/instance/mods/MyMod/MyMod.esp'));

    await run({ kind: 'plugin', plugin: { name: 'MyMod.esp' } });

    expect(reporter.reports).toEqual([
      { severity: 'error', message: 'Failed to reveal "MyMod.esp" in Explorer.', detail: 'no file manager' },
    ]);
  });
});
