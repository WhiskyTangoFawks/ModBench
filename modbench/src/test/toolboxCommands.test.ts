import { describe, it, expect, vi, beforeEach } from 'vitest';

// Captures every registerCommand(id, handler) so a Toolbox gesture can be invoked directly.
const { handlers, registerCommand, showQuickPick } = vi.hoisted(() => {
  const handlers = new Map<string, () => Promise<void> | void>();
  return {
    handlers,
    registerCommand: vi.fn((command: string, handler: () => Promise<void> | void) => {
      handlers.set(command, handler);
      return { dispose: vi.fn() };
    }),
    showQuickPick: vi.fn(),
  };
});

vi.mock('vscode', () => ({
  commands: { registerCommand },
  window: { showQuickPick },
}));

const { listProfiles, switchProfile } = vi.hoisted(() => ({
  listProfiles: vi.fn(),
  switchProfile: vi.fn(),
}));

vi.mock('../instanceCommands/profile', () => ({ listProfiles, switchProfile }));
vi.mock('../workspaceConfig', () => ({ meditConfig: () => ({ get: () => undefined }) }));

import { registerToolboxCommands, type ToolboxCommandDeps } from '../toolboxCommands';
import { recordingReporter } from './surfacingDoubles';
import { instanceValueFixture } from '../test/mo2/instanceValueFixture';
import { present } from '../ports/present';

const value = instanceValueFixture({ activeProfile: 'Default' });

function register(over: Partial<ToolboxCommandDeps> = {}) {
  const reporter = recordingReporter();
  const updateProfileDescription = vi.fn(() => Promise.resolve());
  registerToolboxCommands({
    instanceRoot: '/instance',
    instance: { value },
    updateProfileDescription,
    reporterFor: () => reporter,
    ...over,
  });
  return {
    reporter,
    updateProfileDescription,
    run: (id: string) => present(handlers.get(id), `the registered handler for "${id}"`)(),
  };
}

beforeEach(() => {
  handlers.clear();
  vi.clearAllMocks();
});

describe('the Toolbox gestures', () => {
  // The alpha leaves deploy, purge and run with the mod manager.
  it('registers switch profile and no deploy, purge or run', () => {
    register();

    expect([...handlers.keys()]).toEqual(['modbench.toolbox.switchProfile']);
  });
});

describe('Switch profile', () => {
  it('reports a refused switch at error and leaves the readout alone', async () => {
    listProfiles.mockResolvedValueOnce(['Default', 'Modding']);
    showQuickPick.mockResolvedValueOnce({ label: 'Modding' });
    switchProfile.mockResolvedValueOnce({ applied: false, refusal: 'ModOrganizer.ini is read-only' });

    const { reporter, updateProfileDescription, run } = register();
    await run('modbench.toolbox.switchProfile');

    expect(reporter.reports).toEqual([
      { severity: 'error', message: 'Failed to switch profile.', detail: 'ModOrganizer.ini is read-only' },
    ]);
    expect(updateProfileDescription).not.toHaveBeenCalled();
  });

  it('refreshes the readout once the switch lands, and surfaces nothing', async () => {
    listProfiles.mockResolvedValueOnce(['Default', 'Modding']);
    showQuickPick.mockResolvedValueOnce({ label: 'Modding' });
    switchProfile.mockResolvedValueOnce({ applied: true });

    const { reporter, updateProfileDescription, run } = register();
    await run('modbench.toolbox.switchProfile');

    expect(updateProfileDescription).toHaveBeenCalled();
    expect(reporter.reports).toEqual([]);
    expect(reporter.landings).toEqual([]);
  });

  it('switches nothing when the picked profile is the active one', async () => {
    listProfiles.mockResolvedValueOnce(['Default']);
    showQuickPick.mockResolvedValueOnce({ label: 'Default' });

    const { run } = register();
    await run('modbench.toolbox.switchProfile');

    expect(switchProfile).not.toHaveBeenCalled();
  });
});
