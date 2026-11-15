import type { WritesTold } from '../ports/writesTold';
import type { WriteSink } from '../ports/writeSink';

let loader: WritesTold | undefined;
let sink: WriteSink | undefined;

/** Hands every write of the repositories the loader it tells; the composition root calls it once. */
export const writesToldTo = (to: WritesTold): void => { loader = to; };

/** Hands every write that cannot name its files the sink of the command running it; the composition root calls it once. */
export const writesNamedTo = (to: WriteSink): void => { sink = to; };

/** Runs `write`, then tells the loader the files it wrote, which a write that fails halfway may have written too. */
export async function toldAfter<T>(paths: readonly string[], write: () => Promise<T>): Promise<T> {
  try {
    return await write();
  } finally {
    if (paths.length > 0) await loader?.told(paths);
  }
}

export const leaveWritesUnnamed = (): void => sink?.leaveUnnamed();
