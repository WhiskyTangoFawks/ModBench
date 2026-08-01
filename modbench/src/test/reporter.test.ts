import { describe, it, expect, vi } from 'vitest';

// #198: makeReporter is the ADR-0026 surfacing reporter (log always, toast on
// warning/error) — pulled out of extension.ts (which imports the real 'vscode'
// module and can't be unit-tested directly) so its severity→level dispatch has a
// real seam, matching the existing recordPanelMessageRouter.ts precedent.
const { showErrorMessage, showWarningMessage } = vi.hoisted(() => ({
  showErrorMessage: vi.fn(),
  showWarningMessage: vi.fn(),
}));
vi.mock('vscode', () => ({ window: { showErrorMessage, showWarningMessage } }));

import { makeReporter } from '../reporter';

function fakeChannel() {
  return { warn: vi.fn(), error: vi.fn() };
}

describe('makeReporter', () => {
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
});
