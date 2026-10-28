import { describe, it, expect, vi } from 'vitest';

vi.mock('vscode', async () => (await import('../../test/taskDouble')).taskModule());

import { executeCommand, registered, runRegisteredTask } from '../../test/taskDouble';
import { recordingReporter } from '../../test/surfacingDoubles';
import { AgentCall } from '../../drivingLib/agentGesture';
import type { DeployResult } from '../../instanceCommands/deploy';
import { registerDeployTask } from '../deployTask';

const DEFINITION = { type: 'modbench.instance.deploy' };
const UNCHANGED = { kind: 'unchanged', renamed: [] } as const;
const landed = (overrides: Partial<DeployResult & { applied: true }> = {}): DeployResult =>
  ({ applied: true, wrote: true, leftOut: [], unmanaged: [], lost: [], leftAside: [], pluginsTxt: UNCHANGED, canMoveToOverwrite: false, ...overrides });

async function deploy(answered: DeployResult | { applied: false; refusal: string }) {
  const reporter = recordingReporter();
  registerDeployTask(reporter);
  return { ...await runRegisteredTask(DEFINITION, { resolves: answered }), reporter };
}

describe('the deploy task', () => {
  it('is of deploy\'s Command ID, calls deploy with no argument, and passes when the game gets the load order', async () => {
    const { written, closedWith, reporter } = await deploy(landed());

    expect([registered.type, written, closedWith, reporter.shownFailures]).toEqual(['modbench.instance.deploy', 'Deployed the load order.\r\n', [0], []]);
    expect(executeCommand).toHaveBeenCalledWith('modbench.instance.deploy', new AgentCall([], {}));
  });

  it('passes, and says the deployment folder already held the load order, when deploy wrote nothing', async () => {
    const { written, closedWith } = await deploy(landed({ wrote: false }));

    expect([written, closedWith]).toEqual(['The deployment folder already held the load order.\r\n', [0]]);
  });

  it('fails with a refusal, writing it to the terminal and the Output', async () => {
    const { written, closedWith, reporter } = await deploy({ applied: false, refusal: 'No deployment folder: set modbench.deployment.folder.' });

    expect([written, closedWith, reporter.shownFailures]).toEqual([
      'Could not deploy. No deployment folder: set modbench.deployment.folder.\r\n', [1],
      [{ severity: 'error', message: 'Could not deploy.', detail: 'No deployment folder: set modbench.deployment.folder.' }],
    ]);
  });

  it.each([
    ['a file left out for a file deploy did not write', { leftOut: [{ path: 'Data/a.esp', winner: '/m/A/a.esp' }] }],
    ['a file lost to another that folds to its path', { lost: [{ path: 'Data/x.ini', winner: '/m/B/x.ini' }] }],
    ['no plugins.txt written', { pluginsTxt: { kind: 'notWritten', why: 'no prefix' } }],
  ] as const)('fails with %s', async (_name, overrides) => {
    const { closedWith, reporter } = await deploy(landed(overrides));

    expect([closedWith, reporter.shownFailures.map(({ severity }) => severity)]).toEqual([[1], ['error']]);
  });

  it.each([
    ['a file set aside and left', { leftAside: ['Data/b.esp.modbench_aside_7_0 (EBUSY)'] }],
    ['a record it could not trim', { staleRecord: 'EBUSY' }],
    ['a plugins.txt renamed', { pluginsTxt: { kind: 'written', renamed: ['plugins.txt.modbench_renamed'] } }],
    ['files it does not manage', { unmanaged: ['Data/MCM/settings.ini'] }],
  ] as const)('passes with %s, and writes it as a warning', async (_name, overrides) => {
    const { closedWith, reporter } = await deploy(landed(overrides));

    expect([closedWith, reporter.shownFailures.map(({ severity }) => severity)]).toEqual([[0], ['warning']]);
  });
});
