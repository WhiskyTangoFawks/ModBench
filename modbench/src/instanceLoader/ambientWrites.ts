import { AsyncLocalStorage } from 'node:async_hooks';
import type { WriteSink } from '../ports/writeSink';

const running = new AsyncLocalStorage<WriteSink>();

export function collectingWrites<T>(sink: WriteSink, work: () => Promise<T>): Promise<T> {
  const outer = running.getStore();
  return running.run({
    name: (paths) => { sink.name(paths); outer?.name(paths); },
    leaveUnnamed: () => { sink.leaveUnnamed(); outer?.leaveUnnamed(); },
  }, work);
}

/** The sink of the command running, if any. */
export const ambientWrites: WriteSink = {
  name: (paths) => running.getStore()?.name(paths),
  leaveUnnamed: () => running.getStore()?.leaveUnnamed(),
};
