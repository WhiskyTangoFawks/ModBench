import type { Reporter } from '../ports/reporter';

/** Every throw reaches the Output (ADR-0019). A toast follows a source's first throw of a reason,
 *  and again after the source has recovered, so a callback that throws on every call cannot flood. */
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
