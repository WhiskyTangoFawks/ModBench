import * as vscode from 'vscode';
import type { Instance } from '../instanceLoader/instance';

/** Every view's progress bar while the instance may be late (ADR-0015). */
export function showProgressWhileLate(instance: Pick<Instance, 'mayBeLate' | 'onMayBeLate'>, viewIds: readonly string[]): vscode.Disposable {
  let stop: (() => void) | undefined;
  const follow = (): void => {
    if (instance.mayBeLate === (stop !== undefined)) return;
    if (stop !== undefined) {
      stop();
      stop = undefined;
      return;
    }
    const until = new Promise<void>((resolve) => { stop = resolve; });
    for (const viewId of viewIds) void vscode.window.withProgress({ location: { viewId } }, () => until);
  };
  follow();
  const subscription = instance.onMayBeLate(follow);
  return { dispose: () => { subscription.dispose(); stop?.(); } };
}
