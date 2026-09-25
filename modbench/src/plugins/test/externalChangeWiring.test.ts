import { describe, it, expect, vi, beforeEach } from 'vitest';

// Every refusal goes through the injected reporter (ADR-0019) — the log line and the toast come
// from the same call, not a raw `vscode.window.showErrorMessage`.
const { showErrorMessage, showWarningMessage, subscribeQuestionOpen } = vi.hoisted(() => ({
  showErrorMessage: vi.fn(),
  showWarningMessage: vi.fn(),
  subscribeQuestionOpen: vi.fn(
    (_deps: { reporter: unknown; showDialog: unknown; presentCrashRepair: unknown }, _client: unknown) => () => {}),
}));

import { EventEmitter, TreeItem, TreeItemCollapsibleState, ThemeIcon, ThemeColor } from '../../test/vscodeMock';

vi.mock('vscode', () => ({
  window: { showErrorMessage, showWarningMessage },
  EventEmitter, TreeItem, TreeItemCollapsibleState, ThemeIcon, ThemeColor,
}));

vi.mock('../externalChangeCoordinator', () => ({
  subscribeQuestionOpen,
}));

import { wireQuestionOpen } from '../externalChangeWiring';
import { PluginTreeProvider } from '../PluginTreeProvider';
import { InMemoryMEditClient } from '../../client';
import { FakeLogOutputChannel } from '../../test/fakeOutputChannel';
import { recordingReporter, scriptedDialog } from '../../test/surfacingDoubles';
import { present } from '../../ports/present';

function wire(askQuestion = scriptedDialog(), presentCrashRepair = vi.fn().mockResolvedValue(undefined)) {
  const outputChannel = new FakeLogOutputChannel();
  const client = new InMemoryMEditClient();
  const treeProvider = new PluginTreeProvider(client);
  const reporter = recordingReporter();
  wireQuestionOpen(client, outputChannel, treeProvider, vi.fn(), askQuestion, presentCrashRepair, reporter);
  return {
    outputChannel, reporter,
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

  // How an error reaches the user is the reporter port's (ADR-0019); what this wiring owes is
  // that the coordinator's refusals reach the reporter it was handed.
  it('hands the coordinator the reporter it was given', () => {
    const { reporter, deps } = wire();

    expect(deps.reporter).toBe(reporter);
  });
});
