import type { Reporter } from '../ports/reporter';

/** A callback that throws on every call would toast on every call. Every throw reaches the Output
 *  (ADR-0019); a toast follows only a source's first throw of a reason, and again once the source
 *  has recovered, as `tellOnce` tells a note again after it clears. */
export function toastOncePerFailure(reporter: Reporter) {
  const toasted = new Map<object, string>();
  return {
    threw(source: object, message: string, detail: string): void {
      if (toasted.get(source) === detail) {
        reporter.shownOnSurface('error', message, detail);
        return;
      }
      toasted.set(source, detail);
      reporter.report('error', message, detail);
    },
    recovered(source: object): void {
      toasted.delete(source);
    },
  };
}
