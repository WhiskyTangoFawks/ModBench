import type * as vscode from 'vscode';
import type { PluginTreeProvider } from './PluginTreeProvider';
import type { RecordDecorationProvider } from './RecordDecorationProvider';
import { recordResourceUri } from './recordResourceUri';
import type { ExtensionToWebview } from './messages';

/** Broadcasts one message to every open record panel (`'modbench'` viewType). */
export function broadcastToRecordPanels(recordPanels: Set<vscode.WebviewPanel>, msg: ExtensionToWebview): void {
  for (const panel of recordPanels) void panel.webview.postMessage(msg);
}

/** Scoped, not `refresh()`: patches the cached record and refreshes only its decoration.
 *  Hardcodes `'Modified'` — the edit response carries no resulting state, so an edit that
 *  converges back to the committed bytes shows a stale M until an unrelated refresh. */
export function makeOnRecordEdited(
  treeProvider: PluginTreeProvider,
  recordDecorationProvider: RecordDecorationProvider,
  refreshMatchingPlugins: () => void,
  refreshSourceControl: (plugin: string) => void,
): (formKey: string, plugin: string, origin: string) => void {
  return (formKey, plugin, origin) => {
    if (treeProvider.markWorkingTreeState(plugin, origin, formKey, 'Modified')) {
      recordDecorationProvider.refresh(recordResourceUri(plugin, origin, formKey));
    }
    refreshMatchingPlugins();
    refreshSourceControl(plugin);
  };
}
