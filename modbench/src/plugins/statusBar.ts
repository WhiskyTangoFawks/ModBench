import * as vscode from 'vscode';
import type { BackendStatus, MEditClient } from '../client';

const STATUS_TEXT: Record<BackendStatus, string> = {
  starting:     '$(loading~spin) mEdit: Starting…',
  running:      '$(plug) mEdit: Running',
  disconnected: '$(error) mEdit: Disconnected',
  stopped:      '$(circle-slash) mEdit: Stopped',
};

// common.md, The status bar. No command: a click does nothing (story 2).
export interface StatusBar extends vscode.Disposable {
  ready(activePlugins: number): void;
  /** mEdit's own state again, once the snapshot is not indexed. */
  notReady(): void;
}

export function createStatusBar(client: Pick<MEditClient, 'status' | 'onStatusChanged'>): StatusBar {
  const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  const showStatus = () => { item.text = STATUS_TEXT[client.status]; };
  showStatus();
  item.show();
  const unsubscribe = client.onStatusChanged(showStatus);
  return {
    ready: (activePlugins) => { item.text = `$(check) mEdit: Ready (${activePlugins} plugins)`; },
    notReady: showStatus,
    dispose: () => { unsubscribe(); item.dispose(); },
  };
}
