import type * as vscode from 'vscode';
import type { Instance } from '../instanceLoader/instance';
import type { Reporter } from '../ports/reporter';
import { toastOncePerFailure } from './toastOncePerFailure';

const STALE_VIEW = {
  value: 'A view did not take the instance\'s latest value, so it may be out of date',
  'read-failure': 'A view did not take word of the instance\'s failed read, so it may be out of date',
} as const;

export function reportSubscriberThrows(
  instance: Pick<Instance, 'onListenerOutcome'>,
  reporterFor: (tag: string) => Reporter,
): vscode.Disposable {
  const throws = toastOncePerFailure(reporterFor('instance'));
  return instance.onListenerOutcome(({ listener, during, threw }) => {
    if (threw === undefined) throws.recovered(listener);
    else throws.threw(listener, STALE_VIEW[during], threw);
  });
}
