import * as vscode from 'vscode';
import type { Instance } from '../instanceLoader/instance';

export type RecordWrite = (command: () => Promise<void>) => Promise<void>;

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
