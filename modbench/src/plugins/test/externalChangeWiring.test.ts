import { describe, it, expect, vi, beforeEach } from 'vitest';

// `showError` must go through the injected reporter (ADR-0019) — the log line and the toast
// come from the same call, not a raw `vscode.window.showErrorMessage`.
const { showErrorMessage, showWarningMessage, subscribeExternalChangePending } = vi.hoisted(() => ({
  showErrorMessage: vi.fn(),
  showWarningMessage: vi.fn(),
  subscribeExternalChangePending: vi.fn(
    (_deps: { showError: (message: string) => void; showDialog: unknown }, _client: unknown) => () => {}),
}));

import { EventEmitter, TreeItem, TreeItemCollapsibleState, ThemeIcon, ThemeColor } from '../../test/vscodeMock';

vi.mock('vscode', () => ({
  window: { showErrorMessage, showWarningMessage },
  EventEmitter, TreeItem, TreeItemCollapsibleState, ThemeIcon, ThemeColor,
}));

vi.mock('../../medit/externalChangeCoordinator', () => ({
  subscribeExternalChangePending,
}));

import { wireExternalChangePending } from '../externalChangeWiring';
import { PluginTreeProvider } from '../PluginTreeProvider';
import { InMemoryMEditClient } from '../../medit/client';
import { FakeLogOutputChannel } from '../../test/fakeOutputChannel';
import { scriptedDialog } from '../../test/surfacingDoubles';

function wire(askQuestion = scriptedDialog()) {
  const outputChannel = new FakeLogOutputChannel();
  const client = new InMemoryMEditClient();
  const treeProvider = new PluginTreeProvider(client);
  wireExternalChangePending(client, outputChannel, treeProvider, vi.fn(), askQuestion);
  return { outputChannel, deps: subscribeExternalChangePending.mock.calls[0]![0] };
}

describe('wireExternalChangePending', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('hands the coordinator the dialog it was given, never one of its own', () => {
    const askQuestion = scriptedDialog();

    expect(wire(askQuestion).deps.showDialog).toBe(askQuestion);
  });

  it('routes a gesture refusal through the reporter: logged and toasted with the "Modbench: " prefix', () => {
    const { outputChannel, deps } = wire();
    deps.showError('Could not keep "ModA" as your own edit — x');

    expect(outputChannel.error).toHaveBeenCalledWith(
      '[externalChange] error: Could not keep "ModA" as your own edit — x',
    );
    expect(showErrorMessage).toHaveBeenCalledWith('Modbench: Could not keep "ModA" as your own edit — x');
  });
});
