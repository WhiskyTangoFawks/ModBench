import * as vscode from 'vscode';
import { reconciling, type MEditClient } from '../client';
import { mEditState } from './mEditState';
import type { Reporter } from '../ports/reporter';

const STOPPED = 'mEdit stopped. Reload the window to start it again.';

// common.md, The status bar. No command: a click does nothing (story 2).
export interface StatusBar extends vscode.Disposable {
  ready(activePlugins: number): void;
  /** While the snapshot is not indexed. */
  showMEditState(): void;
  /** The words the item shows, without its icon, unless it says Ready. */
  standing(): string | undefined;
}

export function createStatusBar(
  client: Pick<MEditClient, 'status' | 'onStatusChanged' | 'onLaunch' | 'onExit' | 'recordIndexProgress' | 'onDidChangeRecordIndexProgress'>,
  reporterFor: (tag: string) => Reporter,
): StatusBar {
  const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  let indexedActivePlugins: number | undefined;
  const indexing = () => {
    const progress = client.recordIndexProgress;
    return reconciling(progress) ? progress : undefined;
  };
  const shown = () => mEditState(client.status, indexing(), indexedActivePlugins);
  const show = () => {
    const { icon, state } = shown();
    item.text = `$(${icon}) mEdit: ${state}`;
  };
  const showStatus = () => { indexedActivePlugins = undefined; show(); };
  showStatus();
  item.show();
  const reportStopped = (tag: string, detail?: string): void => { reporterFor(tag).report('error', STOPPED, detail); };
  const progressSubscription = client.onDidChangeRecordIndexProgress(show);
  const unsubscribes = [
    () => { progressSubscription.dispose(); },
    client.onStatusChanged(showStatus),
    client.onExit(() => { reportStopped('mEditExit'); }),
    client.onLaunch((launched) => {
      void launched.then((outcome) => {
        if (outcome.outcome !== 'failed') return;
        if (outcome.error === undefined) reportStopped('enterEditing');
        else reportStopped('launch', outcome.error);
      });
    }),
  ];
  return {
    ready: (activePlugins) => { indexedActivePlugins = activePlugins; show(); },
    showMEditState: showStatus,
    standing: () => indexedActivePlugins === undefined || indexing() !== undefined ? `mEdit is ${shown().state}` : undefined,
    dispose: () => { for (const unsubscribe of unsubscribes) unsubscribe(); item.dispose(); },
  };
}
