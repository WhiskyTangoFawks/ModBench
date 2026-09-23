// A view's first-render gate over the Instance (ADR-0015): the Instance itself reports nothing,
// so a view wanting the first failure surfaced once, through its own reporter, wraps it here.

import type * as vscode from 'vscode';
import type { Reporter } from '../ports/reporter';
import type { Instance } from '../instanceLoader/instance';

/** A tree's first-render gate: `settled` resolves on the first landed value or the first failed
 *  read — never "nothing here" before a read (ADR-0002), never an endless spinner (ADR-0019).
 *  `failure` holds until a value lands. */
export interface FirstRead extends vscode.Disposable {
  readonly settled: Promise<void>;
  readonly failure: string | undefined;
}

/** The reporter hears the first failed read once; a later failure before any value has landed
 *  is the Instance's log line, nothing more, so a retrying watcher cannot toast per attempt. */
export function firstReadOf(
  instance: Pick<Instance, 'sequence' | 'readFailure' | 'subscribe' | 'onReadFailure'>,
  reporter: Reporter | undefined,
): FirstRead {
  const unread = () => instance.sequence === 0;
  let reported = false;
  const report = (reason: string) => {
    if (reported) return;
    reported = true;
    reporter?.report('error', 'Failed to read the MO2 instance.', reason);
  };
  let resolve = () => {};
  const settled = unread() ? new Promise<void>((r) => { resolve = r; }) : Promise.resolve();
  // Constructed after the first read already failed: the failure is held, not just fired.
  if (unread() && instance.readFailure !== undefined) {
    report(instance.readFailure);
    resolve();
  }
  const subscriptions = [
    instance.subscribe(() => resolve()),
    instance.onReadFailure((reason) => {
      if (!unread()) return;
      report(reason);
      resolve();
    }),
  ];
  return {
    settled,
    get failure() { return unread() ? instance.readFailure : undefined; },
    dispose: () => { for (const subscription of subscriptions) subscription.dispose(); },
  };
}
