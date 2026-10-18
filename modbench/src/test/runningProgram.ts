import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** A process running a program file named `fileName`, up when this settles, until `stop`. */
export async function runningProgram(fileName: string): Promise<{ stop: () => Promise<void> }> {
  const bin = await mkdtemp(join(tmpdir(), 'running-program-'));
  await copyFile(process.execPath, join(bin, fileName));
  const child = spawn(join(bin, fileName), ['-e', 'process.stdout.write("up"); setInterval(() => {}, 1000)'], { stdio: ['ignore', 'pipe', 'ignore'] });
  await once(child.stdout, 'data');
  return {
    stop: async () => {
      child.kill();
      await once(child, 'exit');
      await rm(bin, { recursive: true, force: true });
    },
  };
}
