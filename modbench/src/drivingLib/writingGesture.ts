import * as vscode from 'vscode';
import type { Instance } from '../instanceLoader/instance';

/** The view's progress bar from the click until the Instance loader's next read lands. */
export async function runWritingGesture(
  viewId: string, instance: Pick<Instance, 'refresh'>, command: () => Promise<void>,
): Promise<void> {
  await vscode.window.withProgress({ location: { viewId } }, async () => {
    try {
      await command();
    } finally {
      await instance.refresh();
    }
  });
}
