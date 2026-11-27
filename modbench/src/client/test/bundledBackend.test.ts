import { describe, it, expect, vi, beforeEach } from 'vitest';
import { join } from 'node:path';
import { answered } from './healthAnswer';
import { backendProcesses, clientOver } from './fakeMEdit';

const spawn = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', async (importOriginal) => ({ ...await importOriginal<typeof import('node:child_process')>(), spawn }));

const processes = backendProcesses();

async function startedAndStopped(): Promise<void> {
  const client = clientOver({ freePort: () => Promise.resolve(5172), checkHealth: () => Promise.resolve(answered(true)) });
  await client.start();
  await client.stop();
}

describe('the backend the client spawns', () => {
  beforeEach(() => {
    spawn.mockReset();
    spawn.mockImplementation((executable: string, args: string[]) => processes.spawn(executable, args));
  });

  it('is the one the extension ships beside its bundle, named for the platform it runs on', async () => {
    await startedAndStopped();

    expect(spawn.mock.calls.map(([executable]: unknown[]) => executable)).toEqual([
      join(__dirname, '..', '..', 'backend', process.platform === 'win32' ? 'MEditService.Http.exe' : 'MEditService.Http'),
    ]);
  });

  it('hands the backend a stdin it can watch, and asks it to exit when that stdin closes', async () => {
    await startedAndStopped();

    expect(spawn.mock.calls.map(([, args, options]: unknown[]) => [args, options])).toEqual([[
      ['--urls', 'http://localhost:5172', '--ExitWhenStdinCloses', 'true'],
      { detached: false, stdio: ['pipe', 'pipe', 'pipe'] },
    ]]);
    expect(processes.spawned.at(-1)?.stdin.writableFinished).toBe(true);
  });
});
