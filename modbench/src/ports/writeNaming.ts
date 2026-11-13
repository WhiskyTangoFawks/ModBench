import { AsyncLocalStorage } from 'node:async_hooks';

/** Where the writes of one command name the files they write: `name` for a file, `leaveUnnamed` for a write whose files the
 *  writer cannot tell. */
export interface WriteSink {
  name(paths: readonly string[]): void;
  leaveUnnamed(): void;
}

const writing = new AsyncLocalStorage<WriteSink>();

/** Runs `work`, whose every write names its files to `sink` and to the sink around it. */
export function collectingWrites<T>(sink: WriteSink, work: () => Promise<T>): Promise<T> {
  const outer = writing.getStore();
  return writing.run({
    name: (paths) => { sink.name(paths); outer?.name(paths); },
    leaveUnnamed: () => { sink.leaveUnnamed(); outer?.leaveUnnamed(); },
  }, work);
}

/** Names the files a write is about to write, before it writes, so a write that fails halfway is named too. */
export const nameWrites = (...paths: readonly string[]): void => writing.getStore()?.name(paths);

/** Says the write that follows writes files nobody can name, so the read after it checks the whole disk. */
export const leaveWritesUnnamed = (): void => writing.getStore()?.leaveUnnamed();
