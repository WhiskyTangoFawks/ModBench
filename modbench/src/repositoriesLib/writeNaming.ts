import type { WriteSink } from '../ports/writeSink';

let sink: WriteSink | undefined;

/** Hands every write of the repositories the sink of the command running it; the composition root calls it once. */
export const writesNamedTo = (to: WriteSink): void => { sink = to; };

/** Names the files a write is about to write, before it writes, so a write that fails halfway is named too. */
export const nameWrites = (...paths: readonly string[]): void => sink?.name(paths);

export const leaveWritesUnnamed = (): void => sink?.leaveUnnamed();
