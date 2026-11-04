import * as vscode from 'vscode';
import type { Instance } from '../instanceLoader/instance';

/** Every view's progress bar, from the first change the instance hears until a check of the disk confirms it (ADR-0015). */
export function showProgressWhileLate(instance: Pick<Instance, 'mayBeLate' | 'onMayBeLate'>, viewIds: readonly string[]): vscode.Disposable {
  let confirmed: (() => void) | undefined;
  const follow = (): void => {
    if (instance.mayBeLate === (confirmed !== undefined)) return;
    if (confirmed !== undefined) {
      confirmed();
      confirmed = undefined;
      return;
    }
    const until = new Promise<void>((resolve) => { confirmed = resolve; });
    for (const viewId of viewIds) void vscode.window.withProgress({ location: { viewId } }, () => until);
  };
  follow();
  const subscription = instance.onMayBeLate(follow);
  return { dispose: () => { subscription.dispose(); confirmed?.(); } };
}
