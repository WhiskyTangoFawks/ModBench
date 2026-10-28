import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from '../../test/vscodeMock';
import { Refusal } from '../refusal';
import { present } from '../../ports/present';

interface Terminal { onDidWrite: (listener: (text: string) => void) => void; onDidClose: (listener: (code: number) => void) => void; open: () => void }
interface TaskStandIn { execution: { start: () => Promise<Terminal> } }

const { registerTaskProvider, executeCommand, provider } = vi.hoisted(() => {
  const provided: { current?: { provideTasks(): unknown[]; resolveTask(task: unknown): TaskStandIn } } = {};
  return {
    provider: provided,
    executeCommand: vi.fn(),
    registerTaskProvider: vi.fn((_type: string, taskProvider: typeof provided.current) => { provided.current = taskProvider; return { dispose: vi.fn() }; }),
  };
});

vi.mock('vscode', () => {
  class CustomExecution { constructor(readonly start: () => Promise<unknown>) {} }
  class Task {
    constructor(readonly definition: unknown, readonly scope: unknown, readonly name: string, readonly source: string, readonly execution: CustomExecution) {}
  }
  return {
    EventEmitter, CustomExecution, Task, TaskScope: { Workspace: 2 },
    commands: { executeCommand }, tasks: { registerTaskProvider },
  };
});

import { AgentCall } from '../agentGesture';
import { registerTaskGesture, type TaskVerdict } from '../taskGesture';

async function runTask(settle: (outcome: string) => TaskVerdict): Promise<{ written: string; closedWith: number[] }> {
  registerTaskGesture<string>({ type: 'modbench.test', label: 'Test', command: 'modbench.test.run', argument: () => [], settle });
  const task = present(provider.current, 'the registered task provider').resolveTask({ definition: { type: 'modbench.test' } });
  const terminal = await task.execution.start();
  let written = '';
  const closedWith: number[] = [];
  terminal.onDidWrite((text) => { written += text; });
  terminal.onDidClose((code) => { closedWith.push(code); });
  terminal.open();
  await vi.waitFor(() => { expect(closedWith).toHaveLength(1); });
  return { written, closedWith };
}

describe('a task over a command', () => {
  it('calls the command as an agent call does, writes the verdict\'s lines, and closes 0 when it passed', async () => {
    executeCommand.mockResolvedValueOnce('outcome');

    const { written, closedWith } = await runTask((outcome) => ({ passed: true, lines: [`got ${outcome}`, 'fine'] }));

    expect(executeCommand).toHaveBeenCalledWith('modbench.test.run', new AgentCall([], {}));
    expect(written).toBe('got outcome\r\nfine\r\n');
    expect(closedWith).toEqual([0]);
  });

  it('closes non-zero when the verdict failed', async () => {
    executeCommand.mockResolvedValueOnce('outcome');

    const { closedWith } = await runTask(() => ({ passed: false, lines: ['refused'] }));

    expect(closedWith).toEqual([1]);
  });

  it('closes non-zero and writes the message of a command that throws', async () => {
    executeCommand.mockRejectedValueOnce(new Refusal('no such mod'));

    const { written, closedWith } = await runTask(() => ({ passed: true, lines: [] }));

    expect(written).toBe('no such mod\r\n');
    expect(closedWith).toEqual([1]);
  });

  it('is offered once, with a definition of its type alone', () => {
    registerTaskGesture<string>({ type: 'modbench.test', label: 'Test', command: 'c', argument: () => [], settle: () => ({ passed: true, lines: [] }) });

    expect(provider.current?.provideTasks()).toMatchObject([{ definition: { type: 'modbench.test' }, name: 'Test' }]);
  });
});
