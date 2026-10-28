import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from '../../test/vscodeMock';
import { present } from '../../ports/present';

interface Terminal { onDidWrite: (listener: (text: string) => void) => void; onDidClose: (listener: (code: number) => void) => void; open: () => void }
interface TaskStandIn { execution: { start: () => Promise<Terminal> } }

interface Provided { type?: string; resolveTask?: (task: { definition: object }) => TaskStandIn }

const { executeCommand, provided } = vi.hoisted((): { executeCommand: ReturnType<typeof vi.fn>; provided: Provided } => ({
  executeCommand: vi.fn(),
  provided: {},
}));

vi.mock('vscode', () => {
  class CustomExecution { constructor(readonly start: () => Promise<unknown>) {} }
  class Task {
    constructor(readonly definition: unknown, readonly scope: unknown, readonly name: string, readonly source: string, readonly execution: CustomExecution) {}
  }
  return {
    EventEmitter, CustomExecution, Task, TaskScope: { Workspace: 2 },
    commands: { executeCommand },
    tasks: {
      registerTaskProvider: (type: string, taskProvider: { resolveTask: (task: { definition: object }) => TaskStandIn }) => {
        provided.type = type;
        provided.resolveTask = taskProvider.resolveTask;
        return { dispose: () => undefined };
      },
    },
  };
});

import type { BuildOutcome } from '../../client';
import type { PartialFailure } from '../../drivingLib/agentGesture';
import { AgentCall } from '../../drivingLib/agentGesture';
import { registerBuildTask } from '../buildTask';

type Landed = BuildOutcome['landed'][number];
const landed = (overrides: Partial<Landed> = {}): Landed =>
  ({ mod: 'ModA', compiled: [], refused: [], archivesRefused: [], overwritten: [], steps: [], made: [], ...overrides });

async function runBuildTask(definition: object, answered: unknown): Promise<{ written: string; closedWith: number[] }> {
  executeCommand.mockReset();
  executeCommand.mockResolvedValueOnce(answered);
  registerBuildTask();
  const task = present(provided.resolveTask, 'the build task provider')({ definition });
  const terminal = await task.execution.start();
  let written = '';
  const closedWith: number[] = [];
  terminal.onDidWrite((text) => { written += text; });
  terminal.onDidClose((code) => { closedWith.push(code); });
  terminal.open();
  await vi.waitFor(() => { expect(closedWith).toHaveLength(1); });
  return { written, closedWith };
}

const applied = (outcome: BuildOutcome, partial: PartialFailure[] = []) => ({ applied: true, outcome, partial });

describe('the build task', () => {
  it('is the modbench.build type', () => {
    registerBuildTask();

    expect(provided.type).toBe('modbench.build');
  });

  it('builds the mods its definition names, as an agent call does, and passes when every mod landed whole', async () => {
    const { written, closedWith } = await runBuildTask({ type: 'modbench.build', mods: ['ModA', 'ModB'] }, applied({ landed: [landed(), landed({ mod: 'ModB' })], refused: [] }));

    expect(executeCommand).toHaveBeenCalledWith('modbench.mod.build', new AgentCall([{ kind: 'mod', name: 'ModA' }, { kind: 'mod', name: 'ModB' }], {}));
    expect([written, closedWith]).toEqual(['Built "ModA".\r\nBuilt "ModB".\r\n', [0]]);
  });

  it('names no mod when its definition names none', async () => {
    await runBuildTask({ type: 'modbench.build' }, applied({ landed: [], refused: [] }));

    expect(executeCommand).toHaveBeenCalledWith('modbench.mod.build', new AgentCall([], {}));
  });

  it('passes when the build only warned, and writes the warning', async () => {
    const warning: PartialFailure = { message: 'Build overwrote 1 file that differed.', detail: '"a.txt (ModA)"', severity: 'warning' };

    const { written, closedWith } = await runBuildTask({ type: 'modbench.build' }, applied({ landed: [landed({ overwritten: ['a.txt'] })], refused: [] }, [warning]));

    expect([written, closedWith]).toEqual(['Built "ModA".\r\nBuild overwrote 1 file that differed. "a.txt (ModA)"\r\n', [0]]);
  });

  it.each([
    ['a mod refused', { landed: [], refused: [{ item: 'ModC', reason: 'no repository' }] }],
    ['a plugin refused in a built mod', { landed: [landed({ refused: [{ item: { name: 'A.esp', origin: 'ModA' }, reason: 'light range' }] })], refused: [] }],
    ['an archive refused in a built mod', { landed: [landed({ archivesRefused: [{ item: 'A.ba2', reason: 'too large' }] })], refused: [] }],
    ['a mod built in part', { landed: [landed({ failure: 'archive step' })], refused: [] }],
  ])('fails with %s', async (_name, outcome) => {
    const { closedWith } = await runBuildTask({ type: 'modbench.build' }, applied(outcome));

    expect(closedWith).toEqual([1]);
  });

  it('fails with the refusal of a whole build, and writes its words', async () => {
    const { written, closedWith } = await runBuildTask({ type: 'modbench.build' }, { applied: false, refusal: 'Save first.', detail: 'A.psc' });

    expect([written, closedWith]).toEqual(['Save first.\r\nA.psc\r\n', [1]]);
  });

  it('fails on a definition whose mods are not a list of names, without building', async () => {
    const { written, closedWith } = await runBuildTask({ type: 'modbench.build', mods: 'ModA' }, applied({ landed: [], refused: [] }));

    expect([written, closedWith]).toEqual(['A build task\'s "mods" is a list of mod names.\r\n', [1]]);
    expect(executeCommand).not.toHaveBeenCalled();
  });
});
