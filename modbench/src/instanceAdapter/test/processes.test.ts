import { describe, it, expect, vi } from 'vitest';
import { rm } from 'node:fs/promises';
import { runningProgram } from '../../test/runningProgram';
import { fakeVscodeModule } from '../../test/mo2/fakeVscodeWatcher';
import { adapterAsBuilt, instanceOnDisk } from './instanceOnDisk';

vi.mock('vscode', () => fakeVscodeModule());

describe('whether MO2 is running, over the machine\'s own processes', () => {
  it('finds a process running the program by its file name, longer than Linux keeps a process\'s name', async () => {
    const instance = await instanceOnDisk();
    const running = await runningProgram('ModOrganizer.exe');
    const whileUp = await adapterAsBuilt(instance).managerRunning();
    await running.stop();
    await rm(instance, { recursive: true, force: true });

    expect(whileUp).toEqual({ kind: 'running' });
  });
});
