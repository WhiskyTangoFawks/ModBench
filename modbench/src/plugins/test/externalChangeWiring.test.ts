import { describe, it, expect, vi, beforeEach } from 'vitest';

// `showError` must go through the injected reporter (ADR-0019) — the log line and the toast
// come from the same call, not a raw `vscode.window.showErrorMessage`.
const { showErrorMessage, showWarningMessage, subscribeQuestionOpen } = vi.hoisted(() => ({
  showErrorMessage: vi.fn(),
  showWarningMessage: vi.fn(),
  subscribeQuestionOpen: vi.fn(
    (_deps: { showError: (message: string) => void; showDialog: unknown }, _client: unknown) => () => {}),
}));

vi.mock('vscode', () => ({
  window: { showErrorMessage, showWarningMessage },
}));

vi.mock('../../medit/externalChangeCoordinator', () => ({
  subscribeQuestionOpen,
}));

import { wireQuestionOpen } from '../externalChangeWiring';
import { scriptedDialog } from '../../test/surfacingDoubles';

function fakeOutputChannel() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as import('vscode').LogOutputChannel;
}

function wire(askQuestion = scriptedDialog()) {
  const outputChannel = fakeOutputChannel();
  const client = {} as Parameters<typeof wireQuestionOpen>[0];
  const treeProvider = { refresh: vi.fn() } as unknown as Parameters<typeof wireQuestionOpen>[2];
  wireQuestionOpen(client, outputChannel, treeProvider, vi.fn(), askQuestion);
  return { outputChannel, deps: subscribeQuestionOpen.mock.calls[0]![0] };
}

describe('wireQuestionOpen', () => {
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
