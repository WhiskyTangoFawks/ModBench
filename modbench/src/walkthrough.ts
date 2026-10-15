import type * as vscode from 'vscode';

export const WALKTHROUGH_ID = 'gettingStarted';
const OPENED_KEY = 'modbench.walkthroughOpened';

export async function openWalkthroughOnce(
  globalState: Pick<vscode.Memento, 'update'> & { get(key: string): unknown },
  extensionId: string,
  open: (walkthrough: string) => Thenable<unknown>,
): Promise<void> {
  if (globalState.get(OPENED_KEY) === true) return;
  await globalState.update(OPENED_KEY, true);
  await open(`${extensionId}#${WALKTHROUGH_ID}`);
}
