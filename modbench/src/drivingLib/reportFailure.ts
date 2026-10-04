import type { Reporter } from '../ports/reporter';
import { errorMessage } from '../ports/errorMessage';

/** Runs a gesture's action, and reports its failure as the gesture's (ADR-0019). */
export async function reportFailure(reporter: Reporter, failMessage: string, action: () => Promise<void>): Promise<void> {
  try {
    await action();
  } catch (err) {
    reporter.report('error', failMessage, errorMessage(err));
  }
}
