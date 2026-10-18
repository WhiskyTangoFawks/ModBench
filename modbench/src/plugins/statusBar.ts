import * as vscode from 'vscode';
import type { BackendStatus, MEditClient } from '../client';
import type { Reporter } from '../ports/reporter';
import { errorMessage } from '../ports/errorMessage';

const STATUS_TEXT: Record<BackendStatus, string> = {
  starting:     '$(loading~spin) mEdit: Starting…',
  running:      '$(plug) mEdit: Running',
  disconnected: '$(error) mEdit: Disconnected',
  stopped:      '$(circle-slash) mEdit: Stopped',
};

const STOPPED = 'mEdit stopped. Reload the window to start it again.';

// common.md, The status bar. No command: a click does nothing (story 2).
export interface StatusBar extends vscode.Disposable {
  ready(activePlugins: number): void;
  /** While the snapshot is not indexed. */
  showMEditState(): void;
}

export function createStatusBar(
  client: Pick<MEditClient, 'status' | 'onStatusChanged' | 'onLaunch' | 'onExit'>,
  reporterFor: (tag: string) => Reporter,
): StatusBar {
  const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  const showStatus = () => { item.text = STATUS_TEXT[client.status]; };
  showStatus();
  item.show();
  const reportStopped = (tag: string, detail?: string): void => { reporterFor(tag).report('error', STOPPED, detail); };
  const unsubscribes = [
    client.onStatusChanged(showStatus),
    client.onExit(() => { reportStopped('mEditExit'); }),
    client.onLaunch((launched) => {
      void launched.then((outcome) => {
        if (outcome.outcome !== 'failed') return;
        if (outcome.error === undefined) reportStopped('enterEditing');
        else reportStopped('launch', outcome.error);
      }).catch((e: unknown) => { reporterFor('launch').report('error', STOPPED, errorMessage(e)); });
    }),
  ];
  return {
    ready: (activePlugins) => { item.text = `$(check) mEdit: Ready (${activePlugins} plugins)`; },
    showMEditState: showStatus,
    dispose: () => { for (const unsubscribe of unsubscribes) unsubscribe(); item.dispose(); },
  };
}
