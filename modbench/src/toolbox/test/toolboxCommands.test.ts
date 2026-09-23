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

const { switchProfile } = vi.hoisted(() => ({ switchProfile: vi.fn() }));

vi.mock('../../instanceCommands/profile', () => ({ switchProfile }));

import { registerRefreshCommand, registerToolboxCommands, type ToolboxCommandDeps } from '../toolboxCommands';
import { recordingReporter } from '../../test/surfacingDoubles';
import { instanceValueFixture } from '../../test/mo2/instanceValueFixture';
import { present } from '../../ports/present';
import type { RefreshResult } from '../../instanceCommands/loadOrder';

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

    expect([...handlers.keys()]).toEqual(['modbench.profile.switch']);
  });
});

describe('Switch profile', () => {
  it('reports a refused switch at error and leaves the readout alone', async () => {
    showQuickPick.mockResolvedValueOnce({ label: 'Modding' });
    switchProfile.mockResolvedValueOnce({ applied: false, refusal: 'ModOrganizer.ini is read-only' });

    const { reporter, updateProfileDescription, run } = register();
    await run('modbench.profile.switch');

    expect(reporter.reports).toEqual([
      { severity: 'error', message: 'Failed to switch profile.', detail: 'ModOrganizer.ini is read-only' },
    ]);
    expect(updateProfileDescription).not.toHaveBeenCalled();
  });

  it('refreshes the readout once the switch lands, and surfaces nothing', async () => {
    showQuickPick.mockResolvedValueOnce({ label: 'Modding' });
    switchProfile.mockResolvedValueOnce({ applied: true });

    const { reporter, updateProfileDescription, run } = register();
    await run('modbench.profile.switch');

    expect(updateProfileDescription).toHaveBeenCalled();
    expect(reporter.reports).toEqual([]);
    expect(reporter.landings).toEqual([]);
  });

  it('switches nothing when the picked profile is the active one', async () => {
    showQuickPick.mockResolvedValueOnce({ label: 'Default' });

    const { run } = register();
    await run('modbench.profile.switch');

    expect(switchProfile).not.toHaveBeenCalled();
  });
});

describe('Refresh', () => {
  function registerRefresh(outcome: RefreshResult) {
    const reporter = recordingReporter();
    const steps: string[] = [];
    registerRefreshCommand({
      refresh: () => { steps.push('instance commands: refresh'); return Promise.resolve(outcome); },
      instance: { refresh: () => { steps.push('Instance loader: read every file again'); return Promise.resolve(); } },
      reporter,
    });
    return { reporter, steps, run: () => present(handlers.get('modbench.instance.refresh'), 'the refresh handler')() };
  }

  it('asks instance commands to refresh, then the Instance loader to read every file again', async () => {
    const { reporter, steps, run } = registerRefresh({ applied: true, loadOrder: { sent: false } });

    await run();

    expect(steps).toEqual(['instance commands: refresh', 'Instance loader: read every file again']);
    expect(reporter.reports).toEqual([]);
  });

  it('reports a refused refresh at error and reads nothing again', async () => {
    const { reporter, steps, run } = registerRefresh({ applied: false, refusal: 'The index is held by another window.' });

    await run();

    expect(steps).toEqual(['instance commands: refresh']);
    expect(reporter.reports).toEqual([
      { severity: 'error', message: 'Could not rebuild the index.', detail: 'The index is held by another window.' },
    ]);
  });

  // The title icon shows with no instance open, so the command must exist and do nothing.
  it('is registered and does nothing when there is no instance', async () => {
    registerRefreshCommand(undefined);

    await expect(present(handlers.get('modbench.instance.refresh'), 'the refresh handler')()).resolves.toBeUndefined();
  });
});
