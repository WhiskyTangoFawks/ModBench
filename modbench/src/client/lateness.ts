import { EventEmitter } from './eventEmitter';
import type { RecordIndexProgress } from './MEditClient';

/** A state with its event, as VS Code pairs `window.state` with `onDidChangeWindowState`: `note` is called wherever
 *  `read` may have changed, and tells each listener the new value only when it differs from the last told. */
export function trackValue<T>(read: () => T, initial: T, same: (a: T, b: T) => boolean = (a, b) => a === b) {
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
  trackValue(read, undefined, (a, b) => a?.done === b?.done && a?.total === b?.total);
