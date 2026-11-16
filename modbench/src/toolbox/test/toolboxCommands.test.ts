import { describe, it, expect, vi, beforeEach } from 'vitest';

const { handlers, registerCommand, executeCommand, createQuickPick } = vi.hoisted(() => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  return {
    handlers,
    registerCommand: vi.fn((command: string, handler: (...args: unknown[]) => unknown) => {
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

import { AgentCall } from '../../drivingLib/agentGesture';
import { progressSteps } from '../../test/recordedProgress';

const switchProfile = vi.fn<InstanceCommands['switchProfile']>();

import { registerRebuildRecordIndexCommand, registerRefreshCommand, registerToolboxCommands } from '../toolboxCommands';
import { recordingReporter, tagRecordingReporterFor } from '../../test/surfacingDoubles';
import { instanceValueFixture } from '../../test/mo2/instanceValueFixture';
import { present } from '../../ports/present';
import { fakeQuickPick } from '../../drivingLib/test/quickPickDouble';
import type { RebuildResult } from '../../instanceCommands/loadOrder';
import type { InstanceCommands } from '../../instanceCommands/instanceCommands';

const value = instanceValueFixture({ activeProfile: 'Default', profiles: ['Default', 'Modding', 'Survival'] });

type ToolboxCommandDeps = Parameters<typeof registerToolboxCommands>[0];
type RefreshDeps = Parameters<typeof registerRefreshCommand>[0];

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
    run: (id: string, ...args: unknown[]) => present(handlers.get(id), `the registered handler for "${id}"`)(...args),
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

describe('Open the deployment folder setting', () => {
  it('opens VS Code\'s Settings at the deployment folder\'s setting', async () => {
    const { run } = register();

    await run('modbench.settings.openDeploymentFolderHere');

    expect(executeCommand).toHaveBeenCalledWith('workbench.action.openSettings', 'modbench.deployment.folder');
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

  it('writes the switch under the Toolbox\'s progress, which closes when the write returns', async () => {
    switchProfile.mockImplementationOnce(() => { progressSteps.push('write'); return Promise.resolve({ applied: true, wrote: true }); });

    const { reporter } = await switchProfileChoosing('Modding');

    expect(progressSteps).toEqual([
      'progress opens on modbench.toolbox', 'write', 'progress closes',
    ]);
    expect(reporter.reports).toEqual([]);
    expect(reporter.landings).toEqual([]);
    expect(executeCommand).not.toHaveBeenCalled();
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

describe('Switch profile, called by an agent', () => {
  const call = (...names: string[]) => new AgentCall(names.map((name) => ({ kind: 'profile' as const, name })), {});

  it('switches to the profile it names, opens no picker, says nothing and answers it switched to that profile', async () => {
    const { reporter, run } = register();

    const answer = await run('modbench.profile.switch', call('Modding'));

    expect([switchProfile.mock.calls, createQuickPick.mock.calls, reporter.reports, answer]).toEqual([
      [['Modding']], [], [], { applied: true, done: 'Switched to Modding.' },
    ]);
  });

  it('answers a refusal as the reason, and reports it nowhere', async () => {
    switchProfile.mockResolvedValueOnce({ applied: false, refusal: 'No such profile: Nope' });
    const { reporter, run } = register();

    expect([await run('modbench.profile.switch', call('Nope')), reporter.reports]).toEqual([{ applied: false, refusal: 'No such profile: Nope' }, []]);
  });

  it('is refused when it names no profile or several', async () => {
    const { run } = register();

    await expect(run('modbench.profile.switch', call())).rejects.toThrow('one profile');
    await expect(run('modbench.profile.switch', call('A', 'B'))).rejects.toThrow('one profile');
  });
});

describe('Refresh', () => {
  const registerRefresh = (statusWhenChecked?: ReturnType<RefreshDeps['loadOrderStatus']>, mEditStatus: ReturnType<RefreshDeps['mEditStatus']> = 'running') => {
    const checks: unknown[] = [];
    let status: ReturnType<RefreshDeps['loadOrderStatus']>;
    const { reporter, reporterFor } = tagRecordingReporterFor();
    registerRefreshCommand({
      instance: {
        refresh: (wrote) => {
          checks.push(wrote);
          progressSteps.push('Instance loader: check the disk');
          status = statusWhenChecked;
          return Promise.resolve(undefined);
        },
      },
      loadOrderStatus: () => status,
      mEditStatus: () => mEditStatus,
      reporterFor,
      instanceRoot: '/instance/FO4',
    });
    return { checks, reporter, run: (...args: unknown[]) => present(handlers.get('modbench.instance.refresh'), 'the refresh handler')(...args) };
  };

  it('checks the disk once, under the Toolbox\'s progress', async () => {
    const { checks, reporter, run } = registerRefresh();

    await run();

    expect(checks).toEqual([undefined]);
    expect(progressSteps).toEqual(['progress opens on modbench.toolbox', 'Instance loader: check the disk', 'progress closes']);
    expect(reporter.reports).toEqual([]);
  });

  it('answers an agent call that it landed', async () => {
    expect(await registerRefresh().run(new AgentCall([], {}))).toEqual({ applied: true });
  });

  it('says, once the check has settled, that another window holds the index, naming the instance and what lets refresh run', async () => {
    const { reporter, run } = registerRefresh({ refusal: { kind: 'heldElsewhere' } });

    await run();

    expect(progressSteps.at(-1)).toBe('progress closes');
    expect(reporter.reports).toEqual([
      { severity: 'error', message: 'This instance is open in another Modbench window. Close it, then refresh.', detail: '/instance/FO4' },
    ]);
  });

  it.each(['starting', 'disconnected', 'stopped'] as const)('says it checked the instance but not the record index when mEdit is %s, and answers an agent call the same', async (mEditStatus) => {
    const said = 'Checked the instance, but not the index: mEdit is not running.';
    const viewCall = registerRefresh(undefined, mEditStatus);
    await viewCall.run();
    expect(viewCall.reporter.reports).toEqual([{ severity: 'error', message: said, detail: undefined }]);

    handlers.clear();
    const agentCall = registerRefresh(undefined, mEditStatus);
    expect(await agentCall.run(new AgentCall([], {}))).toEqual({ applied: false, refusal: said });
    expect(agentCall.reporter.reports).toEqual([]);
  });

  it('answers an agent call the same refusal as its reason, and reports nowhere', async () => {
    const { reporter, run } = registerRefresh({ refusal: { kind: 'heldElsewhere' } });

    expect(await run(new AgentCall([], {}))).toEqual({
      applied: false, refusal: 'This instance is open in another Modbench window. Close it, then refresh.', detail: '/instance/FO4',
    });
    expect(reporter.reports).toEqual([]);
  });
});

describe('Rebuild record index', () => {
  function registerRebuild(
    result: RebuildResult, instanceRoot = '/instance',
    refill: Promise<void> = Promise.resolve(),
  ) {
    const { reporter, reporterFor, tags } = tagRecordingReporterFor();
    const released: true[] = [];
    registerRebuildRecordIndexCommand({
      commands: { rebuildRecordIndex: () => { progressSteps.push('instance commands: rebuild'); return Promise.resolve(result); } },
      nextRefill: () => ({ ended: refill, release: () => { released.push(true); } }),
      instance: { refresh: () => Promise.resolve(undefined) },
      reporterFor,
      instanceRoot,
    });
    return { reporter, tags, released, run: (...args: unknown[]) => present(handlers.get('modbench.instance.rebuildRecordIndex'), 'the rebuild handler')(...args) };
  }

  it('reports under the rebuildRecordIndex tag', () => {
    expect(registerRebuild({ applied: true }).tags).toEqual(['rebuildRecordIndex']);
  });

  it('asks instance commands to rebuild, under the Toolbox\'s progress', async () => {
    const { reporter, run } = registerRebuild({ applied: true });

    await run();

    expect(progressSteps).toEqual([
      'progress opens on modbench.toolbox',
      'instance commands: rebuild',
      'progress closes',
    ]);
    expect(reporter.reports).toEqual([]);
  });

  it('keeps the Toolbox\'s progress open until mEdit\'s refill ends, not only until the rebuild answers with the record index still empty', async () => {
    let refillEnds!: () => void;
    const { run } = registerRebuild({ applied: true }, '/instance', new Promise<void>((resolve) => { refillEnds = resolve; }));

    const running = run();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(progressSteps).toEqual(['progress opens on modbench.toolbox', 'instance commands: rebuild']);

    refillEnds();
    await running;
    expect(progressSteps.at(-1)).toBe('progress closes');
  });

  it.each<[string, RebuildResult, string, { severity: string; message: string; detail: string }]>([
    ['the second-window refusal in toolbox.md\'s words, naming this instance since Modbench cannot name the other window',
      { applied: false, heldElsewhere: true }, '/instance/FO4',
      { severity: 'error', message: 'This instance is open in another Modbench window. Close it, then rebuild the index.', detail: '/instance/FO4' }],
    ['any other refused rebuild with its own generic message at error, the backend\'s refusal as its reason',
      { applied: false, heldElsewhere: false, refusal: 'Failed to rebuild the store.' }, '/instance',
      { severity: 'error', message: 'Could not rebuild the index.', detail: 'Failed to rebuild the store.' }],
  ])('reports %s, ', async (_case, result, instanceRoot, report) => {
    const { reporter, run } = registerRebuild(result, instanceRoot);

    await run();

    expect(progressSteps).toEqual([
      'progress opens on modbench.toolbox', 'instance commands: rebuild', 'progress closes',
    ]);
    expect(reporter.reports).toEqual([report]);
  });

  it('releases the wait it armed for a refill, since a refused rebuild starts none', async () => {
    const { released, run } = registerRebuild(
      { applied: false, heldElsewhere: false, refusal: 'Failed to rebuild the store.' }, '/instance', new Promise<void>(() => {}));

    await run();

    expect(released).toEqual([true]);
  });
});
