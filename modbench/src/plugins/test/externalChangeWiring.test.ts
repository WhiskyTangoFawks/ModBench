import { describe, it, expect, vi } from 'vitest';

// `showError` must go through the injected reporter (ADR-0026) — the log line and the toast
// come from the same call, not a raw `vscode.window.showErrorMessage`.
const { showErrorMessage, showWarningMessage, subscribeExternalChangePending } = vi.hoisted(() => ({
  showErrorMessage: vi.fn(),
  showWarningMessage: vi.fn(),
  subscribeExternalChangePending: vi.fn((_deps: { showError: (message: string) => void }, _client: unknown) => () => {}),
}));

vi.mock('vscode', () => ({
  window: { showErrorMessage, showWarningMessage },
}));

vi.mock('../../medit/externalChangeCoordinator', () => ({
  subscribeExternalChangePending,
}));

import { wireExternalChangePending } from '../externalChangeWiring';

function fakeOutputChannel() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as import('vscode').LogOutputChannel;
}

describe('wireExternalChangePending', () => {
  it('routes a gesture refusal through the reporter: logged and toasted with the "Modbench: " prefix', () => {
    const outputChannel = fakeOutputChannel();
    const client = {} as Parameters<typeof wireExternalChangePending>[0];
    const treeProvider = { refresh: vi.fn() } as unknown as Parameters<typeof wireExternalChangePending>[2];

    wireExternalChangePending(client, outputChannel, treeProvider, vi.fn());

    const deps = subscribeExternalChangePending.mock.calls[0][0];
    deps.showError('mEdit: Could not keep "ModA" as your own edit — x');

    expect(outputChannel.error).toHaveBeenCalledWith(
      '[externalChange] error: mEdit: Could not keep "ModA" as your own edit — x',
    );
    expect(showErrorMessage).toHaveBeenCalledWith('Modbench: mEdit: Could not keep "ModA" as your own edit — x');
  });
});
