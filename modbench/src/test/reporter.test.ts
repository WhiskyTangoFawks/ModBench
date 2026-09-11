import { describe, it, expect, vi, beforeEach } from 'vitest';

// makeReporter is the ADR-0019 surfacing reporter (log always, toast on warning/error), pulled
// out of extension.ts — which imports the real 'vscode' module — so its severity→level dispatch
// has a real seam.
const { showErrorMessage, showWarningMessage, showInformationMessage } = vi.hoisted(() => ({
  showErrorMessage: vi.fn(),
  showWarningMessage: vi.fn(),
  showInformationMessage: vi.fn(),
}));
vi.mock('vscode', () => ({ window: { showErrorMessage, showWarningMessage, showInformationMessage } }));

import { makeReporter } from '../reporter';

// Every level a real LogOutputChannel offers, not just the two the parameter type admits, so a
// test can assert a landing wrote *nothing* rather than only that it skipped warn and error.
function fakeChannel() {
  return {
    trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(),
    append: vi.fn(), appendLine: vi.fn(),
  };
}

function channelWrites(channel: ReturnType<typeof fakeChannel>): unknown[][] {
  return Object.values(channel).flatMap((spy) => spy.mock.calls);
}

describe('makeReporter', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('logs an error severity to the channel\'s .error() and shows an error toast', () => {
    const channel = fakeChannel();
    makeReporter(channel, 'deploy').report('error', 'Deploy failed.', 'disk full');
    expect(channel.error).toHaveBeenCalledWith('[deploy] error: Deploy failed. — disk full');
    expect(channel.warn).not.toHaveBeenCalled();
    expect(showErrorMessage).toHaveBeenCalledWith('Modbench: Deploy failed.');
  });

  it('logs a warning severity to the channel\'s .warn() and shows a warning toast', () => {
    const channel = fakeChannel();
    makeReporter(channel, 'modList').report('warning', 'Could not read the mod list.');
    expect(channel.warn).toHaveBeenCalledWith('[modList] warning: Could not read the mod list.');
    expect(channel.error).not.toHaveBeenCalled();
    expect(showWarningMessage).toHaveBeenCalledWith('Modbench: Could not read the mod list.');
  });

  it('shows a landed gesture as an information toast and writes nothing to the log', () => {
    const channel = fakeChannel();
    makeReporter(channel, 'deploy').landed('Mods deployed.');
    expect(showInformationMessage).toHaveBeenCalledWith('Modbench: Mods deployed.');
    expect(channelWrites(channel)).toEqual([]);
    expect(showWarningMessage).not.toHaveBeenCalled();
    expect(showErrorMessage).not.toHaveBeenCalled();
  });
});
