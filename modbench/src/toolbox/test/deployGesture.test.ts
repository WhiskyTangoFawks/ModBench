import { beforeEach, describe, expect, it, vi } from 'vitest';

const { handlers, registerCommand, executeCommand } = vi.hoisted(() => {
  const handlers = new Map<string, (...args: unknown[]) => Promise<unknown>>();
  return {
    handlers,
    registerCommand: vi.fn((command: string, handler: (...args: unknown[]) => Promise<unknown>) => {
      handlers.set(command, handler);
      return { dispose: vi.fn() };
    }),
    executeCommand: vi.fn(),
  };
});

vi.mock('vscode', async () => {
  const { recordedWithProgress } = await import('../../test/recordedProgress');
  const { taskModule } = await import('../../test/taskDouble');
  return { ...taskModule(), commands: { registerCommand, executeCommand }, window: { withProgress: recordedWithProgress } };
});

import { progressSteps } from '../../test/recordedProgress';
import { AgentCall } from '../../drivingLib/agentGesture';
import { registerDeployCommands } from '../deployGesture';
import { recordingReporter } from '../../test/surfacingDoubles';
import { instanceValueFixture } from '../../test/mo2/instanceValueFixture';
import { present } from '../../ports/present';
import type { DeployCommands, DeployResult, MoveToOverwriteResult, PurgeResult } from '../../instanceCommands/deploy';

const value = instanceValueFixture();
const UNCHANGED = { kind: 'unchanged', renamed: [] } as const;
const NOTHING_DEPLOYED = { applied: true, wrote: false, leftOut: [], unmanaged: [], lost: [], leftAside: [], pluginsTxt: UNCHANGED } as const;

const NOT_MOVED: MoveToOverwriteResult = { applied: true, wrote: false, left: [] };

const NOT_PURGED: PurgeResult = { applied: true, wrote: false, restored: undefined, leftRenamed: [], unmanaged: [], unfinished: [] };

function deployAnswering(result: DeployResult, { sequence = 1, moved = NOT_MOVED, purged = NOT_PURGED }: { sequence?: number; moved?: MoveToOverwriteResult; purged?: PurgeResult } = {}) {
  const reporter = recordingReporter();
  const deploy = vi.fn<DeployCommands['deploy']>(() => { progressSteps.push('deploy'); return Promise.resolve(result); });
  const moveToOverwrite = vi.fn<DeployCommands['moveToOverwrite']>(() => { progressSteps.push('move'); return Promise.resolve(moved); });
  const purge = vi.fn<DeployCommands['purge']>(() => { progressSteps.push('purge'); return Promise.resolve(purged); });
  registerDeployCommands({
    commands: { deploy, purge, moveToOverwrite },
    instance: { landed: () => Promise.resolve(value), sequence, refresh: () => { progressSteps.push('read again'); return Promise.resolve(undefined); } },
    reporter,
  });
  return { reporter, deploy, purge, moveToOverwrite, runPurge: present(handlers.get('modbench.instance.purge'), 'the purge handler'), run: present(handlers.get('modbench.instance.deploy'), 'the deploy handler'), runMove: present(handlers.get('modbench.instance.moveToOverwrite'), 'the move handler') };
}

beforeEach(() => {
  handlers.clear();
  executeCommand.mockClear();
  progressSteps.length = 0;
});

