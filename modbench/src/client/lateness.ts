import { EventEmitter } from './eventEmitter';
import type { RecordIndexProgress } from './MEditClient';

function trackValue<T>(read: () => T, initial: T, same: (a: T, b: T) => boolean = (a, b) => a === b) {
  const changes = new EventEmitter<T>();
  let last = initial;
  return {
    event: changes.event,
    note: (): void => {
      const now = read();
      if (same(now, last)) return;
      last = now;
      changes.fire(now);
    },
  };
}

export const trackLateness = (isLate: () => boolean) => trackValue(isLate, false);

export const trackProgress = (read: () => RecordIndexProgress | undefined) =>
  trackValue(read, undefined, (a, b) => JSON.stringify(a) === JSON.stringify(b));

export const indexing = (progress: RecordIndexProgress | undefined): progress is RecordIndexProgress =>
  progress?.settled === false && progress.refusal === undefined;

export const indexingMakesLate = (progress: RecordIndexProgress | undefined): boolean =>
  progress !== undefined && (!progress.settled || progress.refusal !== undefined);
