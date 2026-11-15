import type { WritesTold } from '../ports/writesTold';
import type { WriteSink } from '../ports/writeSink';

let loader: WritesTold | undefined;
let diskCheckSink: WriteSink | undefined;

/** Hands every write of the repositories the loader it tells; the composition root calls it once. */
export const writesToldTo = (to: WritesTold): void => { loader = to; };

/** Hands every write that cannot name its files the sink of the command running it, so that command checks the disk; the
 *  composition root calls it once. */
export const diskCheckedBy = (to: WriteSink): void => { diskCheckSink = to; };

export const leaveWritesUnnamed = (): void => diskCheckSink?.leaveUnnamed();

const tell = (paths: readonly string[]): Promise<void> =>
  paths.length === 0 || loader === undefined ? Promise.resolve() : loader.told(paths);

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
