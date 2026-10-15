import type * as vscode from 'vscode';

const WALKTHROUGH = 'whiskytangofawks.modbench#gettingStarted';
const OPENED_KEY = 'modbench.walkthroughOpened';

export async function openWalkthroughOnce(
  globalState: { get(key: string): unknown; update: vscode.Memento['update'] },
  open: (walkthrough: string) => Thenable<unknown>,
): Promise<void> {
  if (globalState.get(OPENED_KEY) === true) return;
  await globalState.update(OPENED_KEY, true);
  await open(WALKTHROUGH);
}
