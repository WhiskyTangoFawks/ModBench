import { vi, expect } from 'vitest';
import { EventEmitter } from './vscodeMock';
import { present } from '../ports/present';

interface Terminal { onDidWrite: (listener: (text: string) => void) => void; onDidClose: (listener: (code: number) => void) => void; open: () => void }
interface TaskStandIn { execution: { start: () => Promise<Terminal> } }
interface Provider { provideTasks: () => { definition: object; name: string }[]; resolveTask: (task: { definition: object }) => TaskStandIn }

export const executeCommand = vi.fn();
export const registered: { type?: string; provider?: Provider } = {};

class CustomExecution { constructor(readonly start: () => Promise<Terminal>) {} }
class Task {
  constructor(readonly definition: object, readonly scope: unknown, readonly name: string, readonly source: string, readonly execution: CustomExecution) {}
}

/** The `vscode` module a task gesture runs against; mock it with `vi.mock('vscode', async () => (await import('…/taskDouble')).taskModule())`. */
export const taskModule = () => ({
  EventEmitter, CustomExecution, Task, TaskScope: { Workspace: 2 },
  commands: { executeCommand },
  tasks: {
    registerTaskProvider: (type: string, provider: Provider) => {
      registered.type = type;
      registered.provider = provider;
      return { dispose: () => undefined };
    },
  },
});

/** Runs the registered task for a definition as VS Code does, with the command answering `answered` or rejecting with it. */
export async function runRegisteredTask(
  definition: object, answer: { resolves: unknown } | { rejects: unknown },
): Promise<{ written: string; closedWith: number[] }> {
  executeCommand.mockReset();
  if ('resolves' in answer) executeCommand.mockResolvedValueOnce(answer.resolves); else executeCommand.mockRejectedValueOnce(answer.rejects);
  const task = present(registered.provider, 'the registered task provider').resolveTask({ definition });
  const terminal = await task.execution.start();
  let written = '';
  const closedWith: number[] = [];
  terminal.onDidWrite((text) => { written += text; });
  terminal.onDidClose((code) => { closedWith.push(code); });
  terminal.open();
  await vi.waitFor(() => { expect(closedWith).toHaveLength(1); });
  return { written, closedWith };
}
