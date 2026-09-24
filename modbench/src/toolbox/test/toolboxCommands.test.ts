import { describe, it, expect, vi, beforeEach } from 'vitest';

// Captures every registerCommand(id, handler) so a Toolbox gesture can be invoked directly.
const { handlers, registerCommand, executeCommand, showQuickPick, withProgress, progressSteps } = vi.hoisted(() => {
  const handlers = new Map<string, () => Promise<void> | void>();
  const progressSteps: string[] = [];
  return {
    handlers,
    progressSteps,
    // Records where the progress shows, and when it opens and closes around the task.
    withProgress: vi.fn(async (options: { location: { viewId: string } }, task: () => Promise<unknown>) => {
      progressSteps.push(`progress opens on ${options.location.viewId}`);
      try { return await task(); } finally { progressSteps.push('progress closes'); }
    }),
    registerCommand: vi.fn((command: string, handler: () => Promise<void> | void) => {
      handlers.set(command, handler);
      return { dispose: vi.fn() };
    }),
    executeCommand: vi.fn(),
    showQuickPick: vi.fn(),
  };
});

vi.mock('vscode', () => ({
  commands: { registerCommand, executeCommand },
  window: { showQuickPick, withProgress },
}));

const { switchProfile } = vi.hoisted(() => ({ switchProfile: vi.fn() }));

vi.mock('../../instanceCommands/profile', () => ({ switchProfile }));

import { registerRefreshCommand, registerToolboxCommands, type ToolboxCommandDeps } from '../toolboxCommands';
import { recordingReporter } from '../../test/surfacingDoubles';
import { instanceValueFixture } from '../../test/mo2/instanceValueFixture';
import { present } from '../../ports/present';
import type { RefreshResult } from '../../instanceCommands/loadOrder';

const value = instanceValueFixture({ activeProfile: 'Default', profiles: ['Default', 'Modding', 'Survival'] });

function register(over: Partial<ToolboxCommandDeps> = {}) {
  const reporter = recordingReporter();
  registerToolboxCommands({
    instanceRoot: '/instance',
    instance: { value },
    extensionId: 'publisher.modbench',
    reporterFor: () => reporter,
    ...over,
  });
  return {
    reporter,
    run: (id: string) => present(handlers.get(id), `the registered handler for "${id}"`)(),
  };
}

beforeEach(() => {
  handlers.clear();
  progressSteps.length = 0;
  vi.clearAllMocks();
  switchProfile.mockResolvedValue({ applied: true });
});

describe('the Toolbox gestures', () => {
  // The alpha leaves deploy, purge and run with the mod manager.
  it('registers switch profile and open settings, and no deploy, purge or run', () => {
    register();

    expect([...handlers.keys()]).toEqual(['modbench.profile.switch', 'modbench.settings.open']);
  });
});

describe('Open settings', () => {
  it('opens VS Code\'s Settings on this extension\'s own', async () => {
    const { run } = register();

    await run('modbench.settings.open');

    expect(executeCommand).toHaveBeenCalledWith('workbench.action.openSettings', '@ext:publisher.modbench');
  });
});

