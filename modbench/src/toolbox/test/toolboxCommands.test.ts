import { describe, it, expect, vi, beforeEach } from 'vitest';

const { handlers, registerCommand, executeCommand, createQuickPick } = vi.hoisted(() => {
  const handlers = new Map<string, () => Promise<void> | void>();
  return {
    handlers,
    registerCommand: vi.fn((command: string, handler: () => Promise<void> | void) => {
      handlers.set(command, handler);
      return { dispose: vi.fn() };
    }),
    executeCommand: vi.fn(),
    createQuickPick: vi.fn(),
  };
});

vi.mock('vscode', async () => {
  const { recordedWithProgress } = await import('../../test/recordedProgress');
  return {
    commands: { registerCommand, executeCommand },
    window: { createQuickPick, withProgress: recordedWithProgress },
  };
});

import { progressSteps } from '../../test/recordedProgress';

const switchProfile = vi.fn<InstanceCommands['switchProfile']>();

import { registerRefreshCommand, registerToolboxCommands } from '../toolboxCommands';
import { recordingReporter } from '../../test/surfacingDoubles';
import { instanceValueFixture } from '../../test/mo2/instanceValueFixture';
import { present } from '../../ports/present';
import { fakeQuickPick } from '../../drivingLib/test/quickPickDouble';
import type { RefreshResult } from '../../instanceCommands/loadOrder';
import type { InstanceCommands } from '../../instanceCommands/instanceCommands';

const value = instanceValueFixture({ activeProfile: 'Default', profiles: ['Default', 'Modding', 'Survival'] });

type ToolboxCommandDeps = Parameters<typeof registerToolboxCommands>[0];

function register(over: Partial<ToolboxCommandDeps> = {}) {
  const reporter = recordingReporter();
  registerToolboxCommands({
    commands: { switchProfile },
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
  switchProfile.mockResolvedValue({ applied: true, wrote: true });
});

describe('Open settings', () => {
  it('opens VS Code\'s Settings on this extension\'s own', async () => {
    const { run } = register();

    await run('modbench.settings.open');

    expect(executeCommand).toHaveBeenCalledWith('workbench.action.openSettings', '@ext:publisher.modbench');
  });
});

interface ProfileItem { label: string; description?: string }

async function switchProfileChoosing(choice: string, over: Partial<ToolboxCommandDeps> = {}) {
  const { qp, accept, escape } = fakeQuickPick<ProfileItem>();
  createQuickPick.mockReturnValue(qp);
  const registered = register(over);
  const done = registered.run('modbench.profile.switch');
  await vi.waitFor(() => expect(qp.show).toHaveBeenCalled());
  if (choice === 'Esc') escape();
  else accept(present(qp.items.find((i) => i.label === choice), `the item "${choice}"`));
  await done;
  return { ...registered, qp };
}

describe('Switch profile', () => {
  it('picks among the instance\'s profiles, the active one marked', async () => {
    const { qp } = await switchProfileChoosing('Esc');

    expect(qp.items).toEqual([
      { label: 'Default', description: 'current' },
      { label: 'Modding', description: undefined },
      { label: 'Survival', description: undefined },
    ]);
    expect(qp.activeItems).toEqual([{ label: 'Default', description: 'current' }]);
  });

  it('switches to the picked profile', async () => {
    switchProfile.mockResolvedValueOnce({ applied: true, wrote: true });

    await switchProfileChoosing('Modding');

    expect(switchProfile).toHaveBeenCalledWith('Modding');
  });

  it('writes the switch under the Toolbox\'s progress, which closes once the Instance loader has read again', async () => {
    switchProfile.mockImplementationOnce(() => { progressSteps.push('write'); return Promise.resolve({ applied: true, wrote: true }); });

    const { reporter } = await switchProfileChoosing('Modding');

    expect(progressSteps).toEqual([
      'progress opens on modbench.toolbox', 'write', 'Instance loader: read every file again', 'progress closes',
    ]);
    expect(reporter.reports).toEqual([]);
    expect(reporter.landings).toEqual([]);
    expect(executeCommand).not.toHaveBeenCalled();
  });

  it('reads again after a refused switch, since the disk is what the view shows', async () => {
    switchProfile.mockResolvedValueOnce({ applied: false, refusal: 'read-only' });

    await switchProfileChoosing('Modding');

    expect(progressSteps).toEqual([
      'progress opens on modbench.toolbox', 'Instance loader: read every file again', 'progress closes',
    ]);
  });

  it('reports a refused switch at error', async () => {
    switchProfile.mockResolvedValueOnce({ applied: false, refusal: 'ModOrganizer.ini is read-only' });

    const { reporter } = await switchProfileChoosing('Modding');

    expect(reporter.reports).toEqual([
      { severity: 'error', message: 'Failed to switch profile.', detail: 'ModOrganizer.ini is read-only' },
    ]);
  });

  it.each([
    ['on Esc', 'Esc'],
    ['when the pick is the active profile', 'Default'],
  ])('switches nothing, says nothing and opens no progress %s', async (_case, choice) => {
    const { reporter } = await switchProfileChoosing(choice);

    expect(switchProfile).not.toHaveBeenCalled();
    expect(reporter.reports).toEqual([]);
    expect(progressSteps).toEqual([]);
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
      commands: { refresh: () => { progressSteps.push('instance commands: refresh'); return Promise.resolve(result); } },
      nextRefill: () => ({ ended: refill, release: () => { released.push(true); } }),
      instance: {
        value,
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

  it('keeps the Toolbox\'s progress open until mEdit\'s refill ends, not only until the rebuild answers with the record index still empty', async () => {
    let refillEnds!: () => void;
    const { run } = registerRefresh({ applied: true }, '/instance', new Promise<void>((resolve) => { refillEnds = resolve; }));

    const running = run();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(progressSteps).toEqual(['progress opens on modbench.toolbox', 'instance commands: refresh']);

    refillEnds();
    await running;
    expect(progressSteps.at(-1)).toBe('progress closes');
  });

  it.each<[string, RefreshResult, string, { severity: string; message: string; detail: string }]>([
    ['the second-window refusal in toolbox.md\'s words, naming this instance since Modbench cannot name the other window',
      { applied: false, heldElsewhere: true }, '/instance/FO4',
      { severity: 'error', message: 'This instance is open in another Modbench window', detail: '/instance/FO4' }],
    ['any other refused refresh with its own generic message at error, the backend\'s refusal as its reason',
      { applied: false, heldElsewhere: false, refusal: 'Failed to rebuild the store.' }, '/instance',
      { severity: 'error', message: 'Could not refresh.', detail: 'Failed to rebuild the store.' }],
  ])('reports %s, and still reads again', async (_case, result, instanceRoot, report) => {
    const { reporter, run } = registerRefresh(result, instanceRoot);

    await run();

    expect(progressSteps).toEqual([
      'progress opens on modbench.toolbox', 'instance commands: refresh', 'Instance loader: read every file again', 'progress closes',
    ]);
    expect(reporter.reports).toEqual([report]);
  });

  it('releases the wait it armed for a refill, since a refused rebuild starts none', async () => {
    const { released, run } = registerRefresh(
      { applied: false, heldElsewhere: false, refusal: 'Failed to rebuild the store.' }, '/instance', new Promise<void>(() => {}));

    await run();

    expect(released).toEqual([true]);
  });
});
