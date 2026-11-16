import { EventEmitter } from './eventEmitter';

/** A state with its event, as VS Code pairs `window.state` with `onDidChangeWindowState`: `note` is called wherever
 *  `isLate` may have changed, and tells each listener the new value only when it differs from the last told. */
export function trackLateness(isLate: () => boolean) {
  const changes = new EventEmitter<boolean>();
  let last = false;
  return {
    event: changes.event,
    note: (): void => {
      const now = isLate();
      if (now === last) return;
      last = now;
      changes.fire(now);
    },
  };
}