describe('Deploy', () => {
  it('deploys the files the instance value says the game gets, under the Toolbox\'s progress, and says nothing', async () => {
    const { reporter, deploy, run } = deployAnswering({ applied: true, wrote: true, leftOut: [], unmanaged: [], lost: [], leftAside: [], pluginsTxt: UNCHANGED });

    await run();

    expect([deploy.mock.calls, progressSteps, reporter.reports, reporter.landings]).toEqual([
      [[{ files: value.files, plugins: value.plugins, gameName: value.gameName }]], ['progress opens on modbench.toolbox', 'deploy', 'read again', 'progress closes'], [], [],
    ]);
  });

  it('answers its result, and reports it as the view\'s own call', async () => {
    const result = { ...NOTHING_DEPLOYED, leftOut: [{ path: 'Data/a.esp', winner: '/m/A/a.esp' }] };
    const { reporter, run } = deployAnswering(result);

    expect([await run(), reporter.reports.length]).toEqual([result, 1]);
  });

  it('answers its result to an agent call and reports nothing, as the caller reports it', async () => {
    const result = { ...NOTHING_DEPLOYED, unmanaged: ['Data/a.ini'], lost: [{ path: 'Data/x.ini', winner: '/m/B/x.ini' }] };
    const { reporter, run } = deployAnswering(result);

    expect([await run(new AgentCall([], {})), reporter.reports, reporter.shownFailures]).toEqual([result, [], []]);
  });

  it('answers a refusal to an agent call, and reports nothing', async () => {
    const { reporter, run } = deployAnswering({ applied: false, refusal: 'No deployment folder: set modbench.deployment.folder.' });

    expect([await run(new AgentCall([], {})), reporter.reports]).toEqual([{ applied: false, refusal: 'No deployment folder: set modbench.deployment.folder.' }, []]);
  });

  it('deploys no load order while the instance has not been read', async () => {
    const { deploy, run } = deployAnswering({ applied: false, refusal: 'The instance has not been read.' }, { sequence: 0 });

    await run();

    expect(deploy.mock.calls).toEqual([[undefined]]);
  });

  it('reports a refused deploy at error, saying why', async () => {
    const { reporter, run } = deployAnswering({ applied: false, refusal: 'No deployment folder: set modbench.deployment.folder.' });

    await run();

    expect(reporter.reports).toEqual([{ severity: 'error', message: 'Could not deploy.', detail: 'No deployment folder: set modbench.deployment.folder.' }]);
  });

  it('warns of each file it left out, naming it and the path that holds a file deploy did not write', async () => {
    const { reporter, run } = deployAnswering({ applied: true, wrote: true, leftOut: [{ path: 'Data/MCM/settings.ini', winner: '/instance/mods/A/MCM/settings.ini' }, { path: 'Data/a.esp', winner: '/instance/mods/B/a.esp' }], unmanaged: [], lost: [], leftAside: [], pluginsTxt: UNCHANGED });

    await run();

    expect(reporter.reports).toEqual([{
      severity: 'warning', message: 'Deploy left out each file whose path holds a file it did not write:', detail: '/instance/mods/A/MCM/settings.ini at Data/MCM/settings.ini, /instance/mods/B/a.esp at Data/a.esp',
    }]);
  });

  it('warns of each file it left out for another the game gets at its path, naming both', async () => {
    const { reporter, run } = deployAnswering({
      applied: true, wrote: true, leftOut: [], unmanaged: [], lost: [{ path: 'Data/x.ini', winner: '/instance/mods/Lower/Root/Data/x.ini' }], leftAside: [], pluginsTxt: UNCHANGED,
    });

    await run();

    expect(reporter.reports).toEqual([{
      severity: 'warning', message: 'Deploy left out each file whose path another file the game gets wins:', detail: '/instance/mods/Lower/Root/Data/x.ini at Data/x.ini',
    }]);
  });

  it('warns of each file it set aside and could not remove, which the next deploy removes', async () => {
    const { reporter, run } = deployAnswering({
      applied: true, wrote: true, leftOut: [], unmanaged: [], lost: [], leftAside: ['Data/b.esp.modbench_aside_7_0 (EBUSY: resource busy or locked)'], pluginsTxt: UNCHANGED,
    });

    await run();

    expect(reporter.reports).toEqual([{
      severity: 'warning', message: 'Deploy landed, and could not remove each file it set aside, which the next deploy removes:',
      detail: 'Data/b.esp.modbench_aside_7_0 (EBUSY: resource busy or locked)',
    }]);
  });

  it('warns that it wrote no plugins.txt, saying why', async () => {
    const { reporter, run } = deployAnswering({
      applied: true, wrote: true, leftOut: [], unmanaged: [], lost: [], leftAside: [], pluginsTxt: { kind: 'notWritten', why: 'no prefix' },
    });

    await run();

    expect(reporter.reports).toEqual([{ severity: 'warning', message: 'Deploy wrote no plugins.txt:', detail: 'no prefix' }]);
  });

  it('warns of the plugins.txt it renamed, naming its new name', async () => {
    const { reporter, run } = deployAnswering({
      applied: true, wrote: true, leftOut: [], unmanaged: [], lost: [], leftAside: [], pluginsTxt: { kind: 'written', renamed: ['C:\\Local\\Fallout4\\plugins.txt.modbench_renamed', 'C:\\Local\\Fallout4\\plugins.txt.modbench_renamed_2'] },
    });

    await run();

    expect(reporter.reports).toEqual([{
      severity: 'warning', message: 'Deploy renamed each plugins.txt it did not write, so the game reads the plugin order of this load order:',
      detail: 'C:\\Local\\Fallout4\\plugins.txt.modbench_renamed, C:\\Local\\Fallout4\\plugins.txt.modbench_renamed_2',
    }]);
  });

  it('warns of each file in the deployment folder it does not manage, and offers to move them to Overwrite', async () => {
    const { reporter, run } = deployAnswering({ applied: true, wrote: true, leftOut: [], unmanaged: ['Data/MCM/settings.ini', 'game.exe'], lost: [], leftAside: [], pluginsTxt: UNCHANGED });

    await run();
    const [report] = reporter.reports;
    report?.action?.run();

    expect([reporter.shownFailures, reporter.reports.length, report?.severity, report?.message, report?.detail, report?.action?.title, executeCommand.mock.calls]).toEqual([
      [{ severity: 'warning', message: 'The deployment folder holds files deploy does not manage:', detail: 'Data/MCM/settings.ini, game.exe' }],
      1, 'warning', 'The deployment folder holds 2 files deploy does not manage, each named in the Output.', undefined, 'Move to Overwrite',
      [['modbench.instance.moveToOverwrite', ['Data/MCM/settings.ini', 'game.exe']]],
    ]);
  });

});

