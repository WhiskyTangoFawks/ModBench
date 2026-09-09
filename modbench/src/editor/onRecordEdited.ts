import type * as vscode from 'vscode';
import type { RecordDecorationProvider } from './RecordDecorationProvider';
import { recordResourceUri } from '../medit/recordResourceUri';
import type { ExtensionToWebview } from '../medit/messages';
import type { WorkingTreeState } from '../medit/ApiClient';

/** Editor's own view of whatever tree needs to hear about a landed edit — a structural shape,
 *  not `PluginTreeProvider` itself: Editor names no Plugins-view type, and the real tree
 *  satisfies this unchanged. */
export interface RecordTreeSync {
  refresh(): void;
  workingTreeStateOf(plugin: string, origin: string | undefined, formKey: string): WorkingTreeState | undefined;
  markWorkingTreeState(plugin: string, origin: string | undefined, formKey: string, state: WorkingTreeState): boolean;
}

/** Broadcasts one message to every open record panel (`'modbench'` viewType). */
export function broadcastToRecordPanels(recordPanels: Set<vscode.WebviewPanel>, msg: ExtensionToWebview): void {
  for (const panel of recordPanels) void panel.webview.postMessage(msg);
}

/** Scoped, not `refresh()`: patches the cached record and refreshes only its decoration.
 *  Hardcodes `'Modified'` — the edit response carries no resulting state, so an edit that
 *  converges back to the committed bytes shows a stale M until an unrelated refresh. */
export function makeOnRecordEdited(
  treeSync: RecordTreeSync,
  recordDecorationProvider: RecordDecorationProvider,
  refreshMatchingPlugins: () => void,
  refreshSourceControl: (plugin: string) => void,
): (formKey: string, plugin: string, origin: string) => void {
  return (formKey, plugin, origin) => {
    if (treeSync.markWorkingTreeState(plugin, origin, formKey, 'Modified')) {
      recordDecorationProvider.refresh(recordResourceUri(plugin, origin, formKey));
    }
    refreshMatchingPlugins();
    refreshSourceControl(plugin);
  };
}
