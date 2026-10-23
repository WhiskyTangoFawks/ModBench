import { describe, it, expect, vi, beforeEach } from 'vitest';

const { handlers, registerCommand } = vi.hoisted(() => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  return {
    handlers,
    registerCommand: vi.fn((command: string, handler: (...args: unknown[]) => unknown) => {
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
import { registerModlistCommands } from '../modlistGestures';
import { recordingReporter } from '../../test/surfacingDoubles';
import { instanceValueFixture } from '../../test/mo2/instanceValueFixture';
import { present } from '../../ports/present';
import { AgentCall } from '../../drivingLib/agentGesture';
import type { ModlistRepositoryCommands } from '../../sourceCommands/modlistRepositoryCommands';

const gitInit = vi.fn<ModlistRepositoryCommands['gitInit']>();
const GIT_INIT = 'modbench.modlist.gitInit';
const REFUSAL = '/instance already holds a repository.';

function register() {
  const reporter = recordingReporter();
  registerModlistCommands({
    commands: { gitInit },
    instance: { value: instanceValueFixture({}), refresh: () => { progressSteps.push('Instance loader: read every file again'); return Promise.resolve(undefined); } },
    reporter,
  });
  return { reporter, run: (...args: unknown[]) => present(handlers.get(GIT_INIT), `the handler for "${GIT_INIT}"`)(...args) };
}

beforeEach(() => {
  handlers.clear();
  progressSteps.length = 0;
  vi.clearAllMocks();
  gitInit.mockResolvedValue({ applied: true });
});

describe('Git init', () => {
  it('makes the repository under the Toolbox\'s progress, which closes once the Instance loader has read again, and says nothing', async () => {
    gitInit.mockImplementationOnce(() => { progressSteps.push('git init'); return Promise.resolve({ applied: true }); });
    const { reporter, run } = register();

    await run();

    expect(progressSteps).toEqual(['progress opens on modbench.toolbox', 'git init', 'Instance loader: read every file again', 'progress closes']);
    expect([reporter.reports, reporter.landings]).toEqual([[], []]);
  });

  it('warns, naming why, when a path token stays in the working tree', async () => {
    gitInit.mockResolvedValueOnce({ applied: true, pathTokensNotWritten: 'ModOrganizer.ini still holds a path token' });
    const { reporter, run } = register();

    await run();

    expect(reporter.reports).toEqual([{
      severity: 'warning', message: 'Git init:', detail: "this machine's paths are not in place of every path token: ModOrganizer.ini still holds a path token",
    }]);
  });

  it('answers an agent call with why a path token stays in the working tree', async () => {
    gitInit.mockResolvedValueOnce({ applied: true, pathTokensNotWritten: 'ModOrganizer.ini still holds a path token' });
    const { run } = register();

    expect(await run(new AgentCall([], {}))).toEqual({
      applied: true, outcome: { landed: [], refused: [] },
      partial: [{ message: 'Git init:', detail: "this machine's paths are not in place of every path token: ModOrganizer.ini still holds a path token", severity: 'warning' }],
    });
  });

  it('reports a refusal at error, naming why', async () => {
    gitInit.mockResolvedValueOnce({ applied: false, refusal: REFUSAL });
    const { reporter, run } = register();

    await run();

    expect(reporter.reports).toEqual([{ severity: 'error', message: 'Could not git init.', detail: REFUSAL }]);
  });

  it('answers an agent call with its outcome under the Toolbox\'s progress, reporting nothing', async () => {
    const { reporter, run } = register();

    expect(await run(new AgentCall([], {}))).toEqual({ applied: true, outcome: { landed: [], refused: [] } });
    expect([progressSteps[0], reporter.reports, reporter.landings]).toEqual(['progress opens on modbench.toolbox', [], []]);
  });

  it('answers an agent call\'s refusal as a refusal, reporting nothing', async () => {
    gitInit.mockResolvedValueOnce({ applied: false, refusal: REFUSAL });
    const { reporter, run } = register();

    expect(await run(new AgentCall([], {}))).toEqual({ applied: false, refusal: REFUSAL });
    expect(reporter.reports).toEqual([]);
  });
});
