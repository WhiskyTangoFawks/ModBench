import { describe, it, expect, vi } from 'vitest';

vi.mock('vscode', async () => (await import('../../test/taskDouble')).taskModule());

import { callWithSignal, executeCommand, registered, runRegisteredTask, signalOf } from '../../test/taskDouble';
import { recordingReporter } from '../../test/surfacingDoubles';
import { Refusal } from '../refusal';
import { present } from '../../ports/present';
import { registerTaskGesture, type TaskVerdict } from '../taskGesture';

function register(settle: (outcome: string) => TaskVerdict = () => ({ passed: true, lines: [], problems: [] })) {
  const reporter = recordingReporter();
  registerTaskGesture<string>({ label: 'Test', command: 'modbench.test.run', reporter, argument: () => [], settle });
  return reporter;
}

describe('a task over a command', () => {
  it('is of its command\'s type, and offered once with a definition of that type alone', () => {
    register();

    expect(registered.type).toBe('modbench.test.run');
    expect(registered.provider?.provideTasks()).toMatchObject([{ definition: { type: 'modbench.test.run' }, name: 'Test' }]);
  });

  it('calls the command as an agent call does, writes the verdict, and closes 0 when it passed', async () => {
    register((outcome) => ({ passed: true, lines: [`got ${outcome}`, 'fine'], problems: [] }));

    const { written, closedWith } = await runRegisteredTask({ type: 'modbench.test.run' }, { resolves: 'outcome' });

    expect(executeCommand).toHaveBeenCalledWith('modbench.test.run', callWithSignal([]));
    expect([written, closedWith]).toEqual(['got outcome\r\nfine\r\n', [0]]);
  });

  it('closes non-zero when the verdict failed, writing each problem to the terminal and to the Output', async () => {
    const reporter = register(() => ({
      passed: false, lines: [], problems: [{ severity: 'error', message: 'Refused.', detail: 'why' }, { severity: 'warning', message: 'Warned.' }],
    }));

    const { written, closedWith } = await runRegisteredTask({ type: 'modbench.test.run' }, { resolves: 'outcome' });

    expect([written, closedWith]).toEqual(['Refused. why\r\nWarned.\r\n', [1]]);
    expect(reporter.shownFailures).toEqual([{ severity: 'error', message: 'Refused.', detail: 'why' }, { severity: 'warning', message: 'Warned.', detail: undefined }]);
  });

  it('closes non-zero and writes the message of a command that throws, to the terminal and to the Output', async () => {
    const reporter = register();

    const { written, closedWith } = await runRegisteredTask({ type: 'modbench.test.run' }, { rejects: new Refusal('no such mod') });

    expect([written, closedWith]).toEqual(['no such mod\r\n', [1]]);
    expect(reporter.shownFailures).toEqual([{ severity: 'error', message: 'no such mod', detail: undefined }]);
  });

  it('stops the command it runs when the terminal is closed', async () => {
    register();
    executeCommand.mockReset();
    executeCommand.mockReturnValueOnce(new Promise(() => undefined));
    const terminal = await present(registered.provider, 'the provider').resolveTask({ definition: { type: 'modbench.test.run' } }).execution.start();
    terminal.open();
    const signal = signalOf(executeCommand.mock.calls[0]?.[1]);
    expect(signal?.aborted).toBe(false);

    terminal.close();

    expect(signal?.aborted).toBe(true);
  });
});
