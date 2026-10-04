import { describe, it, expect, vi, beforeEach } from 'vitest';

const { handlers, registerCommand, executeCommand, showQuickPick, withProgress, progressSteps } = vi.hoisted(() => {
  const handlers = new Map<string, () => Promise<void> | void>();
  const progressSteps: string[] = [];
  return {
    handlers,
    progressSteps,
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
import { accessTo } from '../../test/mo2/adapterOver';
import type { RefreshResult } from '../../instanceCommands/loadOrder';

const value = instanceValueFixture({ activeProfile: 'Default', profiles: ['Default', 'Modding', 'Survival'] });

const access = accessTo('/instance');

function register(over: Partial<ToolboxCommandDeps> = {}) {
  const reporter = recordingReporter();
  registerToolboxCommands({
    access,
    instance: { value, refresh: () => { progressSteps.push('Instance loader: read every file again'); return Promise.resolve(undefined); } },
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
  it('registers switch profile and open settings, and no deploy, purge or run, which the alpha leaves with the mod manager', () => {
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

    expect(switchProfile).toHaveBeenCalledWith(access, 'Modding', ['Default', 'Modding', 'Survival']);
  });

  it('writes the switch under the Toolbox\'s progress, which closes once the Instance loader has read again', async () => {
    switchProfile.mockImplementationOnce(() => { progressSteps.push('write'); return Promise.resolve({ applied: true }); });
    showQuickPick.mockResolvedValueOnce({ label: 'Modding' });

    const { run } = register();
    await run('modbench.profile.switch');

    expect(progressSteps).toEqual([
      'progress opens on modbench.toolbox', 'write', 'Instance loader: read every file again', 'progress closes',
    ]);
  });

  it('opens no progress on Esc, or when the pick is the active profile', async () => {
    showQuickPick.mockResolvedValueOnce(undefined).mockResolvedValueOnce({ label: 'Default' });

    const { run } = register();
    await run('modbench.profile.switch');
    await run('modbench.profile.switch');

    expect(progressSteps).toEqual([]);
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

  it('switches nothing when the picked profile is the active one', async () => {
    showQuickPick.mockResolvedValueOnce({ label: 'Default' });

    const { run } = register();
    await run('modbench.profile.switch');

    expect(switchProfile).not.toHaveBeenCalled();
  });
});

describe('Refresh', () => {
  function registerRefresh(
    result: RefreshResult, instanceRoot = '/instance',
    refill: Promise<void> = Promise.resolve(),
  ) {
    const reporter = recordingReporter();
    const released: true[] = [];
    registerRefreshCommand({
      refresh: () => { progressSteps.push('instance commands: refresh'); return Promise.resolve(result); },
      nextRefill: () => ({ ended: refill, release: () => { released.push(true); } }),
      instance: {
        refresh: () => {
          progressSteps.push('Instance loader: read every file again');
          return Promise.resolve(undefined);
        },
      },
      reporter,
      instanceRoot,
    });
    return { reporter, released, run: () => present(handlers.get('modbench.instance.refresh'), 'the refresh handler')() };
  }

  it('asks instance commands to refresh, then the Instance loader to read every file again, under the Toolbox\'s progress', async () => {
    const { reporter, run } = registerRefresh({ applied: true });

    await run();

    expect(progressSteps).toEqual([
      'progress opens on modbench.toolbox',
      'instance commands: refresh',
      'Instance loader: read every file again',
      'progress closes',
    ]);
    expect(reporter.reports).toEqual([]);
  });

  it('keeps the Toolbox\'s progress open until mEdit\'s refill ends, not only until the rebuild answers with the index still empty', async () => {
    let refillEnds!: () => void;
    const { run } = registerRefresh({ applied: true }, '/instance', new Promise<void>((resolve) => { refillEnds = resolve; }));

    const running = run();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(progressSteps).toEqual(['progress opens on modbench.toolbox', 'instance commands: refresh']);

    refillEnds();
    await running;
    expect(progressSteps.at(-1)).toBe('progress closes');
  });

  it('reports the second-window refusal in toolbox.md\'s words, naming this instance since Modbench cannot name the other window, and still reads again', async () => {
    const { reporter, run } = registerRefresh({ applied: false, heldElsewhere: true }, '/instance/FO4');

    await run();

    expect(progressSteps).toEqual([
      'progress opens on modbench.toolbox', 'instance commands: refresh', 'Instance loader: read every file again', 'progress closes',
    ]);
    expect(reporter.reports).toEqual([
      { severity: 'error', message: "This instance's index is open in another Modbench window", detail: '/instance/FO4' },
    ]);
  });

  it('reports any other refused refresh with its own generic message at error, the backend\'s refusal as its reason, and still reads again', async () => {
    const refusal = 'Failed to rebuild the store.';
    const { reporter, run } = registerRefresh({ applied: false, heldElsewhere: false, refusal });

    await run();

    expect(progressSteps).toEqual([
      'progress opens on modbench.toolbox', 'instance commands: refresh', 'Instance loader: read every file again', 'progress closes',
    ]);
    expect(reporter.reports).toEqual([
      { severity: 'error', message: 'Could not rebuild the index.', detail: refusal },
    ]);
  });

  it('releases the wait it armed for a refill, since a refused rebuild starts none', async () => {
    const { released, run } = registerRefresh(
      { applied: false, heldElsewhere: false, refusal: 'Failed to rebuild the store.' }, '/instance', new Promise<void>(() => {}));

    await run();

    expect(released).toEqual([true]);
  });
});
