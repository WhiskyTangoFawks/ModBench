import { describe, it, expect } from 'vitest';
import { programRunning } from '../processes';
import { runningProgram } from '../../test/runningProgram';

describe('programRunning, over the machine\'s own processes', () => {
  it('finds a process running the program by its file name, longer than Linux keeps a process\'s name, and none once it exits', async () => {
    const program = `ProbeProgram${process.pid}.exe`;
    const running = await runningProgram(program);
    const whileUp = await programRunning(program);
    await running.stop();

    expect([whileUp, await programRunning(program)]).toEqual([true, false]);
  });
});
