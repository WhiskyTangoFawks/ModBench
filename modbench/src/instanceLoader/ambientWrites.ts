import { AsyncLocalStorage } from 'node:async_hooks';
import type { WriteSink } from '../ports/writeSink';

const running = new AsyncLocalStorage<WriteSink>();

export function collectingWrites<T>(sink: WriteSink, work: () => Promise<T>): Promise<T> {
  const outer = running.getStore();
  return running.run({
    name: (paths) => { sink.name(paths); outer?.name(paths); },
    leaveUnnamed: () => { sink.leaveUnnamed(); outer?.leaveUnnamed(); },
    settling: (subscribed) => { sink.settling(subscribed); outer?.settling(subscribed); },
  }, work);
}

/** Collects the writes of `work` into `sink` alone: a command running around it does not hear them. */
export function isolatingWrites<T>(sink: WriteSink, work: () => Promise<T>): Promise<T> {
  return running.run(sink, work);
}

/** The sink of the command running, if any. */
export const ambientWrites: WriteSink = {
  name: (paths) => running.getStore()?.name(paths),
  leaveUnnamed: () => running.getStore()?.leaveUnnamed(),
  settling: (subscribed) => running.getStore()?.settling(subscribed),
};
