import * as vscode from 'vscode';
import type { Instance } from '../instanceLoader/instance';

/** A record create, copy or delete as a writing gesture, under the bar of the view it was invoked
 *  from; the Plugins view's when the gesture came from a record tab, which has no bar of its own. */
export type RecordWrite = (command: () => Promise<void>, invokedFrom?: string) => Promise<void>;

export async function runWritingGesture<T>(
  viewId: string, instance: Pick<Instance, 'refresh'>, command: () => Promise<T>,
): Promise<T> {
  return vscode.window.withProgress({ location: { viewId } }, async () => {
    try {
      return await command();
    } finally {
      await instance.refresh();
    }
  });
}