describe('Switch profile', () => {
  it('picks among the instance\'s profiles, the active one marked', async () => {
    showQuickPick.mockResolvedValueOnce(undefined);

    const { run } = register();
    await run('modbench.profile.switch');

    expect(showQuickPick).toHaveBeenCalledWith(
      [
        { label: 'Default', description: 'current' },
        { label: 'Modding', description: undefined },
        { label: 'Survival', description: undefined },
      ],
      expect.anything(),
    );
  });

  it('switches nothing and says nothing on Esc', async () => {
    showQuickPick.mockResolvedValueOnce(undefined);

    const { reporter, run } = register();
    await run('modbench.profile.switch');

    expect(switchProfile).not.toHaveBeenCalled();
    expect(reporter.reports).toEqual([]);
  });

  it('switches to the picked profile', async () => {
    showQuickPick.mockResolvedValueOnce({ label: 'Modding' });
    switchProfile.mockResolvedValueOnce({ applied: true });

    const { run } = register();
    await run('modbench.profile.switch');

    expect(switchProfile).toHaveBeenCalledWith('/instance', 'Modding', ['Default', 'Modding', 'Survival']);
  });

  it('reports a refused switch at error', async () => {
    showQuickPick.mockResolvedValueOnce({ label: 'Modding' });
    switchProfile.mockResolvedValueOnce({ applied: false, refusal: 'ModOrganizer.ini is read-only' });

    const { reporter, run } = register();
    await run('modbench.profile.switch');

    expect(reporter.reports).toEqual([
      { severity: 'error', message: 'Failed to switch profile.', detail: 'ModOrganizer.ini is read-only' },
    ]);
  });

  // Every other way out of the gesture throws here: the `vscode` mock holds only the members it
  // lists, and the instance it is handed is a bare `{ value }`.
  it('writes and forgets: the profile write is its only effect', async () => {
    showQuickPick.mockResolvedValueOnce({ label: 'Modding' });

    const { reporter, run } = register();
    await run('modbench.profile.switch');

    expect({
      writes: switchProfile.mock.calls,
      commands: executeCommand.mock.calls,
      progress: withProgress.mock.calls,
      reports: reporter.reports,
      landings: reporter.landings,
    }).toEqual({
      writes: [['/instance', 'Modding', ['Default', 'Modding', 'Survival']]],
      commands: [],
      progress: [],
      reports: [],
      landings: [],
    });
  });

  it('switches nothing when the picked profile is the active one', async () => {
    showQuickPick.mockResolvedValueOnce({ label: 'Default' });

    const { run } = register();
    await run('modbench.profile.switch');

    expect(switchProfile).not.toHaveBeenCalled();
  });
});

describe('Refresh', () => {
  // `rereadFailure` is what the Instance loader's re-read answers: its own failure, or none.
  function registerRefresh(result: RefreshResult, rereadFailure?: string) {
    const reporter = recordingReporter();
    registerRefreshCommand({
      refresh: () => { progressSteps.push('instance commands: refresh'); return Promise.resolve(result); },
      instance: {
        refresh: () => {
          progressSteps.push('Instance loader: read every file again');
          return Promise.resolve(rereadFailure);
        },
      },
      reporter,
    });
    return { reporter, run: () => present(handlers.get('modbench.instance.refresh'), 'the refresh handler')() };
  }

  it('asks instance commands to refresh, then the Instance loader to read every file again, under the Toolbox\'s progress', async () => {
    const { reporter, run } = registerRefresh({ applied: true, loadOrder: { sent: false } });

    await run();

    expect(progressSteps).toEqual([
      'progress opens on modbench.toolbox',
      'instance commands: refresh',
      'Instance loader: read every file again',
      'progress closes',
    ]);
    expect(reporter.reports).toEqual([]);
  });

  // The backend's own refusal is the detail, so the notification names what holds the index.
  it('reports a refused refresh at error with the refusal as its reason, and reads nothing again', async () => {
    const refusal = 'This instance\'s index is open in another Modbench window (/instance/index.duckdb). '
      + 'Close mEdit there first, or open a different instance here.';
    const { reporter, run } = registerRefresh({ applied: false, refusal });

    await run();

    expect(progressSteps).toEqual([
      'progress opens on modbench.toolbox', 'instance commands: refresh', 'progress closes',
    ]);
    expect(reporter.reports).toEqual([
      { severity: 'error', message: 'Could not rebuild the index.', detail: refusal },
    ]);
  });

  // The views keep the last value through a failed read, so this is the only word the user gets
  // that the refresh did not read the disk.
  it('reports a re-read that failed at error, with its reason', async () => {
    const { reporter, run } = registerRefresh(
      { applied: true, loadOrder: { sent: false } }, 'ModOrganizer.ini: no selected_profile');

    await run();

    expect(reporter.reports).toEqual([{
      severity: 'error', message: 'Could not read the instance again.', detail: 'ModOrganizer.ini: no selected_profile',
    }]);
  });
});
