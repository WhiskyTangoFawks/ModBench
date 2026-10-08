import type { SelectionOutcome } from './selectionOutcome';

/** A failure's severity (target-architecture.d2, Ports), the one type every caller names. */
export type Severity = 'error' | 'warning';

/** ADR-0019. */
export interface Reporter {
  // Arrow-typed properties, not methods, so a test holds a bare reference to one
  // (`vi.mocked(reporter.report)`) without an unbound-method warning.
  /** What failed, and `detail` for why: the notification and the Output line both carry it. */
  report: (severity: Severity, message: string, detail?: string) => void;
  /** A gesture the user invoked landed: an information toast and no log line. Nothing went wrong,
   *  so there is no detail to go back and read. */
  landed: (message: string) => void;
  /** A failure the surface already says, in a dialog, a view or a VS Code feature's partial
   *  answer: an Output line, what and why, and no notification on top of it. */
  shownOnSurface: (severity: Severity, message: string, detail?: string) => void;
  /** A gesture over a selection: one error naming each refused item and why, and nothing for the
   *  items that landed, so a fully landed outcome says nothing. */
  selectionOutcome: <T>(message: string, outcome: SelectionOutcome<T>, nameOf: (item: T) => string) => void;
}

// Shared by every Reporter, so a test double surfaces a selection's outcome as production does.
export function reportSelectionOutcome<T>(
  report: Reporter['report'], message: string, outcome: SelectionOutcome<T>, nameOf: (item: T) => string,
): void {
  if (outcome.refused.length === 0) return;
  report('error', message, outcome.refused.map((r) => `"${nameOf(r.item)}" (${r.reason})`).join(', '));
}
