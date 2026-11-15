import { AsyncLocalStorage } from 'node:async_hooks';
import type { WritesTold } from '../ports/writesTold';
import type { WriteSink } from '../ports/writeSink';

let loader: WritesTold | undefined;
let diskCheckSink: WriteSink | undefined;
const untold = new AsyncLocalStorage<true>();

/** Hands every write of the repositories the loader it tells; the composition root calls it once. */
export const writesToldTo = (to: WritesTold): void => { loader = to; };

/** Hands every write that cannot name its files the sink of the command running it, so that command checks the disk; the
 *  composition root calls it once. */
export const diskCheckedBy = (to: WriteSink): void => { diskCheckSink = to; };

export const leaveWritesUnnamed = (): void => diskCheckSink?.leaveUnnamed();

/** Runs `work` with the writes it makes told to no one: a write the loader's own reading makes cannot wait on a later reading, and a
 *  file the loader never reads has nothing to tell it. */
export const withoutTelling = <T>(work: () => Promise<T>): Promise<T> => untold.run(true, work);

const tell = (paths: readonly string[]): Promise<void> =>
  paths.length === 0 || untold.getStore() === true || loader === undefined ? Promise.resolve() : loader.told(paths);

/** Runs `write`, then tells the loader the files it wrote and answers once it holds them. A write that fails halfway may have
 *  written them too, so it tells them and rejects with its own failure. */
export async function toldAfter<T>(paths: readonly string[], write: () => Promise<T>): Promise<T> {
  let written: T;
  try {
    written = await write();
  } catch (err) {
    await tell(paths).catch(() => undefined);
    throw err;
  }
  await tell(paths);
  return written;
}
