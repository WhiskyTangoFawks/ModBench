// A view's first-render gate over the Instance (ADR-0015). The failed read's one Output line is
// the Instance's own, so a view renders the error row and raises nothing (ADR-0019).

import type * as vscode from 'vscode';
import type { Instance } from '../instanceLoader/instance';

/** A tree's first-render gate: `settled` resolves on the first landed value or the first failed
 *  read — never "nothing here" before a read (ADR-0002), never an endless spinner (ADR-0019).
 *  `failure` holds until a value lands. */
export interface FirstRead extends vscode.Disposable {
  readonly settled: Promise<void>;
  readonly failure: string | undefined;
}

export function firstReadOf(
  instance: Pick<Instance, 'sequence' | 'readFailure' | 'subscribe' | 'onReadFailure'>,
): FirstRead {
  const unread = () => instance.sequence === 0;
  let resolve = () => {};
  const settled = unread() ? new Promise<void>((r) => { resolve = r; }) : Promise.resolve();
  // Constructed after the first read already failed: the failure is held, not just fired.
  if (unread() && instance.readFailure !== undefined) resolve();
  const subscriptions = [
    instance.subscribe(() => resolve()),
    instance.onReadFailure(() => resolve()),
  ];
  return {
    settled,
    get failure() { return unread() ? instance.readFailure : undefined; },
    dispose: () => { for (const subscription of subscriptions) subscription.dispose(); },
  };
}