describe('Move to Overwrite', () => {

  it('moves the files it is given under the Toolbox\'s progress, and says nothing', async () => {
    const { reporter, moveToOverwrite, runMove } = deployAnswering(NOTHING_DEPLOYED, { moved: { applied: true, wrote: true, left: [] } });

    await runMove(['Data/a.esp']);

    expect([moveToOverwrite.mock.calls, progressSteps, reporter.reports]).toEqual([
      [[['Data/a.esp']]], ['progress opens on modbench.toolbox', 'move', 'read again', 'progress closes'], [],
    ]);
  });

  it('reports a refusal at error, saying why', async () => {
    const { reporter, runMove } = deployAnswering(NOTHING_DEPLOYED, { moved: { applied: false, refusal: '"a.esp" is already in Overwrite.' } });

    await runMove(['Data/a.esp']);

    expect(reporter.reports).toEqual([{ severity: 'error', message: 'Could not move to Overwrite.', detail: '"a.esp" is already in Overwrite.' }]);
  });

  it('warns of each file it left in the deployment folder', async () => {
    const { reporter, runMove } = deployAnswering(NOTHING_DEPLOYED, { moved: { applied: true, wrote: true, left: ['Data/.hidden'] } });

    await runMove(['Data/.hidden', 'Data/a.esp']);

    expect(reporter.reports).toEqual([{ severity: 'warning', message: 'Left in the deployment folder, because no mod file lands at their path:', detail: 'Data/.hidden' }]);
  });

  it('asks for the files deploy does not manage now when none are named, as from the command palette', async () => {
    const { moveToOverwrite, runMove } = deployAnswering(NOTHING_DEPLOYED);

    await runMove();

    expect(moveToOverwrite.mock.calls).toEqual([[undefined]]);
  });
});

describe('Purge', () => {
  it('purges under the Toolbox\'s progress, reads again, and says nothing', async () => {
    const { reporter, purge, runPurge } = deployAnswering(NOTHING_DEPLOYED, { purged: { applied: true, wrote: true, restored: '/local/plugins.txt', leftRenamed: [], unmanaged: [], unfinished: [] } });

    await runPurge();

    expect([purge.mock.calls, progressSteps, reporter.reports]).toEqual([[[]], ['progress opens on modbench.toolbox', 'purge', 'read again', 'progress closes'], []]);
  });

  it('reports a refused purge at error, saying why', async () => {
    const { reporter, runPurge } = deployAnswering(NOTHING_DEPLOYED, { purged: { applied: false, refusal: 'No deployment folder: set modbench.deployment.folder.' } });

    await runPurge();

    expect(reporter.reports).toEqual([{ severity: 'error', message: 'Could not purge.', detail: 'No deployment folder: set modbench.deployment.folder.' }]);
  });

  it('warns of each plugins.txt deploy renamed that it left, naming it', async () => {
    const { reporter, runPurge } = deployAnswering(NOTHING_DEPLOYED, { purged: { applied: true, wrote: true, restored: undefined, leftRenamed: ['/local/plugins.txt.modbench_renamed'], unmanaged: [], unfinished: [] } });

    await runPurge();

    expect(reporter.reports).toEqual([{ severity: 'warning', message: 'Purge left each plugins.txt deploy renamed, which is yours to put back:', detail: '/local/plugins.txt.modbench_renamed' }]);
  });

  it('warns of each thing it landed without finishing', async () => {
    const { reporter, runPurge } = deployAnswering(NOTHING_DEPLOYED, { purged: { applied: true, wrote: true, restored: undefined, leftRenamed: [], unmanaged: [], unfinished: ['Data/a.esp (EBUSY)'] } });

    await runPurge();

    expect(reporter.reports).toEqual([{ severity: 'warning', message: 'Purge landed, and could not finish:', detail: 'Data/a.esp (EBUSY)' }]);
  });
});

describe('Purge, when files remain', () => {
  it('names each file it left in the Output, and warns of how many', async () => {
    const { reporter, runPurge } = deployAnswering(NOTHING_DEPLOYED, { purged: { applied: true, wrote: true, restored: undefined, leftRenamed: [], unmanaged: ['Data/a.ini', 'game.exe'], unfinished: [] } });

    await runPurge();

    expect([reporter.shownFailures, reporter.reports]).toEqual([
      [{ severity: 'warning', message: 'The deployment folder holds files purge did not remove:', detail: 'Data/a.ini, game.exe' }],
      [{ severity: 'warning', message: 'The deployment folder holds 2 files purge did not remove, each named in the Output.', detail: undefined }],
    ]);
  });
});
