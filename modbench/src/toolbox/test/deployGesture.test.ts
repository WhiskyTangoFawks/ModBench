import { beforeEach, describe, expect, it, vi } from 'vitest';

const { handlers, registerCommand } = vi.hoisted(() => {
  const handlers = new Map<string, () => Promise<void>>();
  return {
    handlers,
    registerCommand: vi.fn((command: string, handler: () => Promise<void>) => {
      handlers.set(command, handler);
      return { dispose: vi.fn() };
    }),
  };
});

vi.mock('vscode', async () => {
  const { recordedWithProgress } = await import('../../test/recordedProgress');
  return { commands: { registerCommand }, window: { withProgress: recordedWithProgress } };
});

import { progressSteps } from '../../test/recordedProgress';
import { registerDeployCommand } from '../deployGesture';
import { recordingReporter } from '../../test/surfacingDoubles';
import { instanceValueFixture } from '../../test/mo2/instanceValueFixture';
import { present } from '../../ports/present';
import type { DeployCommands, DeployResult } from '../../instanceCommands/deploy';

const value = instanceValueFixture();
const UNCHANGED = { kind: 'unchanged' } as const;

function deployAnswering(result: DeployResult, sequence = 1) {
  const reporter = recordingReporter();
  const deploy = vi.fn<DeployCommands['deploy']>(() => { progressSteps.push('deploy'); return Promise.resolve(result); });
  registerDeployCommand({
    commands: { deploy },
    instance: { landed: () => Promise.resolve(value), sequence, refresh: () => { progressSteps.push('read again'); return Promise.resolve(undefined); } },
    reporter,
  });
  return { reporter, deploy, run: present(handlers.get('modbench.instance.deploy'), 'the deploy handler') };
}

beforeEach(() => {
  handlers.clear();
  progressSteps.length = 0;
});

describe('Deploy', () => {
  it('deploys the files the instance value says the game gets, under the Toolbox\'s progress, and says nothing', async () => {
    const { reporter, deploy, run } = deployAnswering({ applied: true, wrote: true, leftOut: [], lost: [], leftAside: [], pluginsTxt: UNCHANGED });

    await run();

    expect([deploy.mock.calls, progressSteps, reporter.reports, reporter.landings]).toEqual([
      [[{ files: value.files, plugins: value.plugins, gameName: value.gameName }]], ['progress opens on modbench.toolbox', 'deploy', 'read again', 'progress closes'], [], [],
    ]);
  });

  it('deploys no load order while the instance has not been read', async () => {
    const { deploy, run } = deployAnswering({ applied: false, refusal: 'The instance has not been read.' }, 0);

    await run();

    expect(deploy.mock.calls).toEqual([[undefined]]);
  });

  it('reports a refused deploy at error, saying why', async () => {
    const { reporter, run } = deployAnswering({ applied: false, refusal: 'No deployment folder: set modbench.deployment.folder.' });

    await run();

    expect(reporter.reports).toEqual([{ severity: 'error', message: 'Could not deploy.', detail: 'No deployment folder: set modbench.deployment.folder.' }]);
  });

  it('warns of each file it left out, naming its path', async () => {
    const { reporter, run } = deployAnswering({ applied: true, wrote: true, leftOut: ['Data/MCM/settings.ini', 'Data/a.esp'], lost: [], leftAside: [], pluginsTxt: UNCHANGED });

    await run();

    expect(reporter.reports).toEqual([{
      severity: 'warning', message: 'Deploy left out each file whose path holds a file it did not write:', detail: 'Data/MCM/settings.ini, Data/a.esp',
    }]);
  });

  it('warns of each file it left out for another the game gets at its path, naming both', async () => {
    const { reporter, run } = deployAnswering({
      applied: true, wrote: true, leftOut: [], lost: [{ path: 'Data/x.ini', winner: '/instance/mods/Lower/Root/Data/x.ini' }], leftAside: [], pluginsTxt: UNCHANGED,
    });

    await run();

    expect(reporter.reports).toEqual([{
      severity: 'warning', message: 'Deploy left out each file whose path another file the game gets wins:', detail: '/instance/mods/Lower/Root/Data/x.ini at Data/x.ini',
    }]);
  });

  it('warns of each file it set aside and could not remove, which the next deploy removes', async () => {
    const { reporter, run } = deployAnswering({
      applied: true, wrote: true, leftOut: [], lost: [], leftAside: ['Data/b.esp.modbench_aside_7_0 (EBUSY: resource busy or locked)'], pluginsTxt: UNCHANGED,
    });

    await run();

    expect(reporter.reports).toEqual([{
      severity: 'warning', message: 'Deploy landed, and could not remove each file it set aside, which the next deploy removes:',
      detail: 'Data/b.esp.modbench_aside_7_0 (EBUSY: resource busy or locked)',
    }]);
  });

  it('warns that it wrote no plugins.txt, saying why', async () => {
    const { reporter, run } = deployAnswering({
      applied: true, wrote: true, leftOut: [], lost: [], leftAside: [], pluginsTxt: { kind: 'notWritten', why: 'no prefix' },
    });

    await run();

    expect(reporter.reports).toEqual([{ severity: 'warning', message: 'Deploy wrote no plugins.txt:', detail: 'no prefix' }]);
  });

  it('warns of the plugins.txt it renamed, naming its new name', async () => {
    const { reporter, run } = deployAnswering({
      applied: true, wrote: true, leftOut: [], lost: [], leftAside: [], pluginsTxt: { kind: 'written', renamedTo: 'C:\\Local\\Fallout4\\plugins.txt.modbench_renamed' },
    });

    await run();

    expect(reporter.reports).toEqual([{
      severity: 'warning', message: 'Deploy renamed the plugins.txt it did not write, so the game reads the plugin order of this load order:',
      detail: 'C:\\Local\\Fallout4\\plugins.txt.modbench_renamed',
    }]);
  });
});
