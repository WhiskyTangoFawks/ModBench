import { watch } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { vi } from 'vitest';

/** Runs `step` until `done` holds, or two seconds pass; whether it held. */
export async function eventually(done: () => boolean, step: () => Promise<unknown> | undefined = () => undefined): Promise<boolean> {
  const deadline = Date.now() + 2_000;
  while (!done()) {
    if (Date.now() > deadline) return false;
    await step();
    await new Promise((r) => setTimeout(r, 20));
  }
  return true;
}

/** Writes a file in `folder` and settles once a watch of its own has heard it, and every other watch of the
 *  process with it: the later event a check that a write went unheard waits for. */
export async function writtenAndHeard(folder: string): Promise<void> {
  const own = watch(folder);
  const heard = new Promise((r) => { own.once('change', r); });
  await writeFile(join(folder, 'written.txt'), `${Date.now()}`);
  await heard;
  await new Promise((r) => setImmediate(r));
  own.close();
}

/** Settles once code under fake timers has armed a wait. */
export async function settleWaitArmed(): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (vi.getTimerCount() === 0) {
    if (Date.now() >= deadline) throw new Error('no settle wait was armed on the fake clock');
    await new Promise((resolve) => setImmediate(resolve));
  }
}
