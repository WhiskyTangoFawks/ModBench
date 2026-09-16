import { describe, it, expect, vi, beforeEach } from 'vitest';

// `showError` must go through the injected reporter (ADR-0019) — the log line and the toast
// come from the same call, not a raw `vscode.window.showErrorMessage`.
const { showErrorMessage, showWarningMessage, subscribeQuestionOpen } = vi.hoisted(() => ({
  showErrorMessage: vi.fn(),
  showWarningMessage: vi.fn(),
  subscribeQuestionOpen: vi.fn(
    (_deps: { showError: (message: string) => void; showDialog: unknown; presentCrashRepair: unknown }, _client: unknown) => () => {}),
}));

import { EventEmitter, TreeItem, TreeItemCollapsibleState, ThemeIcon, ThemeColor } from '../../test/vscodeMock';

vi.mock('vscode', () => ({
  window: { showErrorMessage, showWarningMessage },
  EventEmitter, TreeItem, TreeItemCollapsibleState, ThemeIcon, ThemeColor,
}));

vi.mock('../../medit/externalChangeCoordinator', () => ({
  subscribeQuestionOpen,
}));

import { wireQuestionOpen } from '../externalChangeWiring';
import { PluginTreeProvider } from '../PluginTreeProvider';
import { InMemoryMEditClient } from '../../medit/client';
import { FakeLogOutputChannel } from '../../test/fakeOutputChannel';
import { scriptedDialog } from '../../test/surfacingDoubles';
import { present } from '../../present';

function wire(askQuestion = scriptedDialog(), presentCrashRepair = vi.fn().mockResolvedValue(undefined)) {
  const outputChannel = new FakeLogOutputChannel();
  const client = new InMemoryMEditClient();
  const treeProvider = new PluginTreeProvider(client);
  wireQuestionOpen(client, outputChannel, treeProvider, vi.fn(), askQuestion, presentCrashRepair);
  return {
    outputChannel,
    deps: present(subscribeQuestionOpen.mock.calls[0], "wireQuestionOpen's call to the coordinator")[0],
  };
}

describe('wireQuestionOpen', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('hands the coordinator the dialog it was given, never one of its own', () => {
    const askQuestion = scriptedDialog();

    expect(wire(askQuestion).deps.showDialog).toBe(askQuestion);
  });

  it('hands the coordinator the crash-repair presenter it was given', () => {
    const presentCrashRepair = vi.fn().mockResolvedValue(undefined);

    expect(wire(scriptedDialog(), presentCrashRepair).deps.presentCrashRepair).toBe(presentCrashRepair);
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
