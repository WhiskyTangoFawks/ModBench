import type { SelectionOutcome } from './selectionOutcome';

/** ADR-0019 invariant 2's severity tiers, as the one type every caller names. */
export type Severity = 'error' | 'warning';

/** ADR-0019 invariant 3 surfacing: injected so business logic stays free of vscode types. The
 *  composition root implements it over the window API. */
export interface Reporter {
  // Arrow-typed properties, not methods, so a test holds a bare reference to one
  // (`vi.mocked(reporter.report)`) without an unbound-method warning.
  /** What failed, and `detail` for why: the notification and the Output line both carry it. */
  report: (severity: Severity, message: string, detail?: string) => void;
  /** A gesture the user invoked landed: ADR-0019's success tier, an information toast and no log
   *  line. Nothing went wrong, so there is no detail to go back and read. */
  landed: (message: string) => void;
  /** A failure inside a dialog the user is answering: an Output line, what and why, and no
   *  notification, because the dialog already says it. */
  insideDialog: (severity: Severity, message: string, detail?: string) => void;
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
