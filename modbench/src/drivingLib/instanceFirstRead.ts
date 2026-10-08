import * as vscode from 'vscode';
import type { Instance } from '../instanceLoader/instance';

/** Unset until the Instance's first value lands, so an empty view before the read says nothing. */
const INSTANCE_READ_KEY = 'modbench.instanceRead';

/** A tree's first-render gate: `settled` resolves on the first landed value or the first failed
 *  read (common.md, States, stories 1 and 2). `failure` holds until a value lands. */
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

/** A failed read lands no value, so the key waits for the first read that does. */
export function markFirstReadLanded(instance: Pick<Instance, 'subscribe'>): vscode.Disposable {
  const subscription = instance.subscribe(() => {
    subscription.dispose();
    void vscode.commands.executeCommand('setContext', INSTANCE_READ_KEY, true);
  });
  return subscription;
}
