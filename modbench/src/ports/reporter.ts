/** ADR-0019 invariant 2's severity tiers, as the one type every caller names. */
export type Severity = 'error' | 'warning';

/** ADR-0019 invariant 3 surfacing: injected so business logic stays free of vscode types. The
 *  composition root implements it over the window API. */
export interface Reporter {
  // Arrow-typed properties, not methods: neither ever needs its own `this`, and this shape lets
  // a test hold a bare reference to one (`vi.mocked(reporter.report)`) without an
  // unbound-method warning.
  report: (severity: Severity, message: string, detail?: string) => void;
  /** A gesture the user invoked landed: ADR-0019's success tier, an information toast and no log
   *  line. Nothing went wrong, so there is no detail to go back and read. */
  landed: (message: string) => void;
}
